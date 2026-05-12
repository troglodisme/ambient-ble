import React, { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import * as Location from 'expo-location';

import { HistoryRecord } from './ble';
import { colors, radius, spacing } from './theme';
import { sharedStyles as s } from './styles';

export type TaggedReading = {
  id: number;
  lat: number;
  lon: number;
  label: string;
  pm25: number;
  co2: number;
  temperature: number;
  capturedAt: number; // ms
};

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

function TagCard({ tag, onRemove }: { tag: TaggedReading; onRemove: () => void }) {
  const color = qualityColor(tag.pm25);
  const time = new Date(tag.capturedAt);
  const timeStr = `${time.getHours().toString().padStart(2, '0')}:${time.getMinutes().toString().padStart(2, '0')}`;
  return (
    <View style={[styles.tagCard, { borderLeftColor: color }]}>
      <View style={s.row}>
        <View style={{ flex: 1 }}>
          <Text style={s.cardTitle}>{tag.label}</Text>
          <Text style={[s.cardMeta, { color }]}>{qualityLabel(tag.pm25)}</Text>
        </View>
        <Pressable onPress={onRemove} style={styles.removeBtn}>
          <Text style={styles.removeBtnText}>✕</Text>
        </Pressable>
      </View>

      <View style={[s.row, { marginTop: spacing.sm, flexWrap: 'wrap' }]}>
        <View style={styles.pill}>
          <Text style={styles.pillLabel}>PM2.5</Text>
          <Text style={[styles.pillValue, { color }]}>{tag.pm25.toFixed(1)} µg/m³</Text>
        </View>
        <View style={styles.pill}>
          <Text style={styles.pillLabel}>CO₂</Text>
          <Text style={styles.pillValue}>{tag.co2} ppm</Text>
        </View>
        <View style={styles.pill}>
          <Text style={styles.pillLabel}>Temp</Text>
          <Text style={styles.pillValue}>{tag.temperature.toFixed(1)}°C</Text>
        </View>
      </View>

      <Text style={[s.cardMeta, { marginTop: spacing.xs }]}>
        {timeStr} · {tag.lat.toFixed(5)}, {tag.lon.toFixed(5)}
      </Text>
    </View>
  );
}

let nextId = 1;

export default function MapView({
  readings,
}: {
  readings: { pm25?: number; co2?: number; temperature?: number } | null;
}) {
  const [tags, setTags] = useState<TaggedReading[]>([]);
  const [locError, setLocError] = useState<string | null>(null);
  const [tagging, setTagging] = useState(false);

  const canTag = readings?.pm25 != null;

  async function handleTag() {
    setTagging(true);
    setLocError(null);
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        setLocError('Location permission denied. Enable it in Settings to tag readings.');
        return;
      }
      const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
      const tag: TaggedReading = {
        id: nextId++,
        lat: loc.coords.latitude,
        lon: loc.coords.longitude,
        label: `Reading ${nextId - 1}`,
        pm25: readings?.pm25 ?? 0,
        co2: readings?.co2 ?? 0,
        temperature: readings?.temperature ?? 0,
        capturedAt: Date.now(),
      };
      setTags(prev => [tag, ...prev]);
    } catch (e: any) {
      setLocError(e?.message ?? 'Could not get location');
    } finally {
      setTagging(false);
    }
  }

  function removeTag(id: number) {
    setTags(prev => prev.filter(t => t.id !== id));
  }

  return (
    <View style={{ gap: spacing.md }}>
      {/* Info banner */}
      <View style={s.card}>
        <Text style={s.sectionTitle}>GPS TAGGING</Text>
        <Text style={[s.cardMeta, { marginTop: spacing.xs, marginBottom: spacing.sm }]}>
          Tag the current live reading with your GPS location. Walk around and collect multiple
          points to map air quality across a space.
        </Text>
        <Pressable
          style={[s.button, (!canTag || tagging) && s.buttonDisabled]}
          onPress={handleTag}
          disabled={!canTag || tagging}
        >
          <Text style={s.buttonText}>
            {tagging ? 'Getting location…' : canTag ? '📍 Tag current reading' : 'Connect a device first'}
          </Text>
        </Pressable>
        {locError && (
          <Text style={[s.error, { marginTop: spacing.sm, fontSize: 12 }]}>{locError}</Text>
        )}
      </View>

      {/* Tagged readings list */}
      {tags.length === 0 ? (
        <View style={[s.card, { alignItems: 'center', paddingVertical: spacing.xl }]}>
          <Text style={{ fontSize: 32 }}>🗺️</Text>
          <Text style={[s.muted, { marginTop: spacing.sm, textAlign: 'center' }]}>
            No tagged readings yet.{'\n'}Move to a location and tap Tag.
          </Text>
        </View>
      ) : (
        <>
          <Text style={[s.sectionTitle, { paddingHorizontal: spacing.xs }]}>
            {tags.length} TAGGED READING{tags.length !== 1 ? 'S' : ''}
          </Text>
          {tags.map(tag => (
            <TagCard key={tag.id} tag={tag} onRemove={() => removeTag(tag.id)} />
          ))}
        </>
      )}
    </View>
  );
}

const styles = {
  tagCard: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    padding: spacing.lg,
    borderLeftWidth: 4,
    borderLeftColor: colors.good,
  },
  pill: {
    backgroundColor: '#f0f0f0',
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    marginRight: spacing.xs,
    marginBottom: spacing.xs,
  },
  pillLabel: { fontSize: 10, color: colors.textMuted },
  pillValue: { fontSize: 13, fontWeight: '600' as const, color: colors.text },
  removeBtn: { padding: spacing.xs },
  removeBtnText: { color: colors.textMuted, fontSize: 16 },
};
