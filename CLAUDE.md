# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

React Native/Expo app that connects to Arduino ESP32-C6 environmental sensor boards via BLE. Displays live air quality data (PM, CO2, VOC, NOx, temp, humidity, battery) and downloads/visualizes historical readings.

## Development Commands

```bash
npm start              # Start Expo dev server (dev client mode)
npm run ios            # Build and run on iOS
npm run android        # Build and run on Android
npm run prebuild       # Regenerate native projects
```

Physical device required for BLE testing (no simulator support).

## Architecture

```
App.tsx                 # Main component: scanning, connection, UI state
src/ble.ts              # BLE service: scan, connect, subscribe, history download
src/theme.ts            # Design tokens (colors, spacing, radius)
arduino/ambient-edu-ble/ # ESP32-C6 firmware with SEN66 sensor + BLE server
```

**State management:** Local useState hooks in App.tsx (no Redux/Context).

**Two screens:**
1. Device list (scan for "Ambient Edu" boards)
2. Connected view with Live/History tabs

## BLE Protocol

**Service UUID:** `12340001-1234-1234-1234-123456789abc`

| Characteristic | UUID suffix | Format | Data |
|----------------|-------------|--------|------|
| Particles | 0010 | 4×f32 | PM1, PM2.5, PM4, PM10 (µg/m³) |
| Gases | 0011 | u16+2×f32 | CO2 (ppm), VOC, NOx (index) |
| Environment | 0012 | 2×f32 | Temp (°C), Humidity (%) |
| Battery | 0013 | 3×f32 | SoC (%), Voltage, Charge rate |
| HistoryCount | 0020 | u32 | Total stored records |
| HistoryData | 0021 | 38B records | Write start index, receive stream |

All values little-endian. Live chars notify at 1Hz. History ends with 0xFF byte.

**History record (38 bytes):** `u32 ts | f32 pm1 | f32 pm25 | f32 pm4 | f32 pm10 | u16 co2 | f32 voc | f32 nox | f32 temp | f32 humidity`

## Arduino Firmware

**Board configs in firmware:**
- Ambient One Rev5: NeoPixel GPIO23, I2C SDA19/SCL20, PowerEN GPIO15
- SparkFun ESP32-C6: NeoPixel GPIO23, I2C SDA6/SCL7

**Build requirements:**
- ESP32 board package v3.2.0 (BLE broken in 3.3.0+)
- ArduinoBLE, Sensirion I2C SEN66, Adafruit NeoPixel libraries

**History storage:** LittleFS ring buffer, 60-second intervals, ~24hr capacity.

## Key Patterns

- BLE manager lazily initialized via `ensureStarted()`
- Cleanup refs (`stopScanRef`, `disconnectRef`) for unmount safety
- Binary decoders in ble.ts parse little-endian floats/ints
- Android requires runtime BLUETOOTH_SCAN + BLUETOOTH_CONNECT permissions
- Battery characteristic is optional (graceful fallback if absent)
