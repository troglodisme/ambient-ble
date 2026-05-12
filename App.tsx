import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  PermissionsAndroid,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  DiscoveredDevice,
  HistoryRecord,
  Readings,
  clearHistory,
  connectAndSubscribe,
  downloadHistory,
  getRecordMs,
  readHistoryCount,
  recordsToCSV,
  startScan,
} from './src/ble';
import HistoryChart from './src/HistoryChart';
import { colors, radius, spacing } from './src/theme';

type ConnState = 'idle' | 'connecting' | 'connected' | 'error';
type Screen = 'live' | 'session' | 'history';

export default function App() {
  const [devices, setDevices]       = useState<Record<string, DiscoveredDevice>>({});
  const [scanning, setScanning]     = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [connState, setConnState]   = useState<ConnState>('idle');
  const [connStatus, setConnStatus] = useState<string>('');
  const [readings, setReadings]     = useState<Readings>({});
  const [error, setError]           = useState<string | null>(null);
  const [screen, setScreen]         = useState<Screen>('live');
  const [histCount, setHistCount]   = useState<number>(0);
  const [history, setHistory]       = useState<HistoryRecord[]>([]);
  const [lastDevice, setLastDevice] = useState<DiscoveredDevice | null>(null);
  const [downloading, setDownloading]   = useState(false);
  const [dlProgress, setDlProgress] = useState<{ received: number; total: number } | null>(null);
  const [hasHistory, setHasHistory] = useState(false);
  const [anchorMs, setAnchorMs] = useState<number>(0);
  const [timeOffset, setTimeOffset] = useState<number>(0);
  const [liveHistory, setLiveHistory] = useState<HistoryRecord[]>([]);

  const stopScanRef = useRef<(() => void) | null>(null);
  const disconnectRef = useRef<(() => Promise<void>) | null>(null);
  const lastLiveTs = useRef<number>(0);

  useEffect(() => {
    return () => { stopScanRef.current?.(); disconnectRef.current?.(); };
  }, []);

  // Load last connected device from storage on mount
  useEffect(() => {
    AsyncStorage.getItem('lastDevice').then(val => {
      if (val) setLastDevice(JSON.parse(val));
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!readings.particles || !readings.gases || !readings.env) return;
    const nowSec = Math.floor(Date.now() / 1000);
    if (nowSec <= lastLiveTs.current) return;
    lastLiveTs.current = nowSec;
    const rec: HistoryRecord = {
      ts: nowSec,
      pm1: readings.particles.pm1, pm25: readings.particles.pm25,
      pm4: readings.particles.pm4, pm10: readings.particles.pm10,
      co2: readings.gases.co2, voc: readings.gases.voc, nox: readings.gases.nox,
      temperature: readings.env.temperature, humidity: readings.env.humidity,
    };
    setLiveHistory(prev => {
      const next = [...prev, rec];
      return next.length > 600 ? next.slice(-600) : next;
    });
  }, [readings.updatedAt]);

  async function requestAndroidPerms() {
    if (Platform.OS !== 'android') return true;
    const res = await PermissionsAndroid.requestMultiple([
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
    ]);
    return Object.values(res).every(v => v === 'granted');
  }

  async function handleScan() {
    console.log('[App] handleScan start');
    setError(null);
    if (!(await requestAndroidPerms())) { setError('Bluetooth permissions denied'); return; }
    setDevices({});
    setScanning(true);
    try {
      const stop = await startScan(d => {
        console.log('[App] device discovered:', d.name, d.id);
        setDevices(prev => ({ ...prev, [d.id]: d }));
      });
      console.log('[App] scan running (auto-restarts every 10 s)');
      stopScanRef.current = stop;
      // Stop after 60 s total
      setTimeout(() => { stop(); stopScanRef.current = null; setScanning(false); }, 60_000);
    } catch (e: any) {
      console.log('[App] scan error:', e);
      setError(e?.message ?? 'Scan failed');
      setScanning(false);
    }
  }

  async function handleConnect(d: DiscoveredDevice) {
    console.log('[App] handleConnect:', d.name, d.id);
    stopScanRef.current?.();
    setScanning(false);
    // Remember this device for next time
    AsyncStorage.setItem('lastDevice', JSON.stringify(d)).catch(() => {});
    setLastDevice(d);
    // Make sure it's in the devices map so `selected` resolves
    setDevices(prev => ({ ...prev, [d.id]: d }));
    setSelectedId(d.id);
    setConnState('connecting');
    setConnStatus('Connecting…');
    setReadings({});
    setHistory([]);
    setHistCount(0);
    setError(null);
    setScreen('live');
    try {
      const conn = await connectAndSubscribe(d.id, r => {
        console.log('[App] readings update:', JSON.stringify(r));
        setReadings(r);
      }, setConnStatus);
      disconnectRef.current = conn.disconnect;
      setHasHistory(conn.hasHistory ?? false);
      setTimeOffset(conn.timeOffset ?? 0);
      console.log('[App] connected. hasHistory:', conn.hasHistory, 'hasBattery:', conn.hasBattery, 'timeOffset:', conn.timeOffset);
      setConnState('connected');
      setConnStatus('');

      if (conn.hasHistory) {
        const count = await readHistoryCount(d.id);
        console.log('[App] history count:', count);
        setHistCount(count);
      }
    } catch (e: any) {
      console.log('[App] connect error:', e);
      setError(e?.message ?? 'Connection failed');
      setConnState('error');
      setConnStatus('');
    }
  }

  async function handleDisconnect() {
    await disconnectRef.current?.();
    disconnectRef.current = null;
    setConnState('idle');
    setSelectedId(null);
    setReadings({});
    setScreen('live');
    setLiveHistory([]);
    lastLiveTs.current = 0;
    setTimeOffset(0);
    // Don't clear lastDevice — keep it for quick reconnect
  }

  async function handleDownload() {
    if (!selectedId) return;
    setDownloading(true);
    setDlProgress({ received: 0, total: histCount });
    setHistory([]);
    try {
      const result = await downloadHistory(selectedId, (received, total) => {
        setDlProgress({ received, total });
      });
      setHistory(result.records);
      setAnchorMs(result.anchorMs);
    } catch (e: any) {
      setError(e?.message ?? 'Download failed');
    } finally {
      setDownloading(false);
      setDlProgress(null);
    }
  }

  async function handleClearHistory() {
    if (!selectedId) return;
    await clearHistory(selectedId);
    setHistCount(0);
    setHistory([]);
  }

  const selected    = selectedId ? devices[selectedId] : null;
  const deviceList  = Object.values(devices).sort((a, b) =>
    (a.name ?? '').localeCompare(b.name ?? '')
  );

  return (
    <View style={styles.safe}>
      <StatusBar style="dark" />
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.brand}>AMBIENT BLE</Text>

        {/* ── Scan / device list ── */}
        {!selected && (
          <>
            {/* Last device quick-connect */}
            {lastDevice && connState === 'idle' && (
              <Pressable
                style={[styles.button, { marginBottom: spacing.sm }]}
                onPress={() => handleConnect(lastDevice)}
              >
                <Text style={styles.buttonText}>Connect to {lastDevice.name ?? lastDevice.id}</Text>
              </Pressable>
            )}

            <View style={styles.row}>
              <Pressable
                style={[styles.button, styles.buttonSecondary, scanning && styles.buttonDisabled]}
                onPress={handleScan}
                disabled={scanning}
              >
                <Text style={[styles.buttonText, { color: colors.text }]}>
                  {scanning ? 'Scanning…' : lastDevice ? 'Scan for other devices' : 'Scan for devices'}
                </Text>
              </Pressable>
              {scanning && <ActivityIndicator color={colors.orange} />}
            </View>

            {error && <Text style={styles.error}>{error}</Text>}

            {deviceList.length === 0 && !scanning && (
              <Text style={styles.muted}>Tap scan to find nearby Ambient Edu boards.</Text>
            )}

            {deviceList.map(d => (
              <Pressable key={d.id} style={styles.card} onPress={() => handleConnect(d)}>
                <Text style={styles.cardTitle}>{d.name}</Text>
                <Text style={styles.cardMeta}>
                  {d.id}{d.rssi != null ? ` · ${d.rssi} dBm` : ''}
                </Text>
              </Pressable>
            ))}
          </>
        )}

        {/* ── Connected device ── */}
        {selected && (
          <>
            <View style={styles.deviceHeader}>
              <View>
                <Text style={styles.cardTitle}>{selected.name}</Text>
                <Text style={[
                  styles.cardMeta,
                  connState === 'connected' && { color: colors.good },
                  connState === 'error' && { color: colors.poor },
                ]}>
                  {connState === 'connecting' ? 'Connecting…' : connState}
                </Text>
                {connState === 'connected' && (
                  <Text style={[styles.cardMeta, { color: timeOffset > 0 ? colors.good : colors.fair }]}>
                    {timeOffset > 0 ? '✓ Time synced' : '⚠ Time not set'}
                  </Text>
                )}
              </View>
              <Pressable style={styles.smallButton} onPress={handleDisconnect}>
                <Text style={styles.smallButtonText}>Disconnect</Text>
              </Pressable>
            </View>

            {error && <Text style={styles.error}>{error}</Text>}

            {connState === 'connecting' && (
              <View style={{ alignItems: 'center', marginTop: spacing.lg }}>
                <ActivityIndicator color={colors.orange} />
                {connStatus ? <Text style={[styles.cardMeta, { marginTop: spacing.sm }]}>{connStatus}</Text> : null}
              </View>
            )}

            {connState === 'connected' && (
              <>
                {/* Tab bar */}
                <View style={styles.tabs}>
                  <Pressable
                    style={[styles.tab, screen === 'live' && styles.tabActive]}
                    onPress={() => setScreen('live')}
                  >
                    <Text style={[styles.tabText, screen === 'live' && styles.tabTextActive]}>Live</Text>
                  </Pressable>
                  <Pressable
                    style={[styles.tab, screen === 'session' && styles.tabActive]}
                    onPress={() => setScreen('session')}
                  >
                    <Text style={[styles.tabText, screen === 'session' && styles.tabTextActive]}>Session</Text>
                  </Pressable>
                  <Pressable
                    style={[styles.tab, screen === 'history' && styles.tabActive]}
                    onPress={() => setScreen('history')}
                  >
                    <Text style={[styles.tabText, screen === 'history' && styles.tabTextActive]}>
                      History {histCount > 0 ? `(${histCount})` : ''}
                    </Text>
                  </Pressable>
                </View>

                {screen === 'live' && <ReadingsView readings={readings} />}

                {screen === 'session' && (
                  <SessionView liveHistory={liveHistory} />
                )}

                {screen === 'history' && (
                  <HistoryView
                    records={history}
                    count={histCount}
                    downloading={downloading}
                    progress={dlProgress}
                    anchorMs={anchorMs}
                    timeOffset={timeOffset}
                    onDownload={handleDownload}
                    onClear={handleClearHistory}
                  />
                )}
              </>
            )}
          </>
        )}
      </ScrollView>
    </View>
  );
}

