/**
 * Ambient Edu — BLE Broadcast + History
 *
 * Reads the SEN66 sensor and broadcasts every measurement over
 * Bluetooth Low Energy (BLE) using the ArduinoBLE library.
 * Any BLE scanner app — such as nRF Connect or LightBlue — can
 * see the values immediately, no custom app required.
 *
 * DEVICE ID
 * ─────────
 * Change DEVICE_ID below (1–99) so each student's board gets a
 * unique BLE name: "Ambient Edu 01", "Ambient Edu 02", etc.
 * The onboard LED also flashes a unique colour on startup so you
 * can tell boards apart without a phone.
 *
 * HOW IT WORKS
 * ────────────
 * The board advertises with a single BLE Service containing three
 * live characteristics (particles, gases, environment) plus two
 * history characteristics for downloading stored readings.
 *
 * The board starts advertising even if the sensor is not connected.
 * It retries sensor initialisation every 5 seconds automatically,
 * so students can plug in the sensor after the board is powered on.
 *
 * HISTORY LOGGING
 * ───────────────
 * One reading is saved to flash (LittleFS) every LOG_INTERVAL_S seconds.
 * Up to MAX_RECORDS readings are kept as a ring buffer (~72 h at 60 s).
 * To download history over BLE:
 *   1. Read HISTORY_COUNT  → uint32 = number of records stored
 *   2. Write start index (uint32 LE) to HISTORY_DATA
 *   3. Subscribe to HISTORY_DATA notifications
 *   4. Firmware streams one 38-byte record per notification
 *   5. A single 0xFF byte signals the end of the stream
 *   6. To clear all history, write 0xFFFFFFFF to HISTORY_DATA
 *
 * CHARACTERISTIC MAP
 * ──────────────────
 *
 *   Particles  (UUID ...0010)   16 bytes  — LIVE, notify 1 Hz
 *   ┌────────────┬────────────┬────────────┬────────────┐
 *   │ PM1.0 (f32)│ PM2.5 (f32)│ PM4.0 (f32)│ PM10  (f32)│   µg/m³
 *   └────────────┴────────────┴────────────┴────────────┘
 *
 *   Gases      (UUID ...0011)   10 bytes  — LIVE, notify 1 Hz
 *   ┌────────────┬────────────┬────────────┐
 *   │ CO2  (u16) │ VOC   (f32)│ NOx   (f32)│
 *   └────────────┴────────────┴────────────┘
 *
 *   Environment (UUID ...0012)    8 bytes  — LIVE, notify 1 Hz
 *   ┌────────────┬────────────┐
 *   │ Temp  (f32)│ Humi  (f32)│   °C / %RH
 *   └────────────┴────────────┘
 *
 *   Battery (UUID ...0013, optional)   12 bytes  — LIVE, notify 1 Hz
 *   ┌────────────┬────────────┬────────────┐
 *   │ SoC   (f32)│ Volts (f32)│ Rate  (f32)│   % / V / %hr
 *   └────────────┴────────────┴────────────┘
 *
 *   History Count (UUID ...0020)   4 bytes  — READ
 *   ┌─────────────────────────────────────────────────┐
 *   │ record_count (u32)                              │
 *   └─────────────────────────────────────────────────┘
 *
 *   History Data  (UUID ...0021)  38 bytes per record — WRITE + NOTIFY
 *   WRITE  4 bytes → start index (u32 LE) to begin streaming
 *          0xFFFFFFFF → erase all history
 *   NOTIFY 38 bytes per record:
 *   ┌──────────┬──────────┬──────────┬──────────┬──────────┬──────┬──────────┬──────────┬──────────┬──────────┐
 *   │ts   (u32)│pm1  (f32)│pm25 (f32)│pm4  (f32)│pm10 (f32)│co2(u16)│voc(f32)│nox (f32) │temp (f32)│humi (f32)│
 *   └──────────┴──────────┴──────────┴──────────┴──────────┴──────┴──────────┴──────────┴──────────┴──────────┘
 *   NOTIFY 1 byte → 0xFF = end of stream
 *
 *   f32 = 4-byte IEEE 754 float, little-endian
 *   u16 = 2-byte unsigned integer, little-endian
 *   ts  = seconds since board boot (millis()/1000)
 *
 * BOARD SELECTION
 * ───────────────
 * Requires: - ArduinoBLE          (Library Manager — v1.3.6+)
 *           - Adafruit NeoPixel   (Library Manager)
 *           - Sensirion I2C SEN66 (Library Manager)
 *           - Sensirion Core      (installed automatically with the above)
 *
 * NOTE: Install ESP32 board package version 3.2.0 only.
 *       BLE is broken in 3.3.0+.
 */

