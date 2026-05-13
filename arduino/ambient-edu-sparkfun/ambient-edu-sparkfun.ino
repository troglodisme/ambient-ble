/**
 * Ambient Edu — SparkFun ESP32-C6 Thing Plus
 *
 * Hardware: SparkFun ESP32-C6 Thing Plus
 *   - NeoPixel  GPIO 23
 *   - I2C SDA   GPIO 6 / SCL GPIO 7
 *   - MAX17048 fuel gauge on I2C (built in)
 *   - SEN66 air quality sensor on I2C (connector)
 *
 * BLE Service UUID: 12340001-1234-1234-1234-123456789abc
 *
 *   Characteristic  UUID suffix  Format    Data
 *   ─────────────── ──────────── ───────── ──────────────────────────────
 *   Particles       ...0010      4×f32     PM1, PM2.5, PM4, PM10 µg/m³
 *   Gases           ...0011      u16+2×f32 CO2 ppm, VOC index, NOx index
 *   Environment     ...0012      2×f32     Temp °C, Humidity %
 *   Battery         ...0013      3×f32     SoC %, Voltage V, ChargeRate %/hr
 *   HistoryCount    ...0020      u32       Total stored records
 *   HistoryData     ...0021      38 B      Write start idx; stream records
 *   SetTime         ...0030      u32       Write: Unix epoch sec → board computes boot offset. Read: boot epoch (0 = unset)
 *
 *   All values little-endian. Live chars notify at 1 Hz.
 *   History record (38 bytes): u32 ts | f32×4 PM | u16 CO2 | f32 VOC | f32 NOx | f32 temp | f32 humi
 *   History stream ends with a single 0xFF byte.
 *   Write 0xFFFFFFFF to HistoryData to erase all history.
 *
 * Libraries required (Library Manager):
 *   ArduinoBLE, Adafruit NeoPixel, Sensirion I2C SEN66, Adafruit MAX1704X
 *
 * ESP32 board package: v3.2.0 only (BLE broken in 3.3.0+)
 */

// ═══════════════════════════════════════════════════════════════
// ██  DEVICE ID — give each board a unique number (1–99)  ██████
// ═══════════════════════════════════════════════════════════════
#define DEVICE_ID  1
// ═══════════════════════════════════════════════════════════════

// ── Pin mapping ──────────────────────────────────────────────
#define NEOPIXEL_PIN  23
#define I2C_SDA        6
#define I2C_SCL        7

// ── Config ───────────────────────────────────────────────────
#define NUM_PIXELS       1
#define LED_BRIGHTNESS  20  // 0–255; kept low to save power (NeoPixel can draw ~60 mA at full white)
#define SENSOR_RETRY_MS 5000   // ms between sensor re-init attempts
#define LOG_INTERVAL_S  60     // seconds between history writes
#define MAX_RECORDS     1440   // ring buffer size (1440 × 60 s = 24 h)
#define HISTORY_FILE    "/history.bin"
#define META_FILE       "/history_meta.bin"
#define TIME_FILE       "/time_offset.bin"

// ─────────────────────────────────────────────────────────────
#include <Arduino.h>
#include <Wire.h>
#include <Adafruit_NeoPixel.h>
#include <Adafruit_MAX1704X.h>
#include <SensirionI2cSen66.h>
#include <ArduinoBLE.h>
#include <LittleFS.h>

#ifdef NO_ERROR
#undef NO_ERROR
#endif
#define NO_ERROR 0

// ── History record (38 bytes) ─────────────────────────────────
struct __attribute__((packed)) HistoryRecord {
  uint32_t ts;               // seconds since board boot
  float    pm1, pm25, pm4, pm10;
  uint16_t co2;
  float    voc, nox;
  float    temperature, humidity;
};
static_assert(sizeof(HistoryRecord) == 38, "HistoryRecord size mismatch");

struct __attribute__((packed)) HistoryMeta {
  uint32_t count;            // valid records (0–MAX_RECORDS)
  uint32_t head;             // next write slot (0–MAX_RECORDS-1)
};

// ── BLE ──────────────────────────────────────────────────────
BLEService sensorService("12340001-1234-1234-1234-123456789abc");

BLECharacteristic charParticles("12340010-1234-1234-1234-123456789abc", BLERead | BLENotify, 16);
BLECharacteristic charGases    ("12340011-1234-1234-1234-123456789abc", BLERead | BLENotify, 10);
BLECharacteristic charEnv      ("12340012-1234-1234-1234-123456789abc", BLERead | BLENotify,  8);
BLECharacteristic charBattery  ("12340013-1234-1234-1234-123456789abc", BLERead | BLENotify, 12);
BLECharacteristic charHistCount("12340020-1234-1234-1234-123456789abc", BLERead, 4);
BLECharacteristic charHistData ("12340021-1234-1234-1234-123456789abc", BLEWrite | BLENotify, 38);
BLECharacteristic charSetTime  ("12340030-1234-1234-1234-123456789abc", BLERead | BLEWrite,   4);