// ── Live readings ─────────────────────────────────────────────

function ReadingsView({ readings }: { readings: Readings }) {
  const { particles, gases, env, battery } = readings;
  if (!readings.updatedAt) {
    return <Text style={styles.muted}>Waiting for data…</Text>;
  }
  return (
    <View style={{ gap: spacing.md }}>
      <Section title="Environment">
        <Metric label="Temp"     value={env?.temperature.toFixed(1)} unit="°C" />
        <Metric label="Humidity" value={env?.humidity.toFixed(1)}    unit="%" />
      </Section>
      <Section title="Particles (µg/m³)">
        <Metric label="PM1"   value={particles?.pm1.toFixed(1)} />
        <Metric label="PM2.5" value={particles?.pm25.toFixed(1)} />
        <Metric label="PM4"   value={particles?.pm4.toFixed(1)} />
        <Metric label="PM10"  value={particles?.pm10.toFixed(1)} />
      </Section>
      <Section title="Gases">
        <Metric label="CO₂" value={gases?.co2.toString()} unit="ppm" />
        <Metric label="VOC" value={gases?.voc.toFixed(1)} unit="idx" />
        <Metric label="NOx" value={gases?.nox.toFixed(1)} unit="idx" />
      </Section>
      {battery && (
        <Section title="Battery">
          <Metric label="SoC"   value={battery.soc.toFixed(0)} unit="%" />
          <Metric label="Volts" value={battery.volts.toFixed(2)} unit="V" />
        </Section>
      )}
    </View>
  );
}

