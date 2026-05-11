/**
 * Ambient Edu — BLE Broadcast
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
 * grouped characteristics — one for particles, one for gases, and
 * one for environment. Each characteristic packs related values
 * into a single byte payload (little-endian).
 *
 * The board starts advertising even if the sensor is not connected.
 * It retries sensor initialisation every 5 seconds automatically,
 * so students can plug in the sensor after the board is powered on.
 *
 * BUILDING YOUR OWN APP
 * ─────────────────────
 * 1. Scan for a device named "Ambient Edu XX"
 * 2. Connect and discover the service UUID below
 * 3. Subscribe to NOTIFY on the characteristic(s) you care about
 * 4. Decode the byte payload — see the map below
 *
 * CHARACTERISTIC MAP
 * ──────────────────
 *
 *   Particles  (UUID ...0010)   16 bytes
 *   ┌────────────┬────────────┬────────────┬────────────┐
 *   │ PM1.0 (f32)│ PM2.5 (f32)│ PM4.0 (f32)│ PM10  (f32)│   all µg/m³
 *   └────────────┴────────────┴────────────┴────────────┘
 *
 *   Gases      (UUID ...0011)   10 bytes
 *   ┌────────────┬────────────┬────────────┐
 *   │ CO2  (u16) │ VOC   (f32)│ NOx   (f32)│   ppm / index
 *   └────────────┴────────────┴────────────┘
 *
 *   Environment (UUID ...0012)    8 bytes
 *   ┌────────────┬────────────┐
 *   │ Temp  (f32)│ Humi  (f32)│   °C / %RH
 *   └────────────┴────────────┘
 *
 *   Battery (UUID ...0013, optional)   12 bytes
 *   ┌────────────┬────────────┬────────────┐
 *   │ SoC   (f32)│ Volts (f32)│ Rate  (f32)│   % / V / %hr
 *   └────────────┴────────────┴────────────┘
 *
 *   f32 = 4-byte IEEE 754 float, little-endian
 *   u16 = 2-byte unsigned integer, little-endian
 *
 * BOARD SELECTION
 * ───────────────
 * Uncomment ONE of the two #define lines below to match your hardware.
 *
 * Board:    ESP32-C6 (select "SparkFun ESP32-C6 Thing Plus" in Arduino IDE)
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

#else
  #error "No board selected! Uncomment BOARD_AMBIENT_ONE or BOARD_SPARKFUN_C6."
#endif

// ── Common config ───────────────────────────────────────────
#define NUM_PIXELS        1
#define LED_BRIGHTNESS   50
#define SENSOR_RETRY_MS  5000   // retry sensor init this often when not found

// ─────────────────────────────────────────────────────────────
#include <Arduino.h>
#include <Wire.h>
#include <Adafruit_NeoPixel.h>
#include <SensirionI2cSen66.h>
#include <ArduinoBLE.h>

// ── Optional: Battery Monitor (SparkFun C6 has MAX17048) ────
// Uncomment the next line and install "Adafruit MAX1704X" from Library Manager
// #define ENABLE_BATTERY
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

// ── BLE service + characteristics ───────────────────────────
BLEService sensorService("12340001-1234-1234-1234-123456789abc");

BLECharacteristic charParticles("12340010-1234-1234-1234-123456789abc",
                                BLERead | BLENotify, 16);   // 4 × float

BLECharacteristic charGases("12340011-1234-1234-1234-123456789abc",
                            BLERead | BLENotify, 10);       // uint16 + 2 × float

BLECharacteristic charEnv("12340012-1234-1234-1234-123456789abc",
                          BLERead | BLENotify, 8);           // 2 × float

#ifdef ENABLE_BATTERY
BLECharacteristic charBattery("12340013-1234-1234-1234-123456789abc",
                              BLERead | BLENotify, 12);     // 3 × float
#endif

// ── Globals ─────────────────────────────────────────────────
Adafruit_NeoPixel pixel(NUM_PIXELS, NEOPIXEL_PIN, NEO_GRB + NEO_KHZ800);
SensirionI2cSen66 sensor;

static char errorMessage[64];
static int16_t error;

// Tracks whether the SEN66 is ready to read.
// False on startup if sensor not connected; retried automatically in loop().
static bool sensorReady = false;
static uint32_t lastSensorRetry = 0;

// ── Helpers ─────────────────────────────────────────────────

uint32_t idColour(uint8_t id) {
  uint16_t hue = ((uint16_t)(id - 1) * 9830) % 65536;
  return Adafruit_NeoPixel::ColorHSV(hue, 255, 200);
}

void flashId(uint8_t id) {
  uint32_t c = idColour(id);
  for (int i = 0; i < 5; i++) {
    pixel.setPixelColor(0, c);
    pixel.show();
    delay(200);
    pixel.clear();
    pixel.show();
    delay(200);
  }
  pixel.setPixelColor(0, c);
  pixel.show();
}

// Dim amber pulse while waiting for sensor — makes the "not ready" state obvious.
void pulseAmber() {
  static bool on = false;
  on = !on;
  pixel.setPixelColor(0, on ? pixel.Color(60, 20, 0) : 0);
  pixel.show();
}

String buildName() {
  char buf[20];
  snprintf(buf, sizeof(buf), "Ambient Edu %02d", DEVICE_ID);
  return String(buf);
}

// Try to reset and start the SEN66. Returns true on success.
// Safe to call repeatedly; performs a Wire bus reset first to recover
// from a stuck bus caused by a previous failed transaction.
bool initSensor() {
  // Release any stuck I2C transaction before retrying
  Wire.end();
  delay(10);
  Wire.begin(I2C_SDA, I2C_SCL);

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

  int8_t serialNumber[32] = {0};
  sensor.getSerialNumber(serialNumber, 32);
  Serial.printf("SEN66 ready — serial: %s\n", (const char*)serialNumber);
  return true;
}

// ═════════════════════════════════════════════════════════════
void setup() {
  Serial.begin(115200);
  while (!Serial) { delay(100); }
  delay(500);

  String bleName = buildName();

#if defined(BOARD_AMBIENT_ONE)
  Serial.println("\n=== Ambient Edu BLE — Board: Ambient One ===");
#elif defined(BOARD_SPARKFUN_C6)
  Serial.println("\n=== Ambient Edu BLE — Board: SparkFun C6 ===");
#endif
  Serial.printf("Device ID: %d  →  BLE name: \"%s\"\n", DEVICE_ID, bleName.c_str());

  // ── Power rail (Ambient One only) ─────────────────────────
#if HAS_POWER_EN
  pinMode(POWER_EN_PIN, OUTPUT);
  digitalWrite(POWER_EN_PIN, HIGH);
  pinMode(POWER_DET_PIN, INPUT_PULLUP);
  Serial.println("Power rail enabled (GPIO 15 = HIGH)");
  delay(100);
#endif

  // ── NeoPixel ──────────────────────────────────────────────
  pixel.begin();
  pixel.setBrightness(LED_BRIGHTNESS);
  pixel.clear();
  pixel.show();
  flashId(DEVICE_ID);

  // ── I2C + SEN66 ───────────────────────────────────────────
  Wire.begin(I2C_SDA, I2C_SCL);
  Serial.printf("I2C started (SDA=%d, SCL=%d)\n", I2C_SDA, I2C_SCL);

  sensorReady = initSensor();
  if (!sensorReady) {
    Serial.println("No sensor found — BLE will still advertise.");
    Serial.printf("Retrying every %d s.\n", SENSOR_RETRY_MS / 1000);
  }

  // ── Battery gauge (optional) ──────────────────────────────
#ifdef ENABLE_BATTERY
  if (!battGauge.begin()) {
    Serial.println("MAX17048 not found — battery monitoring disabled.");
  } else {
    Serial.printf("Battery: %.0f%%  %.2fV\n", battPercent(), battGauge.cellVoltage());
  }
#endif

  // ── BLE — always starts regardless of sensor state ────────
  if (!BLE.begin()) {
    Serial.println("BLE init failed!");
    while (1);
  }

  BLE.setLocalName(bleName.c_str());
  BLE.setDeviceName(bleName.c_str());
  BLE.setAdvertisedService(sensorService);

  sensorService.addCharacteristic(charParticles);
  sensorService.addCharacteristic(charGases);
  sensorService.addCharacteristic(charEnv);
#ifdef ENABLE_BATTERY
  sensorService.addCharacteristic(charBattery);
#endif

  BLE.addService(sensorService);
  BLE.advertise();

  Serial.printf("BLE advertising as \"%s\"\n", bleName.c_str());
  Serial.println("Open nRF Connect or LightBlue to see the data.\n");
}

// ═════════════════════════════════════════════════════════════
void loop() {
  BLE.poll();

  // ── Sensor retry when not connected ───────────────────────
  if (!sensorReady) {
    pulseAmber();
    if (millis() - lastSensorRetry >= SENSOR_RETRY_MS) {
      lastSensorRetry = millis();
      Serial.println("Retrying SEN66...");
      sensorReady = initSensor();
      if (sensorReady) {
        // Restore device-ID colour now that sensor is live
        pixel.setPixelColor(0, idColour(DEVICE_ID));
        pixel.show();
      }
    }
    delay(500);
    return;
  }

  // ── Normal read loop ──────────────────────────────────────
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
    // Mark sensor as lost — will retry on next loop iteration
    sensorReady = false;
    lastSensorRetry = millis();
    return;
  }

  // ── Pack & write: Particles (16 bytes) ────────────────────
  {
    uint8_t buf[16];
    memcpy(buf + 0,  &pm1p0,  4);
    memcpy(buf + 4,  &pm2p5,  4);
    memcpy(buf + 8,  &pm4p0,  4);
    memcpy(buf + 12, &pm10p0, 4);
    charParticles.writeValue(buf, 16);
  }

  // ── Pack & write: Gases (10 bytes) ────────────────────────
  {
    uint8_t buf[10];
    memcpy(buf + 0, &co2,      2);
    memcpy(buf + 2, &vocIndex, 4);
    memcpy(buf + 6, &noxIndex, 4);
    charGases.writeValue(buf, 10);
  }

  // ── Pack & write: Environment (8 bytes) ───────────────────
  {
    uint8_t buf[8];
    memcpy(buf + 0, &temperature, 4);
    memcpy(buf + 4, &humidity,    4);
    charEnv.writeValue(buf, 8);
  }

  // ── Pack & write: Battery (12 bytes, optional) ────────────
#ifdef ENABLE_BATTERY
  {
    float soc   = battPercent();
    float volts = battGauge.cellVoltage();
    float rate  = battGauge.chargeRate();
    uint8_t buf[12];
    memcpy(buf + 0, &soc,   4);
    memcpy(buf + 4, &volts, 4);
    memcpy(buf + 8, &rate,  4);
    charBattery.writeValue(buf, 12);
  }
#endif

  // ── Serial output ─────────────────────────────────────────
  Serial.println("────────────────────────────────────");
  Serial.printf("  PM2.5: %.1f µg/m³   CO2: %u ppm\n", pm2p5, co2);
  Serial.printf("  Temp:  %.1f °C      RH:  %.1f %%\n", temperature, humidity);
#ifdef ENABLE_BATTERY
  Serial.printf("  Battery: %.0f%% %.2fV %s\n",
                battPercent(), battGauge.cellVoltage(),
                battCharging() ? "[charging]" : "[discharging]");
#endif
  if (BLE.connected()) Serial.println("  [BLE client connected]");
}
