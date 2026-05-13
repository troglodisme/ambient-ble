import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Pressable,
  ScrollView,
  Text,
  View,
} from 'react-native';
import MapView, { Circle, Callout, Marker, Region, PROVIDER_DEFAULT } from 'react-native-maps';
import * as Location from 'expo-location';

import { colors, radius, spacing } from './theme';
import { sharedStyles as s } from './styles';

export type TaggedReading = {
  id: number;
  lat: number;
  lon: number;
  pm25: number;
  co2: number;
  temperature: number;
  humidity?: number;
  capturedAt: number; // ms
};

export type LiveReadings = {
  pm25: number;
  co2: number;
  temperature: number;
  humidity?: number;
};

// ── Helpers ───────────────────────────────────────────────────

function qualityColor(pm25: number): string {
  if (pm25 <= 12) return colors.good;
  if (pm25 <= 35) return colors.fair;
  if (pm25 <= 55) return colors.poor;
  return colors.toxic;
}

function qualityLabel(pm25: number): string {
  if (pm25 <= 12) return 'Good';
  if (pm25 <= 35) return 'Moderate';
  if (pm25 <= 55) return 'Unhealthy (SG)';
  return 'Unhealthy';
}

function fmtTime(ms: number) {
  const d = new Date(ms);
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
}

// ── Reading marker on map ──────────────────────────────────────

function ReadingMarker({ tag, onRemove }: { tag: TaggedReading; onRemove: () => void }) {
  const color = qualityColor(tag.pm25);
  return (
    <Marker coordinate={{ latitude: tag.lat, longitude: tag.lon }} tracksViewChanges={false}>
      {/* Colored dot */}
      <View style={[markerStyles.dot, { backgroundColor: color }]}>
        <Text style={markerStyles.dotText}>{tag.pm25.toFixed(0)}</Text>
      </View>

      {/* Callout (tap the marker) */}
      <Callout tooltip onPress={onRemove}>
        <View style={markerStyles.callout}>
          <View style={[markerStyles.calloutBar, { backgroundColor: color }]} />
          <View style={markerStyles.calloutBody}>
            <Text style={markerStyles.calloutTitle}>{qualityLabel(tag.pm25)}</Text>
            <Text style={markerStyles.calloutMeta}>{fmtTime(tag.capturedAt)}</Text>
            <View style={markerStyles.calloutRow}>
              <Text style={markerStyles.calloutLabel}>PM2.5</Text>
              <Text style={[markerStyles.calloutValue, { color }]}>{tag.pm25.toFixed(1)} µg/m³</Text>
            </View>
            <View style={markerStyles.calloutRow}>
              <Text style={markerStyles.calloutLabel}>CO₂</Text>
              <Text style={markerStyles.calloutValue}>{tag.co2} ppm</Text>
            </View>
            <View style={markerStyles.calloutRow}>
              <Text style={markerStyles.calloutLabel}>Temp</Text>
              <Text style={markerStyles.calloutValue}>{tag.temperature.toFixed(1)}°C</Text>
            </View>
            <Text style={markerStyles.calloutRemove}>Tap to remove ✕</Text>
          </View>
        </View>
      </Callout>
    </Marker>
  );
}

// ── Bottom sheet — live readings + tag button ─────────────────

function BottomSheet({
  readings,
  tagging,
  autoMode,
  tagCount,
  locError,
  onTag,
  onToggleAuto,
  onClearAll,
}: {
  readings: LiveReadings | null;
  tagging: boolean;
  autoMode: boolean;
  tagCount: number;
  locError: string | null;
  onTag: () => void;
  onToggleAuto: () => void;
  onClearAll: () => void;
}) {
  const canTag = readings != null;
  const color = readings ? qualityColor(readings.pm25) : colors.textMuted;

  return (
    <View style={sheetStyles.sheet}>
      {/* Live readings strip */}
      {readings ? (
        <View style={sheetStyles.liveRow}>
          <View style={sheetStyles.liveChip}>
            <View style={[sheetStyles.qualityDot, { backgroundColor: color }]} />
            <Text style={sheetStyles.liveLabel}>PM2.5</Text>
            <Text style={[sheetStyles.liveValue, { color }]}>{readings.pm25.toFixed(1)}</Text>
          </View>
          <View style={sheetStyles.liveChip}>
            <Text style={sheetStyles.liveLabel}>CO₂</Text>
            <Text style={sheetStyles.liveValue}>{readings.co2}</Text>
          </View>
          <View style={sheetStyles.liveChip}>
            <Text style={sheetStyles.liveLabel}>Temp</Text>
            <Text style={sheetStyles.liveValue}>{readings.temperature.toFixed(1)}°C</Text>
          </View>
          {readings.humidity != null && (
            <View style={sheetStyles.liveChip}>
              <Text style={sheetStyles.liveLabel}>RH</Text>
              <Text style={sheetStyles.liveValue}>{readings.humidity.toFixed(0)}%</Text>
            </View>
          )}
        </View>
      ) : (
        <Text style={[s.muted, { textAlign: 'center', marginBottom: spacing.sm }]}>
          Connect a sensor to start mapping
        </Text>
      )}

      {locError && (
        <Text style={[s.error, { fontSize: 12, marginBottom: spacing.sm }]}>{locError}</Text>
      )}

      {/* Action buttons */}
      <View style={[s.row, { gap: spacing.sm }]}>
        <Pressable
          style={[sheetStyles.tagBtn, (!canTag || tagging) && s.buttonDisabled, { flex: 2 }]}
          onPress={onTag}
          disabled={!canTag || tagging}
        >
          {tagging
            ? <ActivityIndicator color="#fff" size="small" />
            : <Text style={sheetStyles.tagBtnText}>📍 Tag here</Text>
          }
        </Pressable>

        <Pressable
          style={[sheetStyles.autoBtn, autoMode && sheetStyles.autoBtnActive, (!canTag) && s.buttonDisabled, { flex: 1 }]}
          onPress={onToggleAuto}
          disabled={!canTag}
        >
          <Text style={[sheetStyles.autoBtnText, autoMode && { color: '#fff' }]}>
            {autoMode ? '⏹ Stop' : '⏺ Auto'}
          </Text>
        </Pressable>

        {tagCount > 0 && (
          <Pressable style={sheetStyles.clearBtn} onPress={onClearAll}>
            <Text style={sheetStyles.clearBtnText}>Clear</Text>
          </Pressable>
        )}
      </View>

      {autoMode && (
        <Text style={[s.muted, { fontSize: 11, marginTop: spacing.xs, textAlign: 'center' }]}>
          Auto-tagging every 10 s · {tagCount} point{tagCount !== 1 ? 's' : ''} recorded
        </Text>
      )}
    </View>
  );
}

