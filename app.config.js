const bundleIdentifier =
  process.env.BUNDLE_IDENTIFIER || 'io.ambientworks.ambientble.dev';
const appName = process.env.APP_NAME || 'Ambient BLE';

export default {
  expo: {
    name: appName,
    slug: 'ambient-ble',
    version: '0.1.0',
    owner: 'aw-software',
    orientation: 'portrait',
    userInterfaceStyle: 'light',
    newArchEnabled: true,
    platforms: ['ios', 'android'],
    ios: {
      bundleIdentifier,
      supportsTablet: false,
      config: { usesNonExemptEncryption: false },
      infoPlist: {
        NSBluetoothAlwaysUsageDescription:
          'This app uses Bluetooth to read live data from Ambient Edu sensors.',
        NSBluetoothPeripheralUsageDescription:
          'This app uses Bluetooth to read live data from Ambient Edu sensors.',
      },
    },
    android: {
      package: bundleIdentifier,
      permissions: [
        'android.permission.BLUETOOTH_SCAN',
        'android.permission.BLUETOOTH_CONNECT',
      ],
    },
    plugins: [
      'expo-dev-client',
      [
        'react-native-ble-manager',
        { neverForLocation: true, isBleRequired: true },
      ],
    ],
    experiments: { typedRoutes: false },
  },
};
