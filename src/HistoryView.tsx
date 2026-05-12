import React, { useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  Share,
  Text,
  View,
} from 'react-native';
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';

import { HistoryRecord, getRecordMs, recordsToCSV } from './ble';
import { colors, spacing } from './theme';
import { sharedStyles as s } from './styles';
import HistoryChart from './HistoryChart';

// ── Export button ─────────────────────────────────────────────

function ExportButton({
  records, anchorMs, timeOffset,
}: {
  records: HistoryRecord[];
  anchorMs: number;
  timeOffset: number;
}) {
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
        const path = dir + filename;
        await FileSystem.writeAsStringAsync(path, csv, { encoding: FileSystem.EncodingType.UTF8 });
        await Sharing.shareAsync(path, {
          mimeType: 'text/csv',
          dialogTitle: filename,
          UTI: 'public.comma-separated-values-text',
        });
      } else {
        await Share.share({ message: csv, title: filename });
      }
    } catch (e: any) {
      if (e?.message !== 'The user did not share') {
        setExportError(e?.message ?? 'Export failed');
      }
    } finally {
      setExporting(false);
    }
  }

  return (
    <View>
      <Pressable
        style={[s.smallButton, exporting && s.buttonDisabled, { marginBottom: exportError ? spacing.xs : spacing.sm }]}
        onPress={handleExport}
        disabled={exporting}
      >
        <Text style={s.smallButtonText}>{exporting ? 'Exporting…' : 'Export CSV'}</Text>
      </Pressable>
      {exportError && (
        <Text style={[s.error, { fontSize: 12, marginBottom: spacing.sm }]}>{exportError}</Text>
      )}
    </View>
  );
}

// ── History row ───────────────────────────────────────────────

function HistoryRow({
  record, anchorMs, timeOffset, lastTs,
}: {
  record: HistoryRecord;
  anchorMs: number;
  timeOffset: number;
  lastTs: number;
}) {
  const realMs = getRecordMs(record, anchorMs, lastTs, timeOffset);
  const d = new Date(realMs);
  const isReal = record.ts > 1_000_000_000 || timeOffset > 0;
  const timeStr = isReal
    ? `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
    : anchorMs > 0
      ? `~${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
      : `T+${Math.floor(record.ts / 3600)}h${String(Math.floor((record.ts % 3600) / 60)).padStart(2, '0')}m`;
  return (
    <View style={s.historyRow}>
      <Text style={s.historyTime}>{timeStr}</Text>
      <Text style={s.historyValue}>PM2.5 {record.pm25.toFixed(1)}</Text>
      <Text style={s.historyValue}>CO₂ {record.co2}</Text>
      <Text style={s.historyValue}>{record.temperature.toFixed(1)}°C</Text>
    </View>
  );
}

// ── HistoryView ───────────────────────────────────────────────

export default function HistoryView({
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
      <View style={s.card}>
        <Text style={s.muted}>No device history yet — records are saved every 60 s.</Text>
      </View>
    );
  }

  return (
    <View style={{ gap: spacing.sm }}>
      {hasDevice && (
        <View style={s.card}>
          <Text style={s.sectionTitle}>ON DEVICE</Text>
          <Text style={[s.cardMeta, { marginTop: 2, marginBottom: spacing.sm }]}>
            {count} record{count !== 1 ? 's' : ''} · saved every 60 s
          </Text>
          <View style={s.row}>
            <Pressable
              style={[s.button, downloading && s.buttonDisabled]}
              onPress={onDownload}
              disabled={downloading}
            >
              <Text style={s.buttonText}>
                {downloading ? 'Downloading…' : 'Download to app'}
              </Text>
            </Pressable>
            {!downloading && (
              <Pressable style={s.smallButton} onPress={onClear}>
                <Text style={s.smallButtonText}>Clear device</Text>
              </Pressable>
            )}
            {downloading && <ActivityIndicator color={colors.orange} />}
          </View>

          {downloading && progress && (
            <View style={{ marginTop: spacing.sm }}>
              <View style={s.progressTrack}>
                <View style={[
                  s.progressFill,
                  { width: `${(progress.received / progress.total) * 100}%` as any },
                ]} />
              </View>
              <Text style={[s.cardMeta, { marginTop: spacing.xs }]}>
                {progress.received} / {progress.total}
              </Text>
            </View>
          )}
        </View>
      )}

      {hasDownloaded && (
        <View style={s.section}>
          <Text style={s.sectionTitle}>DOWNLOADED TO APP</Text>
          <Text style={[s.cardMeta, { marginTop: 2 }]}>
            {records.length} record{records.length !== 1 ? 's' : ''}
          </Text>
          {timeOffset === 0 && (
            <View style={[s.warningBanner, { marginTop: spacing.sm }]}>
              <Text style={s.warningText}>
                ⚠️ Timestamps are estimated — connect again with new firmware for accurate time sync
              </Text>
            </View>
          )}
          <ExportButton records={records} anchorMs={anchorMs} timeOffset={timeOffset} />
          {records.length >= 2 && (
            <HistoryChart records={records} anchorMs={anchorMs} timeOffset={timeOffset} />
          )}
          {records.slice(-20).reverse().map((r, i) => (
            <HistoryRow
              key={i}
              record={r}
              anchorMs={anchorMs}
              timeOffset={timeOffset}
              lastTs={records[records.length - 1].ts}
            />
          ))}
          {records.length > 20 && (
            <Text style={s.muted}>Showing last 20 of {records.length}</Text>
          )}
        </View>
      )}
    </View>
  );
}