// ── Main component ────────────────────────────────────────────

let nextId = 1;
const AUTO_INTERVAL_MS = 10_000;
const AUTO_MIN_DIST_M  = 3; // only tag if moved ≥3 m

export default function AirMapView({
  readings,
}: {
  readings: LiveReadings | null;
}) {
  const mapRef = useRef<MapView>(null);
  const [tags, setTags] = useState<TaggedReading[]>([]);
  const [userLocation, setUserLocation] = useState<{ lat: number; lon: number } | null>(null);
  const [locError, setLocError] = useState<string | null>(null);
  const [tagging, setTagging] = useState(false);
  const [autoMode, setAutoMode] = useState(false);
  const [permGranted, setPermGranted] = useState(false);
  const [initialized, setInitialized] = useState(false);
  const autoTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastAutoLocRef = useRef<{ lat: number; lon: number } | null>(null);
  const readingsRef = useRef(readings);
  readingsRef.current = readings;

  // Request location permission + start watching on mount
  useEffect(() => {
    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        setLocError('Location permission denied — enable in Settings.');
        setInitialized(true);
        return;
      }
      setPermGranted(true);
      setInitialized(true);

      // Watch position continuously
      await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.High, distanceInterval: 1 },
        loc => {
          const pos = { lat: loc.coords.latitude, lon: loc.coords.longitude };
          setUserLocation(pos);
        }
      );
    })();
  }, []);

  // Pan map to user on first location fix
  useEffect(() => {
    if (!userLocation) return;
    mapRef.current?.animateToRegion({
      latitude: userLocation.lat,
      longitude: userLocation.lon,
      latitudeDelta: 0.002,
      longitudeDelta: 0.002,
    }, 600);
  }, [userLocation === null ? null : 'got-it']); // run once

  // Auto-mode timer
  useEffect(() => {
    if (autoMode) {
      autoTimerRef.current = setInterval(() => {
        const loc = lastAutoLocRef.current;
        const r = readingsRef.current;
        if (!loc || !r) return;
        // Check min distance from last auto-tag
        const lastTag = tags[tags.length - 1];
        if (lastTag) {
          const dLat = (loc.lat - lastTag.lat) * 111_000;
          const dLon = (loc.lon - lastTag.lon) * 111_000 * Math.cos(loc.lat * Math.PI / 180);
          if (Math.sqrt(dLat * dLat + dLon * dLon) < AUTO_MIN_DIST_M) return;
        }
        addTag(loc, r);
      }, AUTO_INTERVAL_MS);
    } else {
      if (autoTimerRef.current) { clearInterval(autoTimerRef.current); autoTimerRef.current = null; }
    }
    return () => { if (autoTimerRef.current) clearInterval(autoTimerRef.current); };
  }, [autoMode]);

  // Keep latest location available for auto-timer without re-starting it
  useEffect(() => { lastAutoLocRef.current = userLocation; }, [userLocation]);

  function addTag(loc: { lat: number; lon: number }, r: LiveReadings) {
    const tag: TaggedReading = {
      id: nextId++,
      lat: loc.lat,
      lon: loc.lon,
      pm25: r.pm25,
      co2: r.co2,
      temperature: r.temperature,
      humidity: r.humidity,
      capturedAt: Date.now(),
    };
    setTags(prev => [...prev, tag]);
  }

  async function handleTag() {
    if (!readings) return;
    setTagging(true);
    setLocError(null);
    try {
      if (!permGranted) {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== 'granted') { setLocError('Location permission denied.'); return; }
        setPermGranted(true);
      }
      const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
      const pos = { lat: loc.coords.latitude, lon: loc.coords.longitude };
      addTag(pos, readings);
      // Pan to tagged point
      mapRef.current?.animateToRegion({
        latitude: pos.lat, longitude: pos.lon,
        latitudeDelta: 0.001, longitudeDelta: 0.001,
      }, 400);
    } catch (e: any) {
      setLocError(e?.message ?? 'Could not get location');
    } finally {
      setTagging(false);
    }
  }

  function handleToggleAuto() {
    if (!autoMode && !readings) return;
    setAutoMode(v => !v);
  }

  if (!initialized) {
    return (
      <View style={[fullStyles.container, { alignItems: 'center', justifyContent: 'center' }]}>
        <ActivityIndicator color={colors.orange} />
        <Text style={[s.muted, { marginTop: spacing.sm }]}>Requesting location…</Text>
      </View>
    );
  }

  const initialRegion: Region = {
    latitude: userLocation?.lat ?? 51.5074,
    longitude: userLocation?.lon ?? -0.1278,
    latitudeDelta: 0.01,
    longitudeDelta: 0.01,
  };

  return (
    <View style={fullStyles.container}>
      <MapView
        ref={mapRef}
        style={fullStyles.map}
        provider={PROVIDER_DEFAULT}
        initialRegion={initialRegion}
        showsUserLocation
        showsMyLocationButton
        showsCompass
      >
        {tags.map(tag => (
          <ReadingMarker
            key={tag.id}
            tag={tag}
            onRemove={() => setTags(prev => prev.filter(t => t.id !== tag.id))}
          />
        ))}
      </MapView>

      <BottomSheet
        readings={readings}
        tagging={tagging}
        autoMode={autoMode}
        tagCount={tags.length}
        locError={locError}
        onTag={handleTag}
        onToggleAuto={handleToggleAuto}
        onClearAll={() => setTags([])}
      />
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────

const fullStyles = {
  container: { flex: 1, minHeight: 400 },
  map: { flex: 1, minHeight: 300, borderRadius: radius.lg, overflow: 'hidden' as const },
};

const markerStyles = {
  dot: {
    width: 40, height: 40, borderRadius: 20,
    alignItems: 'center' as const, justifyContent: 'center' as const,
    borderWidth: 2, borderColor: '#fff',
    shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 4, shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
  dotText: { color: '#fff', fontSize: 10, fontWeight: '700' as const },
  callout: {
    width: 180, backgroundColor: colors.card, borderRadius: radius.md,
    overflow: 'hidden' as const,
    shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 8, shadowOffset: { width: 0, height: 4 },
    elevation: 8,
  },
  calloutBar: { height: 4 },
  calloutBody: { padding: spacing.md },
  calloutTitle: { fontSize: 14, fontWeight: '700' as const, color: colors.text },
  calloutMeta: { fontSize: 11, color: colors.textMuted, marginBottom: spacing.sm },
  calloutRow: { flexDirection: 'row' as const, justifyContent: 'space-between' as const, marginBottom: 2 },
  calloutLabel: { fontSize: 12, color: colors.textMuted },
  calloutValue: { fontSize: 12, fontWeight: '600' as const, color: colors.text },
  calloutRemove: { fontSize: 11, color: colors.textMuted, marginTop: spacing.sm, textAlign: 'center' as const },
};

const sheetStyles = {
  sheet: {
    backgroundColor: colors.card,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    padding: spacing.lg,
    paddingBottom: spacing.xl,
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: -4 },
    elevation: 8,
    gap: spacing.sm,
  },
  liveRow: { flexDirection: 'row' as const, justifyContent: 'space-around' as const, marginBottom: spacing.xs },
  liveChip: { alignItems: 'center' as const, gap: 2 },
  liveLabel: { fontSize: 10, color: colors.textMuted },
  liveValue: { fontSize: 18, fontWeight: '700' as const, color: colors.text, fontVariant: ['tabular-nums'] as any },
  qualityDot: { width: 8, height: 8, borderRadius: 4 },
  tagBtn: {
    backgroundColor: colors.orange, borderRadius: radius.md,
    paddingVertical: spacing.md, alignItems: 'center' as const, justifyContent: 'center' as const,
  },
  tagBtnText: { color: '#fff', fontWeight: '700' as const, fontSize: 15 },
  autoBtn: {
    borderRadius: radius.md, paddingVertical: spacing.md,
    alignItems: 'center' as const, justifyContent: 'center' as const,
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card,
  },
  autoBtnActive: { backgroundColor: colors.text, borderColor: colors.text },
  autoBtnText: { color: colors.text, fontWeight: '600' as const, fontSize: 14 },
  clearBtn: {
    borderRadius: radius.md, paddingVertical: spacing.md, paddingHorizontal: spacing.md,
    alignItems: 'center' as const, justifyContent: 'center' as const,
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card,
  },
  clearBtnText: { color: colors.textMuted, fontWeight: '500' as const, fontSize: 13 },
};
