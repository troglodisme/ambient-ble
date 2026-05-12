import React from 'react';
import { Text, View } from 'react-native';
import { Readings } from './ble';
import { colors, spacing } from './theme';
import { sharedStyles as s } from './styles';

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={s.section}>
      <Text style={s.sectionTitle}>{title.toUpperCase()}</Text>
      <View style={s.grid}>{children}</View>
    </View>
  );
}

function Metric({ label, value, unit }: { label: string; value?: string; unit?: string }) {
  return (
    <View style={s.metric}>
      <Text style={s.metricLabel}>{label}</Text>
      <Text style={s.metricValue}>
        {value ?? '—'}
        {value && unit ? <Text style={s.metricUnit}> {unit}</Text> : null}
      </Text>
    </View>
  );
}

export default function ReadingsView({ readings }: { readings: Readings }) {
  const { particles, gases, env, battery } = readings;
  if (!readings.updatedAt) {
    return <Text style={s.muted}>Waiting for data…</Text>;
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
