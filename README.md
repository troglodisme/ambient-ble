# Ambient BLE

React Native app for connecting to **Ambient Edu** ESP32-C6 air quality sensors via Bluetooth.

## What it does

- Connects to Ambient Edu boards over BLE
- Displays live readings: PM1 / PM2.5 / PM4 / PM10, CO₂, VOC, NOx, temperature, humidity, battery
- **Session tab** — 1 Hz live chart from the current connection
- **History tab** — download the on-device 24-hour ring buffer, view as interactive chart, export as CSV
- Time-syncs the board clock on connect so history timestamps are accurate
- Works on iOS (Android support included)

## Hardware

[SparkFun ESP32-C6 Thing Plus](https://www.sparkfun.com/products/22925) with a Sensirion SEN66 air quality sensor and MAX17048 battery gauge.

Firmware is in [`arduino/ambient-edu-sparkfun/`](arduino/ambient-edu-sparkfun/).

## Development

Physical device required — BLE does not work in simulators.

```bash
npm install
npm run ios -- --device    # build dev client and install on iPhone
```

## TestFlight

Available internally via TestFlight. Contact the team for an invite.

## Tech stack

- Expo SDK 54 (dev client)
- React Native 0.81.5
- react-native-ble-manager
- react-native-svg
- expo-file-system + expo-sharing
