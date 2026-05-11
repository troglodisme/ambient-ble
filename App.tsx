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
import { SafeAreaView } from 'react-native';

import {
  DiscoveredDevice,
  Readings,
  connectAndSubscribe,
  startScan,
} from './src/ble';
import { colors, radius, spacing } from './src/theme';

type ConnState = 'idle' | 'connecting' | 'connected' | 'error';

export default function App() {
  const [devices, setDevices] = useState<Record<string, DiscoveredDevice>>({});
  const [scanning, setScanning] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [connState, setConnState] = useState<ConnState>('idle');
  const [readings, setReadings] = useState<Readings>({});
  const [error, setError] = useState<string | null>(null);
  const stopScanRef = useRef<(() => void) | null>(null);
  const stopSubRef = useRef<(() => Promise<void>) | null>(null);

  useEffect(() => {
    return () => {
      stopScanRef.current?.();
      stopSubRef.current?.();
    };
  }, []);

  async function requestAndroidPerms() {
    if (Platform.OS !== 'android') return true;
    const res = await PermissionsAndroid.requestMultiple([
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
    ]);
    return Object.values(res).every((v) => v === 'granted');
  }

  async function handleScan() {
    setError(null);
    if (!(await requestAndroidPerms())) {
      setError('Bluetooth permissions denied');
      return;
    }
    setDevices({});
    setScanning(true);
    try {
      const stop = await startScan((d) => {
        setDevices((prev) => ({ ...prev, [d.id]: d }));
      });
      stopScanRef.current = stop;
      setTimeout(() => {
        stop();
        stopScanRef.current = null;
        setScanning(false);
      }, 30_000);
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
    setError(null);
    try {
      const stop = await connectAndSubscribe(d.id, (r) => setReadings(r));
      stopSubRef.current = stop;
      setConnState('connected');
    } catch (e: any) {
      setError(e?.message ?? 'Connection failed');
      setConnState('error');
    }
  }

  async function handleDisconnect() {
    await stopSubRef.current?.();
    stopSubRef.current = null;
    setConnState('idle');
    setSelectedId(null);
    setReadings({});
  }

  const selected = selectedId ? devices[selectedId] : null;
  const deviceList = Object.values(devices).sort((a, b) =>
    (a.name ?? '').localeCompare(b.name ?? '')
  );

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style="dark" />
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.brand}>AMBIENT BLE</Text>

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
              <Text style={styles.muted}>
                Tap scan to find nearby Ambient Edu boards.
              </Text>
            )}

            {deviceList.map((d) => (
              <Pressable
                key={d.id}
                style={styles.card}
                onPress={() => handleConnect(d)}
              >
                <Text style={styles.cardTitle}>{d.name}</Text>
                <Text style={styles.cardMeta}>
                  {d.id} {d.rssi != null ? `• ${d.rssi} dBm` : ''}
                </Text>
              </Pressable>
            ))}
          </>
        )}

        {selected && (
          <>
            <View style={styles.deviceHeader}>
              <View>
                <Text style={styles.cardTitle}>{selected.name}</Text>
                <Text style={styles.cardMeta}>
                  {connState === 'connecting' && 'Connecting…'}
                  {connState === 'connected' && 'Connected'}
                  {connState === 'error' && 'Error'}
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

            {connState === 'connected' && <ReadingsView readings={readings} />}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function ReadingsView({ readings }: { readings: Readings }) {
  const { particles, gases, env, battery } = readings;
  return (
    <View style={{ gap: spacing.md }}>
      <Section title="Environment">
        <Metric label="Temp" value={env?.temperature.toFixed(1)} unit="°C" />
        <Metric label="Humidity" value={env?.humidity.toFixed(1)} unit="%" />
      </Section>

      <Section title="Particles (µg/m³)">
        <Metric label="PM1" value={particles?.pm1.toFixed(1)} />
        <Metric label="PM2.5" value={particles?.pm25.toFixed(1)} />
        <Metric label="PM4" value={particles?.pm4.toFixed(1)} />
        <Metric label="PM10" value={particles?.pm10.toFixed(1)} />
      </Section>

      <Section title="Gases">
        <Metric label="CO₂" value={gases?.co2.toString()} unit="ppm" />
        <Metric label="VOC" value={gases?.voc.toFixed(1)} unit="idx" />
        <Metric label="NOx" value={gases?.nox.toFixed(1)} unit="idx" />
      </Section>

      {battery && (
        <Section title="Battery">
          <Metric label="SoC" value={battery.soc.toFixed(0)} unit="%" />
          <Metric label="V" value={battery.volts.toFixed(2)} unit="V" />
        </Section>
      )}
    </View>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title.toUpperCase()}</Text>
      <View style={styles.grid}>{children}</View>
    </View>
  );
}

function Metric({ label, value, unit }: { label: string; value?: string; unit?: string }) {
  return (
    <View style={styles.metric}>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text style={styles.metricValue}>
        {value ?? '—'}
        {value && unit ? <Text style={styles.metricUnit}> {unit}</Text> : null}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  container: { padding: spacing.lg, gap: spacing.md },
  brand: {
    fontSize: 14,
    letterSpacing: 2,
    color: colors.textMuted,
    fontWeight: '600',
    marginBottom: spacing.sm,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  button: {
    backgroundColor: colors.orange,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
  },
  buttonDisabled: { opacity: 0.6 },
  buttonText: { color: '#fff', fontWeight: '600' },
  smallButton: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
  },
  smallButtonText: { color: colors.text, fontWeight: '500' },
  card: {
    backgroundColor: colors.card,
    padding: spacing.lg,
    borderRadius: radius.lg,
  },
  cardTitle: { fontSize: 18, fontWeight: '600', color: colors.text },
  cardMeta: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
  deviceHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: colors.card,
    padding: spacing.lg,
    borderRadius: radius.lg,
  },
  section: {
    backgroundColor: colors.card,
    padding: spacing.lg,
    borderRadius: radius.lg,
    gap: spacing.md,
  },
  sectionTitle: { fontSize: 11, letterSpacing: 1, color: colors.textMuted, fontWeight: '600' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
  metric: { minWidth: '45%', flexGrow: 1 },
  metricLabel: { fontSize: 12, color: colors.textMuted },
  metricValue: {
    fontSize: 28,
    fontVariant: ['tabular-nums'],
    color: colors.text,
    fontWeight: '600',
  },
  metricUnit: { fontSize: 14, color: colors.textMuted, fontWeight: '400' },
  muted: { color: colors.textMuted },
  error: { color: '#FF3B30' },
});
