import { Platform } from 'react-native';
import BleManager, { Peripheral } from 'react-native-ble-manager';

export const SERVICE_UUID    = '12340001-1234-1234-1234-123456789abc';
export const CHAR_PARTICLES  = '12340010-1234-1234-1234-123456789abc';
export const CHAR_GASES      = '12340011-1234-1234-1234-123456789abc';
export const CHAR_ENV        = '12340012-1234-1234-1234-123456789abc';
export const CHAR_BATTERY    = '12340013-1234-1234-1234-123456789abc';
export const CHAR_HIST_COUNT = '12340020-1234-1234-1234-123456789abc';
export const CHAR_HIST_DATA  = '12340021-1234-1234-1234-123456789abc';
export const CHAR_SET_TIME   = '12340030-1234-1234-1234-123456789abc';

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

// ── Timestamp helper ─────────────────────────────────────────
// Records written by new firmware store real Unix seconds (ts > 1e9).
// Old firmware stores seconds-since-boot; fall back to anchor math.
export function getRecordMs(
  record: HistoryRecord,
  anchorMs: number,
  lastTs: number,
  timeOffset = 0,
): number {
  if (record.ts > 1_000_000_000) return record.ts * 1000;      // real Unix ts
  if (timeOffset > 0) return (timeOffset + record.ts) * 1000;  // derive from boot epoch
  return anchorMs > 0 ? anchorMs - (lastTs - record.ts) * 1000 : record.ts * 1000;
}

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
  console.log('[BLE] startScan: ensureStarted done');
  const sub = BleManager.onDiscoverPeripheral(p => {
    const name = p.name ?? p.advertising?.localName;
    console.log('[BLE] peripheral found:', p.id, 'name:', name ?? '(none)');
    if (!name?.startsWith(DEVICE_NAME_PREFIX)) return;
    console.log('[BLE] matched device:', name, p.id);
    onDevice({ id: p.id, name, rssi: p.rssi });
  });
  console.log('[BLE] calling BleManager.scan...');
  await BleManager.scan({ serviceUUIDs: [SERVICE_UUID], seconds: 30, allowDuplicates: true });
  console.log('[BLE] scan started');
  return () => { sub.remove(); BleManager.stopScan().catch(() => {}); };
}

// ── Connect + live subscribe ─────────────────────────────────

export async function connectAndSubscribe(
  deviceId: string,
  onUpdate: (r: Readings) => void,
  onStatus?: (s: string) => void,
) {
  console.log('[BLE] connectAndSubscribe:', deviceId);
  await ensureStarted();
  console.log('[BLE] connecting...');
  onStatus?.('Connecting to device…');
  await BleManager.connect(deviceId);
  console.log('[BLE] connected, retrieving services...');
  onStatus?.('Discovering services…');
  const info = await BleManager.retrieveServices(deviceId, [SERVICE_UUID]);
  console.log('[BLE] services retrieved. Characteristics:',
    info.characteristics?.map(c => c.characteristic));

  const has = (uuid: string) =>
    info.characteristics?.some(c => c.characteristic.toLowerCase() === uuid.toLowerCase());

  console.log('[BLE] hasHistory:', has(CHAR_HIST_COUNT) && has(CHAR_HIST_DATA),
    'hasBattery:', has(CHAR_BATTERY));

  let readings: Readings = {};
  const push = (patch: Partial<Readings>) => {
    readings = { ...readings, ...patch, updatedAt: Date.now() };
    onUpdate(readings);
  };

  const liveSub = BleManager.onDidUpdateValueForCharacteristic(({ value, characteristic }) => {
    const c = characteristic.toLowerCase();
    console.log('[BLE] notification from:', c, 'len:', value.length);
    if (c === CHAR_PARTICLES.toLowerCase())  push({ particles: decodeParticles(value) });
    else if (c === CHAR_GASES.toLowerCase()) push({ gases: decodeGases(value) });
    else if (c === CHAR_ENV.toLowerCase())   push({ env: decodeEnv(value) });
    else if (c === CHAR_BATTERY.toLowerCase()) push({ battery: decodeBattery(value) });
    else console.log('[BLE] unhandled characteristic:', c);
  });

  console.log('[BLE] subscribing to notifications...');
  onStatus?.('Subscribing to notifications…');
  await BleManager.startNotification(deviceId, SERVICE_UUID, CHAR_PARTICLES);
  console.log('[BLE] subscribed: particles');
  await BleManager.startNotification(deviceId, SERVICE_UUID, CHAR_GASES);
  console.log('[BLE] subscribed: gases');
  await BleManager.startNotification(deviceId, SERVICE_UUID, CHAR_ENV);
  console.log('[BLE] subscribed: env');
  if (has(CHAR_BATTERY)) {
    await BleManager.startNotification(deviceId, SERVICE_UUID, CHAR_BATTERY);
    console.log('[BLE] subscribed: battery');
  }

  let timeOffset = 0;
  if (has(CHAR_SET_TIME)) {
    onStatus?.('Syncing time…');
    const nowSec = Math.floor(Date.now() / 1000);
    const cmd = [nowSec & 0xff, (nowSec >> 8) & 0xff, (nowSec >> 16) & 0xff, (nowSec >> 24) & 0xff];
    await BleManager.write(deviceId, SERVICE_UUID, CHAR_SET_TIME, cmd, 4);
    // Brief pause so the firmware's BLE.poll() can process the write before we read back
    await new Promise<void>(r => setTimeout(r, 400));
    const raw = await BleManager.read(deviceId, SERVICE_UUID, CHAR_SET_TIME);
    timeOffset = u32(raw, 0);
    console.log('[BLE] time synced, boot epoch offset:', timeOffset);
  }

  return {
    disconnect: async () => {
      liveSub.remove();
      try { await BleManager.disconnect(deviceId); } catch {}
    },
    deviceId,
    hasBattery: has(CHAR_BATTERY),
    hasHistory: has(CHAR_HIST_COUNT) && has(CHAR_HIST_DATA),
    timeOffset,
  };
}