// ── Globals ──────────────────────────────────────────────────
Adafruit_NeoPixel  pixel(NUM_PIXELS, NEOPIXEL_PIN, NEO_GRB + NEO_KHZ800);
SensirionI2cSen66  sensor;
Adafruit_MAX17048  battGauge;

static char     errorMessage[64];
static int16_t  sensorError;
static bool     sensorReady      = false;
static bool     battReady        = false;
static uint32_t lastSensorRetry  = 0;
static uint32_t lastLogTime      = 0;
static uint32_t timeOffset       = 0;   // Unix seconds at board boot (0 = not yet synced)

// ── I2C helper ───────────────────────────────────────────────
// Re-initialise the entire I2C bus and all devices on it.
// Called on first boot and whenever the SEN66 needs a reset.
void initI2C() {
  Wire.end();
  delay(10);
  Wire.begin(I2C_SDA, I2C_SCL);

  // Re-init battery gauge every time the bus resets
  battReady = battGauge.begin();
  if (!battReady) {
    Serial.println("MAX17048 not found on I2C bus.");
  } else {
    Serial.printf("Battery: %.0f%%  %.2fV  %.1f%%/hr\n",
      battGauge.cellPercent(), battGauge.cellVoltage(), battGauge.chargeRate());
  }
}

// ── Sensor init ──────────────────────────────────────────────
bool initSensor() {
  initI2C();  // resets bus + re-inits battery gauge

  sensor.begin(Wire, SEN66_I2C_ADDR_6B);
  sensorError = sensor.deviceReset();
  if (sensorError != NO_ERROR) {
    errorToString(sensorError, errorMessage, sizeof errorMessage);
    Serial.printf("SEN66 not found: %s\n", errorMessage);
    return false;
  }
  delay(1200);

  sensorError = sensor.startContinuousMeasurement();
  if (sensorError != NO_ERROR) {
    errorToString(sensorError, errorMessage, sizeof errorMessage);
    Serial.printf("SEN66 start failed: %s\n", errorMessage);
    return false;
  }

  int8_t sn[32] = {0};
  sensor.getSerialNumber(sn, 32);
  Serial.printf("SEN66 ready — serial: %s\n", (const char*)sn);
  return true;
}

// ── History helpers ──────────────────────────────────────────
HistoryMeta readMeta() {
  HistoryMeta m = {0, 0};
  File f = LittleFS.open(META_FILE, "r");
  if (f && f.size() == sizeof(m)) f.read((uint8_t*)&m, sizeof(m));
  if (f) f.close();
  return m;
}

void writeMeta(const HistoryMeta& m) {
  File f = LittleFS.open(META_FILE, "w");
  if (f) { f.write((const uint8_t*)&m, sizeof(m)); f.close(); }
}

void appendRecord(const HistoryRecord& rec) {
  HistoryMeta m = readMeta();
  File f = LittleFS.open(HISTORY_FILE, m.count == 0 ? "w" : "r+");
  if (!f) { Serial.println("History: open failed"); return; }
  f.seek(m.head * sizeof(HistoryRecord));
  f.write((const uint8_t*)&rec, sizeof(rec));
  f.close();
  m.head = (m.head + 1) % MAX_RECORDS;
  if (m.count < MAX_RECORDS) m.count++;
  writeMeta(m);
  uint32_t cnt = m.count;
  charHistCount.writeValue((uint8_t*)&cnt, 4);
}

bool readRecord(uint32_t index, HistoryRecord& out) {
  HistoryMeta m = readMeta();
  if (index >= m.count) return false;
  uint32_t slot = (m.head + MAX_RECORDS - m.count + index) % MAX_RECORDS;
  File f = LittleFS.open(HISTORY_FILE, "r");
  if (!f) return false;
  f.seek(slot * sizeof(HistoryRecord));
  bool ok = f.read((uint8_t*)&out, sizeof(out)) == sizeof(out);
  f.close();
  return ok;
}

void clearHistory() {
  LittleFS.remove(HISTORY_FILE);
  LittleFS.remove(META_FILE);
  uint32_t zero = 0;
  charHistCount.writeValue((uint8_t*)&zero, 4);
  Serial.println("History cleared.");
}

// ── Time sync ─────────────────────────────────────────────────
void saveTimeOffset() {
  File f = LittleFS.open(TIME_FILE, "w");
  if (f) { f.write((uint8_t*)&timeOffset, 4); f.close(); }
}

void loadTimeOffset() {
  File f = LittleFS.open(TIME_FILE, "r");
  if (f && f.size() == 4) { f.read((uint8_t*)&timeOffset, 4); f.close(); }
  Serial.printf("Time sync: %s\n", timeOffset > 0 ? "offset loaded" : "not set (white blink)");
}

