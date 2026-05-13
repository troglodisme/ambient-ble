import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  PermissionsAndroid,
  Platform,
  Pressable,
  ScrollView,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import AsyncStorage from '@react-native-async-storage/async-storage';

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
import { colors, spacing } from './src/theme';
import { sharedStyles as styles } from './src/styles';
import ReadingsView from './src/ReadingsView';
import SessionView from './src/SessionView';
import HistoryView from './src/HistoryView';
import MapView, { LiveReadings } from './src/MapView';

type ConnState = 'idle' | 'connecting' | 'connected' | 'error';
type Screen = 'live' | 'session' | 'history' | 'map';

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
  const [scanElapsed, setScanElapsed] = useState(0);

  const stopScanRef = useRef<(() => void) | null>(null);
  const disconnectRef = useRef<(() => Promise<void>) | null>(null);
  const scanTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
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

  function clearScanTimer() {
    if (scanTimerRef.current) { clearInterval(scanTimerRef.current); scanTimerRef.current = null; }
  }

  async function handleScan() {
    console.log('[App] handleScan start');
    setError(null);
    if (!(await requestAndroidPerms())) { setError('Bluetooth permissions denied'); return; }
    setDevices({});
    setScanning(true);
    setScanElapsed(0);
    clearScanTimer();
    scanTimerRef.current = setInterval(() => setScanElapsed(s => s + 1), 1000);
    try {
      const stop = await startScan(d => {
        console.log('[App] device discovered:', d.name, d.id);
        setDevices(prev => ({ ...prev, [d.id]: d }));
      });
      console.log('[App] scan running (auto-restarts every 10 s)');
      stopScanRef.current = stop;
      // Stop after 60 s total
      setTimeout(() => {
        stop(); stopScanRef.current = null;
        clearScanTimer(); setScanElapsed(0); setScanning(false);
      }, 60_000);
    } catch (e: any) {
      console.log('[App] scan error:', e);
      setError(e?.message ?? 'Scan failed');
      clearScanTimer(); setScanElapsed(0); setScanning(false);
    }
  }

  async function handleConnect(d: DiscoveredDevice) {
    console.log('[App] handleConnect:', d.name, d.id);
    stopScanRef.current?.();
    clearScanTimer(); setScanElapsed(0); setScanning(false);
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

  const { width: winW } = useWindowDimensions();
  const wide = winW >= 768;

  const liveReadings = readings.particles && readings.gases && readings.env ? {
    pm25: readings.particles.pm25,
    co2: readings.gases.co2,
    temperature: readings.env.temperature,
    humidity: readings.env.humidity,
  } : null;

  // Map tab takes full height — render outside ScrollView
  const showFullMap = selected && connState === 'connected' && screen === 'map';

  return (
    <View style={styles.safe}>
      <StatusBar style="dark" />

      {/* ── Map tab (full height, no scroll) ── */}
      {showFullMap && (
        <View style={{ flex: 1 }}>
          {/* Compact header strip */}
          <View style={[styles.deviceHeader, { borderRadius: 0, paddingTop: 0 }]}>
            <Text style={styles.cardTitle}>{selected.name}</Text>
            <View style={[s_row]}>
              {(['live', 'session', 'history', 'map'] as Screen[]).map(sc => (
                <Pressable
                  key={sc}
                  style={[styles.tab, screen === sc && styles.tabActive, { flex: 0, paddingHorizontal: spacing.md }]}
                  onPress={() => setScreen(sc)}
                >
                  <Text style={[styles.tabText, screen === sc && styles.tabTextActive]}>
                    {sc === 'history' && histCount > 0 ? `History (${histCount})` : sc.charAt(0).toUpperCase() + sc.slice(1)}
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>
          <MapView readings={liveReadings} />
        </View>
      )}

      {/* ── Everything else in a ScrollView ── */}
      {!showFullMap && (
      <ScrollView contentContainerStyle={[styles.container, wide && styles.containerWide]}>
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
                  {scanning
                    ? `Scanning… ${Math.floor(scanElapsed / 60)}:${String(scanElapsed % 60).padStart(2, '0')}`
                    : lastDevice ? 'Scan for other devices' : 'Scan for devices'}
                </Text>
              </Pressable>
              {scanning && <ActivityIndicator color={colors.orange} />}
            </View>

            {scanning && deviceList.length === 0 && scanElapsed >= 15 && (
              <View style={[styles.card, { gap: spacing.xs }]}>
                <Text style={{ color: colors.text, fontWeight: '600' }}>No boards found yet</Text>
                <Text style={styles.muted}>· Make sure the board is powered on</Text>
                <Text style={styles.muted}>· Check the white/amber LED is breathing</Text>
                <Text style={styles.muted}>· Move within 5 m of the board</Text>
                <Text style={styles.muted}>· Scan restarts automatically every 10 s</Text>
              </View>
            )}

            {scanning && deviceList.length > 0 && (
              <Text style={styles.muted}>
                Found {deviceList.length} device{deviceList.length !== 1 ? 's' : ''} · tap to connect
              </Text>
            )}

            {error && <Text style={styles.error}>{error}</Text>}

            {!scanning && deviceList.length === 0 && (
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
            {/* Device header — always full width */}
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
              wide ? (
                /* ── Wide layout: left panel (Live) + right panel (Session/History) ── */
                <View style={styles.wideLayout}>
                  {/* Left column — Live readings, always visible */}
                  <View style={styles.wideLeft}>
                    <Text style={styles.sectionTitle}>LIVE</Text>
                    <ReadingsView readings={readings} />
                  </View>

                  {/* Right column — tabbed Session / History / Map */}
                  <View style={styles.wideRight}>
                    <View style={styles.tabs}>
                      {(['session', 'history', 'map'] as Screen[]).map(sc => (
                        <Pressable
                          key={sc}
                          style={[styles.tab, screen === sc && styles.tabActive]}
                          onPress={() => setScreen(sc)}
                        >
                          <Text style={[styles.tabText, screen === sc && styles.tabTextActive]}>
                            {sc === 'history' && histCount > 0 ? `History (${histCount})` : sc.charAt(0).toUpperCase() + sc.slice(1)}
                          </Text>
                        </Pressable>
                      ))}
                    </View>

                    {screen === 'session' && <SessionView liveHistory={liveHistory} />}
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
                  </View>
                </View>
              ) : (
                /* ── Narrow layout: tabs ── */
                <>
                  <View style={styles.tabs}>
                    {(['live', 'session', 'history', 'map'] as Screen[]).map(sc => (
                      <Pressable
                        key={sc}
                        style={[styles.tab, screen === sc && styles.tabActive]}
                        onPress={() => setScreen(sc)}
                      >
                        <Text style={[styles.tabText, screen === sc && styles.tabTextActive]}>
                          {sc === 'history' && histCount > 0 ? `(${histCount})` : sc.charAt(0).toUpperCase() + sc.slice(1)}
                        </Text>
                      </Pressable>
                    ))}
                  </View>

                  {screen === 'live' && <ReadingsView readings={readings} />}
                  {screen === 'session' && <SessionView liveHistory={liveHistory} />}
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
              )
            )}
          </>
        )}
      </ScrollView>
      )}
    </View>
  );
}

// alias for inline use in map header
const s_row = { flexDirection: 'row' as const, gap: 4 };