// ── History ───────────────────────────────────────────────────

function SessionView({ liveHistory }: { liveHistory: HistoryRecord[] }) {
  if (liveHistory.length < 2) {
    return (
      <View style={styles.card}>
        <View style={[styles.row, { gap: spacing.sm }]}>
          <View style={styles.liveBadge}><Text style={styles.liveBadgeText}>● LIVE</Text></View>
          <Text style={styles.cardTitle}>This Session</Text>
        </View>
        <Text style={[styles.muted, { marginTop: spacing.sm }]}>Readings will appear here once sensor data arrives…</Text>
      </View>
    );
  }
  return (
    <View style={styles.section}>
      <View style={[styles.row, { justifyContent: 'space-between' }]}>
        <Text style={styles.cardTitle}>This Session</Text>
        <View style={styles.liveBadge}><Text style={styles.liveBadgeText}>● LIVE</Text></View>
      </View>
      <Text style={[styles.cardMeta, { marginTop: 2, marginBottom: spacing.sm }]}>
        {liveHistory.length} reading{liveHistory.length !== 1 ? 's' : ''} · 1 per second
      </Text>
      <HistoryChart records={liveHistory} anchorMs={0} timeOffset={0} />
    </View>
  );
}

function HistoryView({
  records, count, downloading, progress, anchorMs, timeOffset, onDownload, onClear,
}: {
  records: HistoryRecord[];
  count: number;
  downloading: boolean;
  progress: { received: number; total: number } | null;
  anchorMs: number;
  timeOffset: number;
  onDownload: () => void;
  onClear: () => void;
}) {
  const hasDevice = count > 0;
  const hasDownloaded = records.length > 0;

  if (!hasDevice && !hasDownloaded) {
    return (
      <View style={styles.card}>
        <Text style={styles.muted}>No device history yet — records are saved every 60 s.</Text>
      </View>
    );
  }

  return (
    <View style={{ gap: spacing.md }}>
      {/* ── On-device card ── */}
      {hasDevice && (
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>ON DEVICE</Text>
          <Text style={[styles.cardMeta, { marginTop: 2, marginBottom: spacing.md }]}>
            {count} record{count !== 1 ? 's' : ''} · saved every 60 s
          </Text>
          <View style={styles.row}>
            <Pressable
              style={[styles.button, downloading && styles.buttonDisabled]}
              onPress={onDownload}
              disabled={downloading}
            >
              <Text style={styles.buttonText}>
                {downloading ? 'Downloading…' : 'Download to app'}
              </Text>
            </Pressable>
            {!downloading && (
              <Pressable style={styles.smallButton} onPress={onClear}>
                <Text style={styles.smallButtonText}>Clear device</Text>
              </Pressable>
            )}
            {downloading && <ActivityIndicator color={colors.orange} />}
          </View>

          {downloading && progress && (
            <View style={{ marginTop: spacing.md }}>
              <View style={styles.progressTrack}>
                <View style={[
                  styles.progressFill,
                  { width: `${(progress.received / progress.total) * 100}%` as any }
                ]} />
              </View>
              <Text style={[styles.cardMeta, { marginTop: spacing.xs }]}>
                {progress.received} / {progress.total}
              </Text>
            </View>
          )}
        </View>
      )}

      {/* ── Downloaded data card ── */}
      {hasDownloaded && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>DOWNLOADED TO APP</Text>
          <Text style={[styles.cardMeta, { marginTop: 2 }]}>
            {records.length} record{records.length !== 1 ? 's' : ''}
          </Text>
          {timeOffset === 0 && (
            <View style={[styles.warningBanner, { marginTop: spacing.sm }]}>
              <Text style={styles.warningText}>
                ⚠️ Timestamps are estimated — connect again with new firmware for accurate time sync
              </Text>
            </View>
          )}
          <ExportButton records={records} anchorMs={anchorMs} timeOffset={timeOffset} />
          {records.length >= 2 && <HistoryChart records={records} anchorMs={anchorMs} timeOffset={timeOffset} />}
          {records.slice(-20).reverse().map((r, i) => (
            <HistoryRow key={i} record={r} anchorMs={anchorMs} timeOffset={timeOffset} lastTs={records[records.length - 1].ts} />
          ))}
          {records.length > 20 && (
            <Text style={styles.muted}>Showing last 20 of {records.length}</Text>
          )}
        </View>
      )}
    </View>
  );
}

