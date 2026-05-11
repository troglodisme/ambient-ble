import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  PermissionsAndroid,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';

import {
  DiscoveredDevice,
  HistoryRecord,
  Readings,
  clearHistory,
  connectAndSubscribe,
  downloadHistory,
  readHistoryCount,
  startScan,
} from './src/ble';
import { colors, radius, spacing } from './src/theme';

type ConnState = 'idle' | 'connecting' | 'connected' | 'error';
type Screen = 'live' | 'history';

export default function App() {
  const [devices, setDevices]       = useState<Record<string, DiscoveredDevice>>({});
  const [scanning, setScanning]     = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [connState, setConnState]   = useState<ConnState>('idle');
  const [readings, setReadings]     = useState<Readings>({});
  const [error, setError]           = useState<string | null>(null);
  const [screen, setScreen]         = useState<Screen>('live');
  const [histCount, setHistCount]   = useState<number>(0);
  const [history, setHistory]       = useState<HistoryRecord[]>([]);
  const [downloading, setDownloading]   = useState(false);
  const [dlProgress, setDlProgress] = useState<{ received: number; total: number } | null>(null);
  const [hasHistory, setHasHistory] = useState(false);

  const stopScanRef = useRef<(() => void) | null>(null);
  const disconnectRef = useRef<(() => Promise<void>) | null>(null);

  useEffect(() => {
    return () => { stopScanRef.current?.(); disconnectRef.current?.(); };
  }, []);

  async function requestAndroidPerms() {
    if (Platform.OS !== 'android') return true;
    const res = await PermissionsAndroid.requestMultiple([
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
    ]);
    return Object.values(res).every(v => v === 'granted');
  }

  async function handleScan() {
    setError(null);
    if (!(await requestAndroidPerms())) { setError('Bluetooth permissions denied'); return; }
    setDevices({});
    setScanning(true);
    try {
      const stop = await startScan(d => setDevices(prev => ({ ...prev, [d.id]: d })));
      stopScanRef.current = stop;
      setTimeout(() => { stop(); stopScanRef.current = null; setScanning(false); }, 30_000);
    } catch (e: any) {
      setError(e?.message ?? 'Scan failed');
      setScanning(false);
    }
  }

  async function handleConnect(d: DiscoveredDevice) {
    stopScanRef.current?.();
    setScanning(false);
    setSelectedId(d.id);
    setConnState('connecting');
    setReadings({});
    setHistory([]);
    setHistCount(0);
    setError(null);
    setScreen('live');
    try {
      const conn = await connectAndSubscribe(d.id, r => setReadings(r));
      disconnectRef.current = conn.disconnect;
      setHasHistory(conn.hasHistory ?? false);
      setConnState('connected');

      if (conn.hasHistory) {
        const count = await readHistoryCount(d.id);
        setHistCount(count);
      }
    } catch (e: any) {
      setError(e?.message ?? 'Connection failed');
      setConnState('error');
    }
  }

  async function handleDisconnect() {
    await disconnectRef.current?.();
    disconnectRef.current = null;
    setConnState('idle');
    setSelectedId(null);
    setReadings({});
    setScreen('live');
  }

  async function handleDownload() {
    if (!selectedId) return;
    setDownloading(true);
    setDlProgress({ received: 0, total: histCount });
    setHistory([]);
    try {
      const records = await downloadHistory(selectedId, (received, total) => {
        setDlProgress({ received, total });
      });
      setHistory(records);
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
            <View style={styles.row}>
              <Pressable
                style={[styles.button, scanning && styles.buttonDisabled]}
                onPress={handleScan}
                disabled={scanning}
              >
                <Text style={styles.buttonText}>
                  {scanning ? 'Scanning…' : 'Scan for devices'}
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
              </View>
              <Pressable style={styles.smallButton} onPress={handleDisconnect}>
                <Text style={styles.smallButtonText}>Disconnect</Text>
              </Pressable>
            </View>

            {error && <Text style={styles.error}>{error}</Text>}

            {connState === 'connecting' && (
              <ActivityIndicator color={colors.orange} style={{ marginTop: spacing.lg }} />
            )}

            {connState === 'connected' && (
              <>
                {/* Tab bar */}
                <View style={styles.tabs}>
                  <Pressable
                    style={[styles.tab, screen === 'live' && styles.tabActive]}
                    onPress={() => setScreen('live')}
                  >
                    <Text style={[styles.tabText, screen === 'live' && styles.tabTextActive]}>
                      Live
                    </Text>
                  </Pressable>
                  {hasHistory && (
                    <Pressable
                      style={[styles.tab, screen === 'history' && styles.tabActive]}
                      onPress={() => setScreen('history')}
                    >
                      <Text style={[styles.tabText, screen === 'history' && styles.tabTextActive]}>
                        History {histCount > 0 ? `(${histCount})` : ''}
                      </Text>
                    </Pressable>
                  )}
                </View>

                {screen === 'live' && <ReadingsView readings={readings} />}

                {screen === 'history' && (
                  <HistoryView
                    records={history}
                    count={histCount}
                    downloading={downloading}
                    progress={dlProgress}
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
        <Metric label="PM2.5" value={particles?.pm25.toFixed(1)} highlight />
        <Metric label="PM4"   value={particles?.pm4.toFixed(1)} />
        <Metric label="PM10"  value={particles?.pm10.toFixed(1)} />
      </Section>
      <Section title="Gases">
        <Metric label="CO₂" value={gases?.co2.toString()} unit="ppm" highlight />
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

function HistoryView({
  records, count, downloading, progress, onDownload, onClear,
}: {
  records: HistoryRecord[];
  count: number;
  downloading: boolean;
  progress: { received: number; total: number } | null;
  onDownload: () => void;
  onClear: () => void;
}) {
  if (count === 0) {
    return (
      <View style={styles.card}>
        <Text style={styles.muted}>No history stored yet. Records are saved every 60 s.</Text>
      </View>
    );
  }

  return (
    <View style={{ gap: spacing.md }}>
      <View style={styles.card}>
        <Text style={styles.sectionTitle}>{count} RECORDS ON DEVICE</Text>
        <View style={[styles.row, { marginTop: spacing.md }]}>
          <Pressable
            style={[styles.button, downloading && styles.buttonDisabled]}
            onPress={onDownload}
            disabled={downloading}
          >
            <Text style={styles.buttonText}>
              {downloading ? 'Downloading…' : 'Download'}
            </Text>
          </Pressable>
          {!downloading && records.length === 0 && (
            <Pressable style={styles.smallButton} onPress={onClear}>
              <Text style={styles.smallButtonText}>Clear</Text>
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

      {records.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{records.length} RECORDS DOWNLOADED</Text>
          {records.slice(-20).reverse().map((r, i) => (
            <HistoryRow key={i} record={r} />
          ))}
          {records.length > 20 && (
            <Text style={styles.muted}>Showing last 20 of {records.length}</Text>
          )}
        </View>
      )}
    </View>
  );
}

function HistoryRow({ record }: { record: HistoryRecord }) {
  const mins = Math.floor(record.ts / 60);
  const h    = Math.floor(mins / 60);
  const m    = mins % 60;
  const timeStr = `T+${h}h${String(m).padStart(2, '0')}m`;
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
  muted:            { color: colors.textMuted },
  error:            { color: '#FF3B30' },
});