void streamHistory(uint32_t startIndex) {
  HistoryMeta m = readMeta();
  Serial.printf("History: streaming from %u, total %u\n", startIndex, m.count);
  for (uint32_t i = startIndex; i < m.count; i++) {
    HistoryRecord rec;
    if (!readRecord(i, rec)) break;
    charHistData.writeValue((uint8_t*)&rec, sizeof(rec));
    BLE.poll();
    delay(20);
  }
  uint8_t done = 0xFF;
  charHistData.writeValue(&done, 1);
  Serial.println("History: stream complete.");
}

// ── LED helpers ──────────────────────────────────────────────

// Boot flash: 5 quick white flashes to confirm power-on and firmware start.
void flashWhite() {
  for (int i = 0; i < 5; i++) {
    pixel.setBrightness(LED_BRIGHTNESS);
    pixel.setPixelColor(0, pixel.Color(200, 200, 200)); pixel.show(); delay(120);
    pixel.clear(); pixel.show(); delay(120);
  }
}

// LED state machine — call every loop iteration when sensor is running.
//
//   State                   Colour          Pattern
//   ─────────────────────── ─────────────── ──────────────────────────────
//   Connected               White           Bright solid (all good, in use)
//   Advertising, time set   White           Slow breathing (idle, healthy)
//   Advertising, no time    Amber           Slow breathing (needs time sync)
//   Sensor error            Red             Fast blink
//
// "Breathing" = smooth sine-wave fade using millis(). Period ~4 s.
// White means nominal; amber means attention needed; red means error.
void updateLed() {
  if (BLE.connected()) {
    // Bright solid white — device is connected and streaming data.
    pixel.setBrightness(LED_BRIGHTNESS);
    pixel.setPixelColor(0, pixel.Color(200, 200, 200));
  } else {
    // Breathing: sine wave over a 4-second period, mapped to 10–200 brightness.
    float phase = (millis() % 4000) / 4000.0f;          // 0.0 → 1.0
    float sine  = (sinf(phase * 2.0f * PI) + 1.0f) / 2.0f; // 0.0 → 1.0
    uint8_t bri = (uint8_t)(5 + sine * 15);              // 5–20 range (low power)

    pixel.setBrightness(bri);

    if (timeOffset > 0) {
      // White breathing — advertising normally, time already synced.
      pixel.setPixelColor(0, pixel.Color(200, 200, 200));
    } else {
      // Amber breathing — advertising but time has never been synced.
      // Open the Ambient BLE app and connect once to fix this.
      pixel.setPixelColor(0, pixel.Color(200, 80, 0));
    }
  }
  pixel.show();
}

// ═════════════════════════════════════════════════════════════
void setup() {
  Serial.begin(115200);
  delay(500);

  char bleName[20];
  snprintf(bleName, sizeof(bleName), "Ambient Edu %02d", DEVICE_ID);
  Serial.printf("\n=== Ambient Edu BLE — SparkFun ESP32-C6 ===\nDevice: %s\n", bleName);

  pixel.begin(); pixel.setBrightness(LED_BRIGHTNESS); pixel.clear(); pixel.show();
  flashWhite();  // 5 white flashes = firmware started OK

  // ── LittleFS ─────────────────────────────────────────────
  if (!LittleFS.begin(true)) {
    Serial.println("LittleFS mount failed!");
  } else {
    HistoryMeta m = readMeta();
    Serial.printf("History: %u records stored\n", m.count);
  }
  loadTimeOffset();

  // ── Sensor + Battery (shared I2C bus) ─────────────────────
  sensorReady = initSensor();
  if (!sensorReady) Serial.println("No sensor — will retry every 5 s.");

  // ── BLE ──────────────────────────────────────────────────
  if (!BLE.begin()) { Serial.println("BLE init failed!"); while (1); }
  BLE.setConnectionInterval(6, 12); // 7.5–15 ms intervals for faster notifications

  BLE.setLocalName(bleName);
  BLE.setDeviceName(bleName);
  BLE.setAdvertisedService(sensorService);

  sensorService.addCharacteristic(charParticles);
  sensorService.addCharacteristic(charGases);
  sensorService.addCharacteristic(charEnv);
  sensorService.addCharacteristic(charBattery);
  sensorService.addCharacteristic(charHistCount);
  sensorService.addCharacteristic(charHistData);
  sensorService.addCharacteristic(charSetTime);

  BLE.addService(sensorService);

  { HistoryMeta m = readMeta(); charHistCount.writeValue((uint8_t*)&m.count, 4); }
  charSetTime.writeValue((uint8_t*)&timeOffset, 4);

  BLE.advertise();
  Serial.printf("BLE advertising as \"%s\"\n\n", bleName);
  updateLed();
}