// ═══════════════════════════════════════════════════════════════
// ██  DEVICE ID — give each board a unique number (1–99)  ██████
// ═══════════════════════════════════════════════════════════════
#define DEVICE_ID  1
// ═══════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════
// ██  BOARD SELECTION — uncomment exactly ONE line  ████████████
// ═══════════════════════════════════════════════════════════════
// #define BOARD_AMBIENT_ONE         // Ambient One PCB (Rev5)
#define BOARD_SPARKFUN_C6            // SparkFun ESP32-C6 Thing Plus
// ═══════════════════════════════════════════════════════════════

// ── Board-specific pin mapping ──────────────────────────────
#if defined(BOARD_AMBIENT_ONE)
  #define NEOPIXEL_PIN    23
  #define I2C_SDA         19
  #define I2C_SCL         20
  #define POWER_EN_PIN    15
  #define POWER_DET_PIN    2
  #define HAS_POWER_EN    true

#elif defined(BOARD_SPARKFUN_C6)
  #define NEOPIXEL_PIN    23
  #define I2C_SDA          6
  #define I2C_SCL          7
  #define HAS_POWER_EN    false
  #define ENABLE_BATTERY        // SparkFun C6 Thing Plus has MAX17048 built in

#else
  #error "No board selected! Uncomment BOARD_AMBIENT_ONE or BOARD_SPARKFUN_C6."
#endif

// ── Config ──────────────────────────────────────────────────
#define NUM_PIXELS        1
#define LED_BRIGHTNESS   50
#define SENSOR_RETRY_MS  5000    // ms between sensor reinit attempts
#define LOG_INTERVAL_S   60      // seconds between history writes
#define MAX_RECORDS      4320    // ring buffer size (4320 × 60 s = 72 h)
#define HISTORY_FILE     "/history.bin"
#define META_FILE        "/history_meta.bin"

// ─────────────────────────────────────────────────────────────
#include <Arduino.h>
#include <Wire.h>
#include <Adafruit_NeoPixel.h>
#include <SensirionI2cSen66.h>
#include <ArduinoBLE.h>
#include <LittleFS.h>

// ── Optional: Battery Monitor ────────────────────────────────
// Enabled automatically for boards that have a fuel gauge (see board config above).
#ifdef ENABLE_BATTERY
  #include <Adafruit_MAX1704X.h>
  Adafruit_MAX17048 battGauge;
  float battPercent()  { return min(battGauge.cellPercent(), 100.0f); }
  bool  battCharging() { return battGauge.chargeRate() > 0.1f; }
#endif

#ifdef NO_ERROR
#undef NO_ERROR
#endif
#define NO_ERROR 0

// ── History record layout (38 bytes) ────────────────────────
struct __attribute__((packed)) HistoryRecord {
  uint32_t ts;          // seconds since boot
  float    pm1, pm25, pm4, pm10;
  uint16_t co2;
  float    voc, nox;
  float    temperature, humidity;
};
static_assert(sizeof(HistoryRecord) == 38, "HistoryRecord size mismatch");

// Ring buffer metadata stored separately so we never corrupt the data file.
struct __attribute__((packed)) HistoryMeta {
  uint32_t count;      // number of valid records (0–MAX_RECORDS)
  uint32_t head;       // index where the next write goes (0–MAX_RECORDS-1)
};

// ── BLE service + characteristics ───────────────────────────
BLEService sensorService("12340001-1234-1234-1234-123456789abc");

// Live characteristics
BLECharacteristic charParticles("12340010-1234-1234-1234-123456789abc",
                                BLERead | BLENotify, 16);
BLECharacteristic charGases("12340011-1234-1234-1234-123456789abc",
                            BLERead | BLENotify, 10);
BLECharacteristic charEnv("12340012-1234-1234-1234-123456789abc",
                          BLERead | BLENotify, 8);
#ifdef ENABLE_BATTERY
BLECharacteristic charBattery("12340013-1234-1234-1234-123456789abc",
                              BLERead | BLENotify, 12);
#endif

// History characteristics
BLECharacteristic charHistCount("12340020-1234-1234-1234-123456789abc",
                                BLERead, 4);
BLECharacteristic charHistData("12340021-1234-1234-1234-123456789abc",
                               BLEWrite | BLENotify, 38);

// ── Globals ──────────────────────────────────────────────────
Adafruit_NeoPixel pixel(NUM_PIXELS, NEOPIXEL_PIN, NEO_GRB + NEO_KHZ800);
SensirionI2cSen66 sensor;

