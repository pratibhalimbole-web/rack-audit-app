import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import { AppHeader } from '@/components/AppHeader';
import { Card } from '@/components/Card';
import { Pill } from '@/components/Pill';
import { mismatchSeverity, mismatchType, skuMismatches, type SkuMismatch } from '@/lib/auditLogic';
import { useLocationsTree } from '@/hooks/useLocationsTree';
import { useTheme } from '@/theme/ThemeProvider';
import { useAudits } from '../dashboard/hooks';

function mismatchKeyOf(m: SkuMismatch): string {
  return [m.layout, m.rack, m.bay, m.locCode, m.pallet].map(encodeURIComponent).join('~');
}

// Discrepancy Details — reached from the Reported Audits board's "Mismatch
// SKUs" toggle. Built per the supplied reference design (Discrepancy
// Summary / Inventory Information / Expected (Master) / Found (Audit) /
// Difference Summary / Count Evidence), but every field is either real data
// (location/rack/SKU/quantities/evidence) or an honestly-derived value —
// Severity/Type come from mismatchSeverity/mismatchType (actual variance
// logic, not a random label), Status is always "Open" (this app has no
// resolution workflow to track anything else), and Source is "Manual Scan"
// (the app's real capability — not "Drone", which isn't something this app
// can do).
export function DiscrepancyDetailsScreen() {
  const { tokens } = useTheme();
  const { auditId, key } = useLocalSearchParams<{ auditId: string; key: string }>();
  const { data: audits } = useAudits();
  const audit = audits?.find((a) => a.audit_id === auditId);
  const { data: tree, isLoading } = useLocationsTree(auditId);

  const mismatches = skuMismatches(tree);
  const m = mismatches.find((x) => mismatchKeyOf(x) === key);
  const index = mismatches.findIndex((x) => mismatchKeyOf(x) === key);

  if (!audit || isLoading) {
    return (
      <View style={[styles.loading, { backgroundColor: tokens.muted }]}>
        <ActivityIndicator color={tokens.primary} />
      </View>
    );
  }

  if (!m) {
    return (
      <View style={{ flex: 1, backgroundColor: tokens.muted }}>
        <AppHeader title="Discrepancy Details" showBack />
        <View style={styles.loading}>
          <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.sm }}>This discrepancy is no longer present.</Text>
        </View>
      </View>
    );
  }

  const type = mismatchType(m);
  const category = type === 'SKU Mismatch' ? 'SKU Discrepancies' : 'Quantity Discrepancies';
  const severity = mismatchSeverity(m);
  const discrepancyId = `DISC-${auditId.replace(/\D/g, '')}-${String(index + 1).padStart(2, '0')}`;
  const delta = m.foundQty - m.expected.qty;

  const found = m; // found values already flattened onto the mismatch record

  return (
    <View style={{ flex: 1, backgroundColor: tokens.muted }}>
      <AppHeader title="Discrepancy Details" sub={`${audit.audit_id} · ${audit.scope_type} overview`} showBack menuItems={[{ label: 'Sync Now', onPress: () => {} }]} />
      <ScrollView contentContainerStyle={styles.body}>
        <Card>
          <Text style={[styles.sectionLabel, { color: tokens.mutedForeground }]}>Discrepancy Summary</Text>
          <View style={styles.grid}>
            <Field label="Discrepancy ID" value={discrepancyId} mono />
            <Field label="Type">
              <Pill label={type} tone={type === 'SKU Mismatch' ? 'High' : 'Medium'} />
            </Field>
            <Field label="Category" value={category} />
            <Field label="Severity">
              <Pill label={severity} tone={severity === 'Critical' ? 'High' : severity === 'Medium' ? 'Medium' : 'Low'} />
            </Field>
            <Field label="Status">
              <Pill label="Open" tone="Overdue" />
            </Field>
            <Field label="Source" value="Manual Scan" />
          </View>
        </Card>

        <Card>
          <Text style={[styles.sectionLabel, { color: tokens.mutedForeground }]}>Inventory Information</Text>
          <View style={styles.grid}>
            <Field label="Location" value={m.locCode} mono />
            <Field label="Zone" value={m.rack} mono />
            <Field label="SKU" value={found.foundSku} mono />
            <Field label="Pallet ID" value={m.pallet} mono />
          </View>
        </Card>

        <Card style={{ borderColor: tokens.rag.amber.border }}>
          <Text style={[styles.sectionLabel, { color: tokens.rag.amber.strong }]}>Expected (Master)</Text>
          <View style={styles.grid}>
            <Field label="SKU" value={m.expected.sku} mono />
            <Field label="Location" value={m.locCode} mono />
            <Field label="Quantity" value={`${m.expected.qty} EA`} />
          </View>
        </Card>

        <Card style={{ borderColor: tokens.accentBlue.border }}>
          <Text style={[styles.sectionLabel, { color: tokens.accentBlue.strong }]}>Found (Audit)</Text>
          <View style={styles.grid}>
            <Field label="SKU" value={found.foundSku} mono />
            <Field label="Location" value={m.locCode} mono />
            <Field label="Quantity" value={`${found.foundQty} EA`} />
          </View>
        </Card>

        <Card>
          <Text style={[styles.sectionLabel, { color: tokens.mutedForeground }]}>Difference Summary</Text>
          <View style={styles.grid}>
            <Field label="Expected Quantity" value={`${m.expected.qty} EA`} />
            <Field label="Found Quantity" value={`${found.foundQty} EA`} />
            <Field label="Difference">
              <Pill label={`${delta > 0 ? '+' : ''}${delta} EA`} tone={delta === 0 ? 'Low' : 'High'} />
            </Field>
          </View>
        </Card>

        <Card>
          <Text style={[styles.sectionLabel, { color: tokens.mutedForeground }]}>Count Evidence</Text>
          <EvidenceGroup icon="image-outline" label="Images" count={m.evidence?.images.length ?? 0} />
          <EvidenceGroup icon="videocam-outline" label="Videos" count={m.evidence?.videos.length ?? 0} />
          <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xxs, marginTop: 10, marginBottom: 6 }}>AUDIT NOTE</Text>
          {m.evidence?.audio ? (
            <View style={[styles.audioRow, { backgroundColor: tokens.muted, borderRadius: tokens.radius.lg }]}>
              <Ionicons name="play" size={16} color={tokens.foreground} />
              <View style={styles.waveform}>
                {m.evidence.audio.bars.map((h, i) => (
                  <View key={i} style={[styles.waveBar, { height: h, backgroundColor: tokens.mutedForeground }]} />
                ))}
              </View>
              <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xs }}>{m.evidence.audio.durationSec}s</Text>
            </View>
          ) : (
            <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.sm }}>No audit note recorded</Text>
          )}
        </Card>
      </ScrollView>
    </View>
  );
}