// ── History download ─────────────────────────────────────────

export async function readHistoryCount(deviceId: string): Promise<number> {
  const raw = await BleManager.read(deviceId, SERVICE_UUID, CHAR_HIST_COUNT);
  return u32(raw, 0);
}

export type DownloadResult = {
  records: HistoryRecord[];
  /** Wall-clock ms (Date.now()) captured at the moment streaming began.
   *  Combined with the last record's `ts`, lets callers compute real timestamps:
   *  realMs = anchorMs - (lastTs - record.ts) * 1000 */
  anchorMs: number;
};

export async function downloadHistory(
  deviceId: string,
  onProgress: (received: number, total: number) => void,
): Promise<DownloadResult> {
  const total = await readHistoryCount(deviceId);
  if (total === 0) return { records: [], anchorMs: Date.now() };

  const records: HistoryRecord[] = [];

  return new Promise((resolve, reject) => {
    const sub = BleManager.onDidUpdateValueForCharacteristic(({ value, characteristic }) => {
      if (characteristic.toLowerCase() !== CHAR_HIST_DATA.toLowerCase()) return;

      // End-of-stream marker
      if (value.length === 1 && value[0] === 0xff) {
        sub.remove();
        resolve({ records, anchorMs });
        return;
      }

      if (value.length === 38) {
        records.push(decodeHistoryRecord(value));
        onProgress(records.length, total);
      }
    });

    let anchorMs = Date.now();

    // Subscribe to notifications on the history data characteristic, then request from index 0
    BleManager.startNotification(deviceId, SERVICE_UUID, CHAR_HIST_DATA)
      .then(() => {
        anchorMs = Date.now();
        // Write start index 0 as uint32 LE
        const cmd = [0, 0, 0, 0];
        return BleManager.write(deviceId, SERVICE_UUID, CHAR_HIST_DATA, cmd, 4);
      })
      .catch(err => { sub.remove(); reject(err); });

    // Safety timeout: 200 ms per record + 15 s base
    setTimeout(() => {
      sub.remove();
      if (records.length > 0) resolve({ records, anchorMs });
      else reject(new Error('History download timed out'));
    }, total * 200 + 15000);
  });
}

// ── CSV export ───────────────────────────────────────────────

function toLocalISOString(date: Date): string {
  const off = -date.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const hh = String(Math.floor(Math.abs(off) / 60)).padStart(2, '0');
  const mm = String(Math.abs(off) % 60).padStart(2, '0');
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return `${local.toISOString().slice(0, 19)}${sign}${hh}:${mm}`;
}

export function recordsToCSV(records: HistoryRecord[], anchorMs: number, timeOffset = 0): string {
  const header = 'timestamp,ts_raw,pm1_ug_m3,pm25_ug_m3,pm4_ug_m3,pm10_ug_m3,co2_ppm,voc_index,nox_index,temperature_c,humidity_pct';
  const lastTs = records.length > 0 ? records[records.length - 1].ts : 0;
  const rows = records.map(r => {
    const realMs = getRecordMs(r, anchorMs, lastTs, timeOffset);
    const iso = toLocalISOString(new Date(realMs));
    return [
      iso, r.ts,
      r.pm1.toFixed(2), r.pm25.toFixed(2), r.pm4.toFixed(2), r.pm10.toFixed(2),
      r.co2,
      r.voc.toFixed(1), r.nox.toFixed(1),
      r.temperature.toFixed(2), r.humidity.toFixed(2),
    ].join(',');
  });
  return [header, ...rows].join('\n');
}

export async function clearHistory(deviceId: string): Promise<void> {
  const cmd = [0xff, 0xff, 0xff, 0xff];
  await BleManager.write(deviceId, SERVICE_UUID, CHAR_HIST_DATA, cmd, 4);
}

export const isAndroid = Platform.OS === 'android';
