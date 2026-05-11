import { NativeEventEmitter, NativeModules, Platform } from 'react-native';
import BleManager, { Peripheral } from 'react-native-ble-manager';

export const SERVICE_UUID = '12340001-1234-1234-1234-123456789abc';
export const CHAR_PARTICLES = '12340010-1234-1234-1234-123456789abc';
export const CHAR_GASES = '12340011-1234-1234-1234-123456789abc';
export const CHAR_ENV = '12340012-1234-1234-1234-123456789abc';
export const CHAR_BATTERY = '12340013-1234-1234-1234-123456789abc';

export const DEVICE_NAME_PREFIX = 'Ambient Edu';

export type Particles = { pm1: number; pm25: number; pm4: number; pm10: number };
export type Gases = { co2: number; voc: number; nox: number };
export type Environment = { temperature: number; humidity: number };
export type Battery = { soc: number; volts: number; rate: number };

export type Readings = {
  particles?: Particles;
  gases?: Gases;
  env?: Environment;
  battery?: Battery;
  updatedAt?: number;
};

const f32 = (b: number[], o: number) => {
  const view = new DataView(new Uint8Array(b.slice(o, o + 4)).buffer);
  return view.getFloat32(0, true);
};

const u16 = (b: number[], o: number) => b[o] | (b[o + 1] << 8);

export const decodeParticles = (b: number[]): Particles => ({
  pm1: f32(b, 0),
  pm25: f32(b, 4),
  pm4: f32(b, 8),
  pm10: f32(b, 12),
});

export const decodeGases = (b: number[]): Gases => ({
  co2: u16(b, 0),
  voc: f32(b, 2),
  nox: f32(b, 6),
});

export const decodeEnv = (b: number[]): Environment => ({
  temperature: f32(b, 0),
  humidity: f32(b, 4),
});

export const decodeBattery = (b: number[]): Battery => ({
  soc: f32(b, 0),
  volts: f32(b, 4),
  rate: f32(b, 8),
});

const bleEmitter = new NativeEventEmitter(NativeModules.BleManager);

let started = false;
export async function ensureStarted() {
  if (started) return;
  await BleManager.start({ showAlert: false });
  started = true;
}

export type DiscoveredDevice = Pick<Peripheral, 'id' | 'name' | 'rssi'>;

export async function startScan(onDevice: (d: DiscoveredDevice) => void) {
  await ensureStarted();

  const sub = bleEmitter.addListener(
    'BleManagerDiscoverPeripheral',
    (p: Peripheral) => {
      const name = p.name ?? p.advertising?.localName;
      if (!name || !name.startsWith(DEVICE_NAME_PREFIX)) return;
      onDevice({ id: p.id, name, rssi: p.rssi });
    }
  );

  await BleManager.scan([SERVICE_UUID], 30, true);
  return () => {
    sub.remove();
    BleManager.stopScan().catch(() => {});
  };
}

export async function connectAndSubscribe(
  deviceId: string,
  onUpdate: (r: Readings) => void
) {
  await ensureStarted();
  await BleManager.connect(deviceId);
  const info = await BleManager.retrieveServices(deviceId);

  const hasBattery = info.characteristics?.some(
    (c) => c.characteristic.toLowerCase() === CHAR_BATTERY.toLowerCase()
  );

  let readings: Readings = {};
  const push = (patch: Partial<Readings>) => {
    readings = { ...readings, ...patch, updatedAt: Date.now() };
    onUpdate(readings);
  };

  const sub = bleEmitter.addListener(
    'BleManagerDidUpdateValueForCharacteristic',
    ({ value, characteristic }: { value: number[]; characteristic: string }) => {
      const c = characteristic.toLowerCase();
      if (c === CHAR_PARTICLES.toLowerCase()) push({ particles: decodeParticles(value) });
      else if (c === CHAR_GASES.toLowerCase()) push({ gases: decodeGases(value) });
      else if (c === CHAR_ENV.toLowerCase()) push({ env: decodeEnv(value) });
      else if (c === CHAR_BATTERY.toLowerCase()) push({ battery: decodeBattery(value) });
    }
  );

  const disconnectSub = bleEmitter.addListener(
    'BleManagerDisconnectPeripheral',
    () => onUpdate({ ...readings, updatedAt: Date.now() })
  );

  await BleManager.startNotification(deviceId, SERVICE_UUID, CHAR_PARTICLES);
  await BleManager.startNotification(deviceId, SERVICE_UUID, CHAR_GASES);
  await BleManager.startNotification(deviceId, SERVICE_UUID, CHAR_ENV);
  if (hasBattery) {
    await BleManager.startNotification(deviceId, SERVICE_UUID, CHAR_BATTERY);
  }

  return async () => {
    sub.remove();
    disconnectSub.remove();
    try {
      await BleManager.disconnect(deviceId);
    } catch {}
  };
}

export const isAndroid = Platform.OS === 'android';