function EvidenceGroup({ icon, label, count }: { icon: keyof typeof Ionicons.glyphMap; label: string; count: number }) {
  const { tokens } = useTheme();
  return (
    <View style={styles.evidenceRow}>
      <View style={styles.evidenceHead}>
        <Ionicons name={icon} size={14} color="#667085" />
        <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xxs, fontWeight: tokens.fontWeight.semibold }}>{label.toUpperCase()}</Text>
      </View>
      {count > 0 ? (
        <View style={styles.thumbRow}>
          {Array.from({ length: count }, (_, i) => (
            <View key={i} style={[styles.thumb, { backgroundColor: tokens.muted, borderRadius: tokens.radius.lg }]}>
              <Ionicons name={icon} size={18} color="#667085" />
            </View>
          ))}
        </View>
      ) : (
        <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.sm }}>No {label.toLowerCase()} attached</Text>
      )}
    </View>
  );
}

function Field({ label, value, mono, children }: { label: string; value?: string; mono?: boolean; children?: React.ReactNode }) {
  const { tokens } = useTheme();
  return (
    <View style={styles.field}>
      <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xxs, marginBottom: 4 }}>{label.toUpperCase()}</Text>
      {children ?? (
        <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm, fontFamily: mono ? 'Inter_500Medium' : undefined }}>
          {value}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  body: { padding: 16, gap: 14, paddingBottom: 40 },
  sectionLabel: { fontSize: 11, fontWeight: '700', letterSpacing: 0.4, marginBottom: 14 },
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  field: { width: '50%', marginBottom: 14 },
  evidenceRow: { marginBottom: 14 },
  evidenceHead: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8 },
  thumbRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  thumb: { width: 56, height: 56, alignItems: 'center', justifyContent: 'center' },
  audioRow: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12 },
  waveform: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 2, height: 20 },
  waveBar: { width: 2, borderRadius: 1 },
});
