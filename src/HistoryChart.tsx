import React, { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import Svg, { Line, Polyline, Text as SvgText } from 'react-native-svg';

import { getRecordMs } from './ble';
import type { HistoryRecord } from './ble';
import { colors, radius, spacing } from './theme';

type SeriesKey = 'pm25' | 'co2' | 'temp' | 'humidity' | 'voc' | 'nox';

interface SeriesDef {
  key: SeriesKey;
  label: string;
  color: string;
  unit: string;
  decimals: number;
  getValue: (r: HistoryRecord) => number;
}

const SERIES: SeriesDef[] = [
  { key: 'co2',      label: 'CO₂',   color: '#FF8C00', unit: 'ppm',   decimals: 0, getValue: r => r.co2 },
  { key: 'pm25',     label: 'PM2.5', color: '#4A90E2', unit: 'µg/m³', decimals: 1, getValue: r => r.pm25 },
  { key: 'temp',     label: 'Temp',  color: '#E25B5B', unit: '°C',    decimals: 1, getValue: r => r.temperature },
  { key: 'humidity', label: 'RH',    color: '#4ECDC4', unit: '%',     decimals: 1, getValue: r => r.humidity },
  { key: 'voc',      label: 'VOC',   color: '#A78BFA', unit: 'idx',   decimals: 1, getValue: r => r.voc },
  { key: 'nox',      label: 'NOx',   color: '#FCD34D', unit: 'idx',   decimals: 1, getValue: r => r.nox },
];

const CHART_H = 200;
const PAD = { top: 8, bottom: 28, left: 8, right: 56 } as const;
const MIN_PX_PER_POINT = 8;

function normalizeValues(values: number[]): number[] {
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max === min) return values.map(() => 0.5);
  return values.map(v => (v - min) / (max - min));
}

