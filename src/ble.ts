import { Platform } from 'react-native';
import BleManager, { Peripheral } from 'react-native-ble-manager';

export const SERVICE_UUID    = '12340001-1234-1234-1234-123456789abc';
export const CHAR_PARTICLES  = '12340010-1234-1234-1234-123456789abc';
export const CHAR_GASES      = '12340011-1234-1234-1234-123456789abc';
export const CHAR_ENV        = '12340012-1234-1234-1234-123456789abc';
export const CHAR_BATTERY    = '12340013-1234-1234-1234-123456789abc';
export const CHAR_HIST_COUNT = '12340020-1234-1234-1234-123456789abc';
export const CHAR_HIST_DATA  = '12340021-1234-1234-1234-123456789abc';

export const DEVICE_NAME_PREFIX = 'Ambient Edu';

export type Particles   = { pm1: number; pm25: number; pm4: number; pm10: number };
export type Gases       = { co2: number; voc: number; nox: number };
export type Environment = { temperature: number; humidity: number };
export type Battery     = { soc: number; volts: number; rate: number };

export type Readings = {
  particles?: Particles;
  gases?: Gases;
  env?: Environment;
  battery?: Battery;
  updatedAt?: number;
};

export type HistoryRecord = {
  ts: number;       // seconds since board boot
} & Particles & Omit<Gases, never> & Environment;

// ── Decoders ─────────────────────────────────────────────────

const f32 = (b: number[], o: number) =>
  new DataView(new Uint8Array(b.slice(o, o + 4)).buffer).getFloat32(0, true);

const u16 = (b: number[], o: number) => b[o] | (b[o + 1] << 8);

const u32 = (b: number[], o: number) =>
  b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24);

export const decodeParticles = (b: number[]): Particles => ({
  pm1: f32(b, 0), pm25: f32(b, 4), pm4: f32(b, 8), pm10: f32(b, 12),
});

export const decodeGases = (b: number[]): Gases => ({
  co2: u16(b, 0), voc: f32(b, 2), nox: f32(b, 6),
});

export const decodeEnv = (b: number[]): Environment => ({
  temperature: f32(b, 0), humidity: f32(b, 4),
});

export const decodeBattery = (b: number[]): Battery => ({
  soc: f32(b, 0), volts: f32(b, 4), rate: f32(b, 8),
});

// 38-byte history record: u32 ts | f32×4 PM | u16 CO2 | f32×2 gas | f32×2 env
export const decodeHistoryRecord = (b: number[]): HistoryRecord => ({
  ts:          u32(b, 0),
  pm1:         f32(b, 4),
  pm25:        f32(b, 8),
  pm4:         f32(b, 12),
  pm10:        f32(b, 16),
  co2:         u16(b, 20),
  voc:         f32(b, 22),
  nox:         f32(b, 26),
  temperature: f32(b, 30),
  humidity:    f32(b, 34),
});

// ── BLE bootstrap ────────────────────────────────────────────

let started = false;
export async function ensureStarted() {
  if (started) return;
  await BleManager.start({ showAlert: false });
  started = true;
}

// ── Scan ─────────────────────────────────────────────────────

export type DiscoveredDevice = Pick<Peripheral, 'id' | 'name' | 'rssi'>;

export async function startScan(onDevice: (d: DiscoveredDevice) => void) {
  await ensureStarted();
  const sub = BleManager.onDiscoverPeripheral(p => {
    const name = p.name ?? p.advertising?.localName;
    if (!name?.startsWith(DEVICE_NAME_PREFIX)) return;
    onDevice({ id: p.id, name, rssi: p.rssi });
  });
  await BleManager.scan([SERVICE_UUID], 30, true);
  return () => { sub.remove(); BleManager.stopScan().catch(() => {}); };
}

// ── Connect + live subscribe ─────────────────────────────────

export async function connectAndSubscribe(
  deviceId: string,
  onUpdate: (r: Readings) => void,
) {
  await ensureStarted();
  await BleManager.connect(deviceId);
  const info = await BleManager.retrieveServices(deviceId);

  const has = (uuid: string) =>
    info.characteristics?.some(c => c.characteristic.toLowerCase() === uuid.toLowerCase());

  let readings: Readings = {};
  const push = (patch: Partial<Readings>) => {
    readings = { ...readings, ...patch, updatedAt: Date.now() };
    onUpdate(readings);
  };

  const liveSub = BleManager.onDidUpdateValueForCharacteristic(({ value, characteristic }) => {
    const c = characteristic.toLowerCase();
    if (c === CHAR_PARTICLES.toLowerCase())  push({ particles: decodeParticles(value) });
    else if (c === CHAR_GASES.toLowerCase()) push({ gases: decodeGases(value) });
    else if (c === CHAR_ENV.toLowerCase())   push({ env: decodeEnv(value) });
    else if (c === CHAR_BATTERY.toLowerCase()) push({ battery: decodeBattery(value) });
  });

  await BleManager.startNotification(deviceId, SERVICE_UUID, CHAR_PARTICLES);
  await BleManager.startNotification(deviceId, SERVICE_UUID, CHAR_GASES);
  await BleManager.startNotification(deviceId, SERVICE_UUID, CHAR_ENV);
  if (has(CHAR_BATTERY)) {
    await BleManager.startNotification(deviceId, SERVICE_UUID, CHAR_BATTERY);
  }

  return {
    disconnect: async () => {
      liveSub.remove();
      try { await BleManager.disconnect(deviceId); } catch {}
    },
    deviceId,
    hasBattery: has(CHAR_BATTERY),
    hasHistory: has(CHAR_HIST_COUNT) && has(CHAR_HIST_DATA),
  };
}

// ── History download ─────────────────────────────────────────

export async function readHistoryCount(deviceId: string): Promise<number> {
  const raw = await BleManager.read(deviceId, SERVICE_UUID, CHAR_HIST_COUNT);
  return u32(raw, 0);
}

export async function downloadHistory(
  deviceId: string,
  onProgress: (received: number, total: number) => void,
): Promise<HistoryRecord[]> {
  const total = await readHistoryCount(deviceId);
  if (total === 0) return [];

  const records: HistoryRecord[] = [];

  return new Promise((resolve, reject) => {
    const sub = BleManager.onDidUpdateValueForCharacteristic(({ value, characteristic }) => {
      if (characteristic.toLowerCase() !== CHAR_HIST_DATA.toLowerCase()) return;

      // End-of-stream marker
      if (value.length === 1 && value[0] === 0xff) {
        sub.remove();
        resolve(records);
        return;
      }

      if (value.length === 38) {
        records.push(decodeHistoryRecord(value));
        onProgress(records.length, total);
      }
    });

    // Subscribe to notifications on the history data characteristic, then request from index 0
    BleManager.startNotification(deviceId, SERVICE_UUID, CHAR_HIST_DATA)
      .then(() => {
        // Write start index 0 as uint32 LE
        const cmd = [0, 0, 0, 0];
        return BleManager.write(deviceId, SERVICE_UUID, CHAR_HIST_DATA, cmd, 4);
      })
      .catch(err => { sub.remove(); reject(err); });

    // Safety timeout: 200 ms per record + 15 s base
    setTimeout(() => {
      sub.remove();
      if (records.length > 0) resolve(records);
      else reject(new Error('History download timed out'));
    }, total * 200 + 15000);
  });
}

export async function clearHistory(deviceId: string): Promise<void> {
  const cmd = [0xff, 0xff, 0xff, 0xff];
  await BleManager.write(deviceId, SERVICE_UUID, CHAR_HIST_DATA, cmd, 4);
}

export const isAndroid = Platform.OS === 'android';
