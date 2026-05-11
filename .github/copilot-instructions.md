# GitHub Copilot Instructions

## Project Overview

React Native/Expo app (dev client, not Expo Go) that connects to Arduino ESP32-C6 environmental sensor boards via BLE. Displays live air quality data and downloads/visualizes historical readings.

## File Structure

```
App.tsx          # Root component: scan → device list → connected view (Live / History tabs)
src/ble.ts       # All BLE logic: scan, connect, subscribe, history download, binary decoders
src/theme.ts     # Design tokens: colors, spacing, radius
arduino/         # ESP32-C6 firmware (SEN66 sensor + BLE GATT server)
```

## State & Architecture

- **No global state** — plain `useState` hooks in `App.tsx`. No Redux, no Context.
- `ConnState`: `'idle' | 'connecting' | 'connected' | 'error'`
- `Screen`: `'live' | 'history'`
- Cleanup refs (`stopScanRef`, `disconnectRef`) hold tear-down callbacks for unmount safety.
- `BleManager` is lazily initialised via `ensureStarted()` on first use.

## BLE Protocol

**Service UUID:** `12340001-1234-1234-1234-123456789abc`

| Characteristic | UUID          | Format       | Data                          |
|----------------|---------------|--------------|-------------------------------|
| Particles      | `...0010`     | 4×f32        | PM1, PM2.5, PM4, PM10 µg/m³  |
| Gases          | `...0011`     | u16 + 2×f32  | CO2 ppm, VOC index, NOx index |
| Environment    | `...0012`     | 2×f32        | Temp °C, Humidity %           |
| Battery        | `...0013`     | 3×f32        | SoC %, Voltage V, Charge rate |
| HistoryCount   | `...0020`     | u32          | Total stored records          |
| HistoryData    | `...0021`     | 38 B records | Write start index; receive stream |

All values are **little-endian**. Live characteristics notify at ~1 Hz. History stream ends with a single `0xFF` byte. Battery characteristic is **optional** — check for its presence before subscribing.

**History record (38 bytes):** `u32 ts | f32 pm1 | f32 pm25 | f32 pm4 | f32 pm10 | u16 co2 | f32 voc | f32 nox | f32 temp | f32 humidity`

## Key Types (src/ble.ts)

```ts
Particles   { pm1, pm25, pm4, pm10 }
Gases       { co2, voc, nox }
Environment { temperature, humidity }
Battery     { soc, volts, rate }
Readings    { particles?, gases?, env?, battery?, updatedAt? }
HistoryRecord  // all of the above plus ts (seconds since boot), no Battery
DiscoveredDevice // { id, name, rssi }
```

## Coding Conventions

- TypeScript strict mode — no implicit `any`.
- Functional components only; no class components.
- Keep BLE logic in `src/ble.ts`; keep UI logic in `App.tsx`.
- Use `StyleSheet.create` for styles; reference design tokens from `src/theme.ts` (`colors`, `spacing`, `radius`).
- Binary decoding helpers (`f32`, `u16`, `u32`) live in `src/ble.ts` — reuse them, don't duplicate.
- Errors surface as `string | null` state; show inline with `<Text style={styles.error}>`.

## Platform Notes

- **Physical device required** — BLE does not work in simulators.
- Android requires runtime permissions: `BLUETOOTH_SCAN` + `BLUETOOTH_CONNECT` (requested in `requestAndroidPerms()`).
- iOS BLE works without extra permissions at runtime.
- `react-native-ble-manager` emits events via `NativeEventEmitter`; always call `.remove()` on subscriptions during cleanup.

## Arduino Firmware

- **ESP32 board package must be v3.2.0** — BLE is broken in v3.3.0+.
- Board configs: Ambient One Rev5 (NeoPixel GPIO23, I2C SDA19/SCL20, PowerEN GPIO15) or SparkFun ESP32-C6 (NeoPixel GPIO23, I2C SDA6/SCL7).
- History stored in LittleFS ring buffer, 60-second intervals, ~24 h capacity.
- Required libraries: ArduinoBLE, Sensirion I2C SEN66, Adafruit NeoPixel.

## Development Commands

```bash
npm start          # Start Expo dev server
npm run ios        # Build + run on iOS device
npm run android    # Build + run on Android device
npm run prebuild   # Regenerate native projects
```