export default function HistoryChart({
  records,
  anchorMs,
  timeOffset = 0,
  width: widthProp,
}: {
  records: HistoryRecord[];
  anchorMs: number;
  timeOffset?: number;
  width?: number;
}) {
  const { width: windowW } = useWindowDimensions();
  const [active, setActive] = useState<Set<SeriesKey>>(
    () => new Set<SeriesKey>(['co2', 'pm25', 'temp', 'humidity']),
  );

  const availableW = widthProp ?? (windowW - spacing.lg * 4);
  const screenW = availableW;
  const chartW = Math.max(screenW, records.length * MIN_PX_PER_POINT);
  const plotW = chartW - PAD.left - PAD.right;
  const plotH = CHART_H - PAD.top - PAD.bottom;
  const lastTs = records.length > 0 ? records[records.length - 1].ts : 0;

  const seriesData = useMemo(() => {
    const result: Record<string, { points: string; min: number; max: number }> = {};
    for (const s of SERIES) {
      const values = records.map(s.getValue);
      const norm = normalizeValues(values);
      const points = norm
        .map((n, i) => {
          const x =
            records.length <= 1
              ? PAD.left + plotW / 2
              : PAD.left + (i / (records.length - 1)) * plotW;
          const y = PAD.top + (1 - n) * plotH;
          return `${x.toFixed(1)},${y.toFixed(1)}`;
        })
        .join(' ');
      result[s.key] = { points, min: Math.min(...values), max: Math.max(...values) };
    }
    return result as Record<SeriesKey, { points: string; min: number; max: number }>;
  }, [records, plotW, plotH]);

  const xLabels = useMemo(() => {
    if (records.length < 2) return [];
    const count = Math.min(6, records.length);
    const lastTs = records[records.length - 1].ts;
    return Array.from({ length: count }, (_, i) => {
      const idx = Math.round((i / (count - 1)) * (records.length - 1));
      const r = records[idx];
      const ms = getRecordMs(r, anchorMs, lastTs, timeOffset);
      const x = PAD.left + (idx / (records.length - 1)) * plotW;
      const d = new Date(ms);
      const isReal = r.ts > 1_000_000_000 || timeOffset > 0;
      const label = isReal
        ? `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
        : anchorMs > 0
          ? `~${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
          : `+${Math.floor(r.ts / 3600)}h`;
      return { x, label };
    });
  }, [records, anchorMs, timeOffset, plotW]);

  if (records.length < 2) return null;

  const visibleSeries = SERIES.filter(s => active.has(s.key));

  function toggleSeries(key: SeriesKey) {
    setActive(prev => {
      const next = new Set(prev);
      if (next.has(key)) {
        if (next.size > 1) next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }

  return (
    <View style={styles.container}>
      {/* Toggle chips */}
      <View style={styles.legend}>
        {SERIES.map(s => {
          const on = active.has(s.key);
          return (
            <Pressable
              key={s.key}
              style={[styles.chip, { borderColor: on ? s.color : colors.border }]}
              onPress={() => toggleSeries(s.key)}
            >
              <View style={[styles.dot, { backgroundColor: on ? s.color : colors.border }]} />
              <Text style={[styles.chipText, { color: on ? s.color : colors.textMuted }]}>
                {s.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {/* Chart (horizontally scrollable when many data points) */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <Svg width={chartW} height={CHART_H}>
          {/* Horizontal grid lines */}
          {[0, 0.25, 0.5, 0.75, 1].map(f => {
            const y = PAD.top + (1 - f) * plotH;
            return (
              <Line
                key={f}
                x1={PAD.left}
                y1={y}
                x2={chartW - PAD.right}
                y2={y}
                stroke={colors.border}
                strokeWidth={1}
              />
            );
          })}

          {/* Data lines — each series normalized independently */}
          {visibleSeries.map(s => (
            <Polyline
              key={s.key}
              points={seriesData[s.key].points}
              fill="none"
              stroke={s.color}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          ))}

          {/* End-of-line value labels (last value with unit) */}
          {visibleSeries.map(s => {
            const values = records.map(s.getValue);
            const norm = normalizeValues(values);
            const lastNorm = norm[norm.length - 1];
            const x = PAD.left + plotW + 4;
            const y = PAD.top + (1 - lastNorm) * plotH + 4;
            return (
              <SvgText key={`lbl-${s.key}`} x={x} y={y} fontSize={9} fill={s.color} textAnchor="start">
                {values[values.length - 1].toFixed(s.decimals)}{s.unit}
              </SvgText>
            );
          })}

          {/* X-axis time labels */}
          {xLabels.map(({ x, label }, i) => (
            <SvgText
              key={i}
              x={x}
              y={CHART_H - 6}
              fontSize={9}
              fill={colors.textMuted}
              textAnchor="middle"
            >
              {label}
            </SvgText>
          ))}
        </Svg>
      </ScrollView>

      {/* Min / max range for each visible series */}
      <View style={styles.ranges}>
        {visibleSeries.map(s => {
          const d = seriesData[s.key];
          const fmt = (n: number) => n.toFixed(s.decimals);
          return (
            <View key={s.key} style={styles.rangeItem}>
              <View style={[styles.rangeBar, { backgroundColor: s.color }]} />
              <Text style={[styles.rangeLabel, { color: s.color }]}>{s.label}</Text>
              <Text style={styles.rangeValues}>
                {fmt(d.min)}–{fmt(d.max)} {s.unit}
              </Text>
            </View>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container:   { gap: spacing.sm },
  legend:      { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  chip:        {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 8, paddingVertical: 4,
    borderRadius: radius.sm, borderWidth: 1,
  },
  dot:         { width: 6, height: 6, borderRadius: 3 },
  chipText:    { fontSize: 11, fontWeight: '600' },
  ranges:      { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  rangeItem:   { flexDirection: 'row', alignItems: 'center', gap: 4, width: '50%' },
  rangeBar:    { width: 16, height: 2, borderRadius: 1 },
  rangeLabel:  { fontSize: 11, fontWeight: '600', width: 36 },
  rangeValues: { fontSize: 11, color: colors.textMuted },
});
