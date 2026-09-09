import { Ionicons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { AppHeader } from '@/components/AppHeader';
import { Card } from '@/components/Card';
import { Pill } from '@/components/Pill';
import { fmtDate, summaryStats } from '@/lib/auditLogic';
import { useLocationsTree } from '@/hooks/useLocationsTree';
import { buildMaintenanceTasks } from '@/lib/maintenance';
import { INSPECTOR } from '@/lib/mockData';
import { useTheme } from '@/theme/ThemeProvider';
import { useAudits } from '../dashboard/hooks';

// Ports renderIssueDetails() (rack-audit-app.html ~4032-4093) — re-derives
// the flagged entry from summaryStats() by its identifying fields (encoded
// into the [lineId] route param) rather than passing the whole object
// through nav params, so it always reflects live state. Every field shown is
// real data already tracked elsewhere (SKU/condition/qty/lot/evidence) — no
// fabricated fields the app has no source for.
export function IssueDetailsScreen() {
  const { tokens } = useTheme();
  const { auditId, lineId } = useLocalSearchParams<{ auditId: string; lineId: string }>();
  const { data: audits } = useAudits();
  const audit = audits?.find((a) => a.audit_id === auditId);
  const { data: tree, isLoading } = useLocationsTree(auditId);

  const [layout, rack, bay, locCode, pallet, sku] = (lineId ?? '').split('~').map((s) => decodeURIComponent(s));
  const stats = summaryStats(tree);
  const f = stats.flagged.find(
    (x) => x.layout === layout && x.rack === rack && x.bay === bay && x.locCode === locCode && x.pallet === pallet && x.sku === sku,
  );

  if (!audit || isLoading) {
    return (
      <View style={[styles.loading, { backgroundColor: tokens.muted }]}>
        <ActivityIndicator color={tokens.primary} />
      </View>
    );
  }

  if (!f) {
    return (
      <View style={{ flex: 1, backgroundColor: tokens.muted }}>
        <AppHeader title="Issue Details" showBack />
        <View style={styles.loading}>
          <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.sm }}>This item is no longer flagged.</Text>
        </View>
      </View>
    );
  }

  const ev = f.evidence;
  const images = ev?.images ?? [];
  const videos = ev?.videos ?? [];

  // Same identity this flagged line's own MaintenanceTask carries (see
  // maintenance.ts's taskFromScoped/taskFromManual) — re-derived rather
  // than passed through nav params, same reasoning as `f` above. Not every
  // flagged line has a Maintenance follow-up (e.g. one that never made
  // scopedIssues'/summaryStats' Maintenance-eligible cut), so this box only
  // renders when a real assignment actually exists.
  const maintTask = buildMaintenanceTasks(audit ? [audit] : [], { [audit.audit_id]: tree }).find(
    (t) => t.layout === f.layout && t.rack === f.rack && t.bay === f.bay && t.locCode === f.locCode && t.pallet === f.pallet && t.sku === f.sku,
  );

  return (
    <View style={{ flex: 1, backgroundColor: tokens.muted }}>
      <AppHeader title="Issue Details" showBack menuItems={[{ label: 'Sync Now', onPress: () => {} }]} />
      <ScrollView contentContainerStyle={styles.body}>
        {maintTask ? (
          <View style={styles.assignedWrap}>
            <View style={styles.assignedByRow}>
              <View style={[styles.assignedByIconWrap, { backgroundColor: tokens.accentBlue.soft }]}>
                <Ionicons name="calendar-outline" size={14} color={tokens.accentBlue.base} />
              </View>
              <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.semibold, fontSize: tokens.text.sm }}>
                Assigned By: {INSPECTOR.name}
              </Text>
            </View>
            <View style={[styles.assignedBox, { borderColor: tokens.accentBlue.base, backgroundColor: tokens.accentBlue.soft }]}>
              <Field label="Assigned Action" value={maintTask.action} />
              <Field label="Assigned To" value={INSPECTOR.name} />
              <Field label="Assigned Date & Time" value={fmtDate(maintTask.dueDate)} />
              <Field label="Comments" value="NA" />
            </View>
          </View>
        ) : null}
        <Card>
          <View style={styles.sectionLabelRow}>
            <Ionicons name="search-outline" size={16} color={tokens.foreground} />
            <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.base }}>Issue Details</Text>
          </View>
          <View style={styles.grid}>
            <Field label="SKU Code" value={f.sku} mono />
            <Field label="Condition">
              <Pill label={f.condition} tone={f.condition === 'Damaged' || f.condition === 'Broken' ? 'High' : 'Medium'} />
            </Field>
            <Field label="Pallet ID" value={f.pallet} mono />
            <Field label="Location" value={`${f.layout} · Rack ${f.rack} · Bay ${f.bay}, ${f.locCode}`} />
            <Field label="SKU Name" value={f.name} />
            <Field label="Lot" value={f.lot} mono />
            <Field label="Quantity" value={String(f.qty)} />
            <Field label="No. of SKUs on Pallet" value={String(f.skuCount)} />
            <Field label="Audit Type" value={audit.audit_type} />
            <Field label="Note" value={ev?.note || 'NA'} />
          </View>

          <View style={[styles.sectionLabelRow, { marginTop: 20 }]}>
            <Ionicons name="mic-outline" size={16} color={tokens.foreground} />
            <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.base }}>Audio Note</Text>
          </View>
          <View style={{ marginTop: 12 }}>
            {ev?.audio ? (
              <View style={[styles.audioRow, { backgroundColor: tokens.muted, borderRadius: tokens.radius.lg }]}>
                <Ionicons name="play" size={16} color={tokens.foreground} />
                <View style={styles.waveform}>
                  {ev.audio.bars.map((h, i) => (
                    <View key={i} style={[styles.waveBar, { height: h, backgroundColor: tokens.mutedForeground }]} />
                  ))}
                </View>
                <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xs }}>{ev.audio.durationSec}s</Text>
              </View>
            ) : (
              <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.sm }}>No audio recorded</Text>
            )}
          </View>
        </Card>

        <Card>
          <EvidenceGroupHead icon="image-outline" label="Image Attachments" count={images.length} />
          {images.length ? (
            <View style={styles.thumbRow}>
              {images.map((_, i) => (
                <View key={i} style={[styles.thumb, { backgroundColor: tokens.muted, borderRadius: tokens.radius.lg }]}>
                  <Ionicons name="image-outline" size={20} color="#667085" />
                </View>
              ))}
            </View>
          ) : (
            <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.sm }}>No images attached</Text>
          )}
        </Card>

        <Card>
          <EvidenceGroupHead icon="videocam-outline" label="Video Attachments" count={videos.length} />
          {videos.length ? (
            <View style={styles.thumbRow}>
              {videos.map((v, i) => (
                <View key={i} style={[styles.thumb, { backgroundColor: tokens.muted, borderRadius: tokens.radius.lg }]}>
                  <Text style={{ color: tokens.mutedForeground, fontSize: 9 }}>00:{v.durationSec}s</Text>
                  <Ionicons name="play" size={16} color="#667085" />
                </View>
              ))}
            </View>
          ) : (
            <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.sm }}>No videos attached</Text>
          )}
        </Card>
      </ScrollView>
      {maintTask ? (
        <View style={[styles.footerBar, { backgroundColor: tokens.card, borderTopColor: tokens.border }]}>
          <Pressable onPress={() => router.back()} style={[styles.footerBtn, styles.cancelBtn, { borderColor: tokens.border }]}>
            <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.base }}>Cancel</Text>
          </Pressable>
          <Pressable
            onPress={() => router.back()}
            style={[styles.footerBtn, { flex: 1.4, backgroundColor: tokens.primary, borderRadius: tokens.radius.lg }]}
          >
            <Text style={{ color: tokens.primaryForeground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.base }}>Complete Task</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

