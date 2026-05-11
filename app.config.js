const bundleIdentifier =
  process.env.BUNDLE_IDENTIFIER || 'io.ambientworks.ambientble.dev';
const appName = process.env.APP_NAME || 'Ambient BLE';

export default {
  expo: {
    name: appName,
    slug: 'ambient-ble',
    version: '1.0.0',
    owner: 'aw-software',
    orientation: 'portrait',
    userInterfaceStyle: 'light',
    newArchEnabled: false,
    platforms: ['ios', 'android'],
    ios: {
      bundleIdentifier,
      buildNumber: '1',
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
    extra: {
      eas: {
        projectId: '62c94205-1ff2-4c3d-b569-0e120f8fee9b',
      },
    },
  },
};