// ═════════════════════════════════════════════════════════════
void loop() {
  BLE.poll();

  // ── Sensor retry ─────────────────────────────────────────
  if (!sensorReady) {
    // Red fast blink = sensor error / waiting for SEN66 to initialise.
    { bool on = (millis() / 250) % 2 == 0;
      pixel.setBrightness(LED_BRIGHTNESS);
      pixel.setPixelColor(0, on ? pixel.Color(200, 0, 0) : 0);
      pixel.show(); }
    if (millis() - lastSensorRetry >= SENSOR_RETRY_MS) {
      lastSensorRetry = millis();
      sensorReady = initSensor();
      if (sensorReady) updateLed();
    }
    delay(500);
    return;
  }

  // ── History download requests ─────────────────────────────
  if (charHistData.written()) {
    uint8_t buf[4];
    if (charHistData.readValue(buf, 4) == 4) {
      uint32_t cmd;
      memcpy(&cmd, buf, 4);
      if (cmd == 0xFFFFFFFF) clearHistory();
      else                   streamHistory(cmd);
    }
  }

  if (charSetTime.written()) {
    uint8_t buf[4]; charSetTime.readValue(buf, 4);
    uint32_t unix_ts; memcpy(&unix_ts, buf, 4);
    if (unix_ts > 1000000000UL) {
      timeOffset = unix_ts - millis() / 1000;
      saveTimeOffset();
      charSetTime.writeValue((uint8_t*)&timeOffset, 4);
      Serial.printf("Time synced: boot epoch=%u\n", timeOffset);
    }
  }

  // ── Read sensor ──────────────────────────────────────────
  float pm1p0 = 0, pm2p5 = 0, pm4p0 = 0, pm10p0 = 0;
  float humidity = 0, temperature = 0;
  float vocIndex = 0, noxIndex = 0;
  uint16_t co2 = 0;

  delay(1000);

  sensorError = sensor.readMeasuredValues(
      pm1p0, pm2p5, pm4p0, pm10p0,
      humidity, temperature, vocIndex, noxIndex, co2);

  if (sensorError != NO_ERROR) {
    errorToString(sensorError, errorMessage, sizeof errorMessage);
    Serial.printf("Read error: %s\n", errorMessage);
    sensorReady = false;
    lastSensorRetry = millis();
    return;
  }

  if (co2 == 65535 || pm2p5 > 1000.0f) {
    Serial.println("  (sensor warming up…)");
    return;
  }

  // ── BLE notify ───────────────────────────────────────────
  {
    uint8_t buf[16];
    memcpy(buf + 0,  &pm1p0,  4); memcpy(buf + 4,  &pm2p5,  4);
    memcpy(buf + 8,  &pm4p0,  4); memcpy(buf + 12, &pm10p0, 4);
    charParticles.writeValue(buf, 16);
  }
  {
    uint8_t buf[10];
    memcpy(buf + 0, &co2,      2);
    memcpy(buf + 2, &vocIndex, 4);
    memcpy(buf + 6, &noxIndex, 4);
    charGases.writeValue(buf, 10);
  }
  {
    uint8_t buf[8];
    memcpy(buf + 0, &temperature, 4);
    memcpy(buf + 4, &humidity,    4);
    charEnv.writeValue(buf, 8);
  }
  if (battReady) {
    float soc   = min(battGauge.cellPercent(), 100.0f);
    float volts = battGauge.cellVoltage();
    float rate  = battGauge.chargeRate();
    uint8_t buf[12];
    memcpy(buf + 0, &soc,   4);
    memcpy(buf + 4, &volts, 4);
    memcpy(buf + 8, &rate,  4);
    charBattery.writeValue(buf, 12);
    Serial.printf("  Batt:  %.0f%%  %.2fV\n", soc, volts);
  }

  // ── History log ──────────────────────────────────────────
  uint32_t now = millis();
  if (now - lastLogTime >= (uint32_t)LOG_INTERVAL_S * 1000) {
    lastLogTime = now;
    // ts: real Unix seconds if time is synced, else seconds since boot
    HistoryRecord rec = {
      timeOffset > 0 ? timeOffset + now / 1000 : now / 1000,
      pm1p0, pm2p5, pm4p0, pm10p0,
      co2, vocIndex, noxIndex,
      temperature, humidity
    };
    appendRecord(rec);
  }

  // ── Serial ───────────────────────────────────────────────
  Serial.println("────────────────────────────────────");
  Serial.printf("  PM2.5: %.1f µg/m³   CO2: %u ppm\n", pm2p5, co2);
  Serial.printf("  Temp:  %.1f °C      RH:  %.1f %%\n", temperature, humidity);
  if (BLE.connected()) Serial.println("  [BLE client connected]");
  updateLed();
}
