import React from 'react';
import { Text, View } from 'react-native';
import { HistoryRecord } from './ble';
import { spacing } from './theme';
import { sharedStyles as s } from './styles';
import HistoryChart from './HistoryChart';

export default function SessionView({ liveHistory }: { liveHistory: HistoryRecord[] }) {
  if (liveHistory.length < 2) {
    return (
      <View style={s.card}>
        <View style={[s.row, { gap: spacing.sm }]}>
          <View style={s.liveBadge}><Text style={s.liveBadgeText}>● LIVE</Text></View>
          <Text style={s.cardTitle}>This Session</Text>
        </View>
        <Text style={[s.muted, { marginTop: spacing.sm }]}>
          Readings will appear here once sensor data arrives…
        </Text>
      </View>
    );
  }
  return (
    <View style={s.section}>
      <View style={[s.row, { justifyContent: 'space-between' }]}>
        <Text style={s.cardTitle}>This Session</Text>
        <View style={s.liveBadge}><Text style={s.liveBadgeText}>● LIVE</Text></View>
      </View>
      <Text style={[s.cardMeta, { marginTop: 2, marginBottom: spacing.sm }]}>
        {liveHistory.length} reading{liveHistory.length !== 1 ? 's' : ''} · 1 per second
      </Text>
      <HistoryChart records={liveHistory} anchorMs={0} timeOffset={0} />
    </View>
  );
}