function ExportButton({ records, anchorMs, timeOffset }: { records: HistoryRecord[]; anchorMs: number; timeOffset: number }) {
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  async function handleExport() {
    setExporting(true);
    setExportError(null);
    try {
      const csv = recordsToCSV(records, anchorMs, timeOffset);
      const date = new Date(anchorMs > 0 ? anchorMs : Date.now())
        .toISOString().slice(0, 16).replace('T', '_').replace(':', '-');
      const filename = `ambient_${date}.csv`;
      const dir = FileSystem.cacheDirectory || FileSystem.documentDirectory;
      if (dir) {
        // Write a real .csv file and share it
        const path = dir + filename;
        await FileSystem.writeAsStringAsync(path, csv, { encoding: FileSystem.EncodingType.UTF8 });
        await Sharing.shareAsync(path, {
          mimeType: 'text/csv',
          dialogTitle: filename,
          UTI: 'public.comma-separated-values-text',
        });
      } else {
        // Fallback: share as plain text (saves as .txt but content is valid CSV)
        await Share.share({ message: csv, title: filename });
      }
    } catch (e: any) {
      if (e?.message !== 'The user did not share') {
        console.log('[Export] error:', e);
        setExportError(e?.message ?? 'Export failed');
      }
    } finally {
      setExporting(false);
    }
  }

  return (
    <View>
      <Pressable
        style={[styles.smallButton, exporting && styles.buttonDisabled, { marginBottom: exportError ? spacing.xs : spacing.sm }]}
        onPress={handleExport}
        disabled={exporting}
      >
        <Text style={styles.smallButtonText}>{exporting ? 'Exporting…' : 'Export CSV'}</Text>
      </Pressable>
      {exportError && <Text style={[styles.error, { fontSize: 12, marginBottom: spacing.sm }]}>{exportError}</Text>}
    </View>
  );
}