function EvidenceGroupHead({ icon, label, count }: { icon: keyof typeof Ionicons.glyphMap; label: string; count: number }) {
  const { tokens } = useTheme();
  return (
    <View style={styles.evidenceHeadRow}>
      <Ionicons name={icon} size={16} color={tokens.foreground} />
      <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.semibold, fontSize: tokens.text.sm }}>{label}</Text>
      <View style={[styles.countBadge, { backgroundColor: tokens.accentBlue.soft, borderRadius: tokens.radius.sm }]}>
        <Text style={{ color: tokens.accentBlue.strong, fontSize: tokens.text.xxs, fontWeight: tokens.fontWeight.bold }}>
          {String(count).padStart(2, '0')}
        </Text>
      </View>
    </View>
  );
}

function Field({ label, value, mono, children }: { label: string; value?: string; mono?: boolean; children?: React.ReactNode }) {
  const { tokens } = useTheme();
  return (
    <View style={styles.field}>
      <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm, marginBottom: 4 }}>{label}</Text>
      {children ?? (
        <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.sm, fontFamily: mono ? 'Inter_500Medium' : undefined }}>{value}</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  body: { padding: 16, gap: 14, paddingBottom: 40 },
  assignedWrap: { gap: 10 },
  assignedByRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  assignedByIconWrap: { width: 24, height: 24, borderRadius: 7, alignItems: 'center', justifyContent: 'center' },
  assignedBox: { flexDirection: 'row', flexWrap: 'wrap', borderWidth: 1.5, borderStyle: 'dashed', borderRadius: 12, padding: 14 },
  footerBar: { flexDirection: 'row', gap: 12, padding: 16, borderTopWidth: StyleSheet.hairlineWidth },
  footerBtn: { flex: 1, height: 48, alignItems: 'center', justifyContent: 'center' },
  cancelBtn: { borderWidth: 1, borderRadius: 12 },
  sectionLabelRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 14 },
  field: { width: '50%', marginBottom: 14 },
  audioRow: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12 },
  waveform: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 2, height: 24 },
  waveBar: { width: 2, borderRadius: 1 },
  evidenceHeadRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 },
  countBadge: { paddingHorizontal: 7, paddingVertical: 2 },
  thumbRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  thumb: { width: 64, height: 64, alignItems: 'center', justifyContent: 'center', gap: 4 },
});