static char   errorMessage[64];
static int16_t error;
static bool   sensorReady    = false;
static uint32_t lastSensorRetry = 0;
static uint32_t lastLogTime  = 0;   // millis() of last history write

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

  // Keep the COUNT characteristic up to date
  uint32_t cnt = m.count;
  charHistCount.writeValue((uint8_t*)&cnt, 4);
}

// Read the Nth logical record (0 = oldest). Returns false if out of range.
bool readRecord(uint32_t index, HistoryRecord& out) {
  HistoryMeta m = readMeta();
  if (index >= m.count) return false;

  // oldest slot is (head - count + MAX_RECORDS) % MAX_RECORDS
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

// Stream records to the connected BLE client starting at `startIndex`.
// Yields to BLE.poll() between records to keep the connection alive.
void streamHistory(uint32_t startIndex) {
  HistoryMeta m = readMeta();
  Serial.printf("History: streaming from %u, total %u\n", startIndex, m.count);

  for (uint32_t i = startIndex; i < m.count; i++) {
    HistoryRecord rec;
    if (!readRecord(i, rec)) break;
    charHistData.writeValue((uint8_t*)&rec, sizeof(rec));
    BLE.poll();
    delay(20);   // give central time to process each notification
  }

  // Send end-of-stream marker
  uint8_t done = 0xFF;
  charHistData.writeValue(&done, 1);
  Serial.println("History: stream complete.");
}

// ── LED helpers ──────────────────────────────────────────────

uint32_t idColour(uint8_t id) {
  uint16_t hue = ((uint16_t)(id - 1) * 9830) % 65536;
  return Adafruit_NeoPixel::ColorHSV(hue, 255, 200);
}

void flashId(uint8_t id) {
  uint32_t c = idColour(id);
  for (int i = 0; i < 5; i++) {
    pixel.setPixelColor(0, c); pixel.show(); delay(200);
    pixel.clear();             pixel.show(); delay(200);
  }
  pixel.setPixelColor(0, c); pixel.show();
}

void pulseAmber() {
  static bool on = false;
  on = !on;
  pixel.setPixelColor(0, on ? pixel.Color(60, 20, 0) : 0);
  pixel.show();
}

// ── Sensor init ──────────────────────────────────────────────

bool initSensor() {
  Wire.end(); delay(10); Wire.begin(I2C_SDA, I2C_SCL);
  sensor.begin(Wire, SEN66_I2C_ADDR_6B);

  error = sensor.deviceReset();
  if (error != NO_ERROR) {
    errorToString(error, errorMessage, sizeof errorMessage);
    Serial.printf("SEN66 not found: %s\n", errorMessage);
    return false;
  }
  delay(1200);

  error = sensor.startContinuousMeasurement();
  if (error != NO_ERROR) {
    errorToString(error, errorMessage, sizeof errorMessage);
    Serial.printf("SEN66 start failed: %s\n", errorMessage);
    return false;
  }

  int8_t sn[32] = {0};
  sensor.getSerialNumber(sn, 32);
  Serial.printf("SEN66 ready — serial: %s\n", (const char*)sn);
  return true;
}

// ═════════════════════════════════════════════════════════════
void setup() {
  Serial.begin(115200);
  while (!Serial) { delay(100); }
  delay(500);

  String bleName;
  { char buf[20]; snprintf(buf, sizeof(buf), "Ambient Edu %02d", DEVICE_ID); bleName = buf; }

#if defined(BOARD_AMBIENT_ONE)
  Serial.println("\n=== Ambient Edu BLE — Board: Ambient One ===");
#else
  Serial.println("\n=== Ambient Edu BLE — Board: SparkFun C6 ===");
#endif
  Serial.printf("Device: %s\n", bleName.c_str());

#if HAS_POWER_EN
  pinMode(POWER_EN_PIN, OUTPUT); digitalWrite(POWER_EN_PIN, HIGH);
  pinMode(POWER_DET_PIN, INPUT_PULLUP);
  delay(100);
#endif

  pixel.begin(); pixel.setBrightness(LED_BRIGHTNESS); pixel.clear(); pixel.show();
  flashId(DEVICE_ID);

  // ── LittleFS ──────────────────────────────────────────────
  if (!LittleFS.begin(true)) {   // true = format on first use
    Serial.println("LittleFS mount failed!");
  } else {
    HistoryMeta m = readMeta();
    Serial.printf("History: %u records stored\n", m.count);
  }

  // ── Sensor ────────────────────────────────────────────────
  Wire.begin(I2C_SDA, I2C_SCL);
  sensorReady = initSensor();
  if (!sensorReady) Serial.println("No sensor — will retry every 5 s.");

  // ── Battery ───────────────────────────────────────────────
#ifdef ENABLE_BATTERY
  if (!battGauge.begin()) Serial.println("MAX17048 not found.");
  else Serial.printf("Battery: %.0f%%  %.2fV\n", battPercent(), battGauge.cellVoltage());
#endif

  // ── BLE ───────────────────────────────────────────────────
  if (!BLE.begin()) { Serial.println("BLE init failed!"); while (1); }

  BLE.setLocalName(bleName.c_str());
  BLE.setDeviceName(bleName.c_str());
  BLE.setAdvertisedService(sensorService);

  sensorService.addCharacteristic(charParticles);
  sensorService.addCharacteristic(charGases);
  sensorService.addCharacteristic(charEnv);
#ifdef ENABLE_BATTERY
  sensorService.addCharacteristic(charBattery);
#endif
  sensorService.addCharacteristic(charHistCount);
  sensorService.addCharacteristic(charHistData);

  BLE.addService(sensorService);

  // Initialise count characteristic with what's on disk
  { HistoryMeta m = readMeta(); charHistCount.writeValue((uint8_t*)&m.count, 4); }

  BLE.advertise();
  Serial.printf("BLE advertising as \"%s\"\n\n", bleName.c_str());
}

// ═════════════════════════════════════════════════════════════
void loop() {
  BLE.poll();

  // ── Sensor retry ──────────────────────────────────────────
  if (!sensorReady) {
    pulseAmber();
    if (millis() - lastSensorRetry >= SENSOR_RETRY_MS) {
      lastSensorRetry = millis();
      sensorReady = initSensor();
      if (sensorReady) { pixel.setPixelColor(0, idColour(DEVICE_ID)); pixel.show(); }
    }
    delay(500);
    return;
  }

  // ── Handle history download requests ──────────────────────
  if (charHistData.written()) {
    uint8_t buf[4];
    int len = charHistData.readValue(buf, 4);
    if (len == 4) {
      uint32_t cmd;
      memcpy(&cmd, buf, 4);
      if (cmd == 0xFFFFFFFF) {
        clearHistory();
      } else {
        streamHistory(cmd);
      }
    }
  }

  // ── Read sensor ───────────────────────────────────────────
  float pm1p0 = 0, pm2p5 = 0, pm4p0 = 0, pm10p0 = 0;
  float humidity = 0, temperature = 0;
  float vocIndex = 0, noxIndex = 0;
  uint16_t co2 = 0;

  delay(1000);

  error = sensor.readMeasuredValues(
      pm1p0, pm2p5, pm4p0, pm10p0,
      humidity, temperature, vocIndex, noxIndex, co2);

  if (error != NO_ERROR) {
    errorToString(error, errorMessage, sizeof errorMessage);
    Serial.printf("Read error: %s\n", errorMessage);
    sensorReady = false;
    lastSensorRetry = millis();
    return;
  }

  // SEN66 returns 0xFFFF while warming up — skip until data is valid
  if (co2 == 65535 || pm2p5 > 1000.0f) {
    Serial.println("  (sensor warming up…)");
    return;
  }

  // ── Live BLE notify ───────────────────────────────────────
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
#ifdef ENABLE_BATTERY
  {
    float soc = battPercent(), volts = battGauge.cellVoltage(), rate = battGauge.chargeRate();
    uint8_t buf[12];
    memcpy(buf + 0, &soc, 4); memcpy(buf + 4, &volts, 4); memcpy(buf + 8, &rate, 4);
    charBattery.writeValue(buf, 12);
  }
#endif

  // ── History log (every LOG_INTERVAL_S seconds) ────────────
  uint32_t now = millis();
  if (now - lastLogTime >= (uint32_t)LOG_INTERVAL_S * 1000) {
    lastLogTime = now;
    HistoryRecord rec = {
      now / 1000,
      pm1p0, pm2p5, pm4p0, pm10p0,
      co2,
      vocIndex, noxIndex,
      temperature, humidity
    };
    appendRecord(rec);
  }

  // ── Serial ────────────────────────────────────────────────
  Serial.println("────────────────────────────────────");
  Serial.printf("  PM2.5: %.1f µg/m³   CO2: %u ppm\n", pm2p5, co2);
  Serial.printf("  Temp:  %.1f °C      RH:  %.1f %%\n", temperature, humidity);
  if (BLE.connected()) Serial.println("  [BLE client connected]");
}