function HistoryRow({ record, anchorMs, timeOffset, lastTs }: { record: HistoryRecord; anchorMs: number; timeOffset: number; lastTs: number }) {
  const realMs = getRecordMs(record, anchorMs, lastTs, timeOffset);
  const d = new Date(realMs);
  const isReal = record.ts > 1_000_000_000 || timeOffset > 0;
  const timeStr = isReal
    ? `${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}`
    : anchorMs > 0
      ? `~${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}`
      : `T+${Math.floor(record.ts/3600)}h${String(Math.floor((record.ts%3600)/60)).padStart(2,'0')}m`;
  return (
    <View style={styles.historyRow}>
      <Text style={styles.historyTime}>{timeStr}</Text>
      <Text style={styles.historyValue}>PM2.5 {record.pm25.toFixed(1)}</Text>
      <Text style={styles.historyValue}>CO₂ {record.co2}</Text>
      <Text style={styles.historyValue}>{record.temperature.toFixed(1)}°C</Text>
    </View>
  );
}

// ── Primitives ────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title.toUpperCase()}</Text>
      <View style={styles.grid}>{children}</View>
    </View>
  );
}

function Metric({
  label, value, unit, highlight,
}: {
  label: string; value?: string; unit?: string; highlight?: boolean;
}) {
  return (
    <View style={styles.metric}>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text style={[styles.metricValue, highlight && { color: colors.orange }]}>
        {value ?? '—'}
        {value && unit ? <Text style={styles.metricUnit}> {unit}</Text> : null}
      </Text>
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safe:             { flex: 1, backgroundColor: colors.bg, paddingTop: 60 },
  container:        { padding: spacing.lg, gap: spacing.md },
  brand:            { fontSize: 14, letterSpacing: 2, color: colors.textMuted, fontWeight: '600', marginBottom: spacing.sm },
  row:              { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  button:           { backgroundColor: colors.orange, paddingHorizontal: spacing.lg, paddingVertical: spacing.md, borderRadius: radius.md },
  buttonSecondary:  { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border },
  buttonDisabled:   { opacity: 0.6 },
  buttonText:       { color: '#fff', fontWeight: '600' },
  smallButton:      { paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card },
  smallButtonText:  { color: colors.text, fontWeight: '500' },
  card:             { backgroundColor: colors.card, padding: spacing.lg, borderRadius: radius.lg },
  cardTitle:        { fontSize: 18, fontWeight: '600', color: colors.text },
  cardMeta:         { fontSize: 12, color: colors.textMuted, marginTop: 2 },
  deviceHeader:     { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: colors.card, padding: spacing.lg, borderRadius: radius.lg },
  tabs:             { flexDirection: 'row', gap: spacing.sm },
  tab:              { flex: 1, paddingVertical: spacing.sm, borderRadius: radius.md, backgroundColor: colors.card, alignItems: 'center' },
  tabActive:        { backgroundColor: colors.orange },
  tabText:          { color: colors.textMuted, fontWeight: '600' },
  tabTextActive:    { color: '#fff' },
  section:          { backgroundColor: colors.card, padding: spacing.lg, borderRadius: radius.lg, gap: spacing.md },
  sectionTitle:     { fontSize: 11, letterSpacing: 1, color: colors.textMuted, fontWeight: '600' },
  grid:             { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
  metric:           { minWidth: '45%', flexGrow: 1 },
  metricLabel:      { fontSize: 12, color: colors.textMuted },
  metricValue:      { fontSize: 28, fontVariant: ['tabular-nums'], color: colors.text, fontWeight: '600' },
  metricUnit:       { fontSize: 14, color: colors.textMuted, fontWeight: '400' },
  historyRow:       { flexDirection: 'row', gap: spacing.md, paddingVertical: spacing.xs, borderBottomWidth: 1, borderBottomColor: colors.border },
  historyTime:      { fontSize: 12, color: colors.textMuted, width: 70 },
  historyValue:     { fontSize: 12, color: colors.text, flex: 1 },
  progressTrack:    { height: 4, backgroundColor: colors.border, borderRadius: 2 },
  progressFill:     { height: 4, backgroundColor: colors.orange, borderRadius: 2 },
  warningBanner:    { backgroundColor: '#FFF9E6', borderRadius: radius.sm, padding: spacing.md, borderLeftWidth: 3, borderLeftColor: '#FFCC00' },
  warningText:      { fontSize: 12, color: '#7A5F00' },
  muted:            { color: colors.textMuted },
  error:            { color: '#FF3B30' },
  liveBadge:        { paddingHorizontal: spacing.sm, paddingVertical: 2, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.good },
  liveBadgeText:    { color: colors.good, fontSize: 10, fontWeight: '700' },
});
