import { Ionicons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import { AppHeader } from '@/components/AppHeader';
import { Card } from '@/components/Card';
import { fmtDate, rollup, uiStatus } from '@/lib/auditLogic';
import { useLocationsTree } from '@/hooks/useLocationsTree';
import { buildFindings, type Finding, type FindingType } from '@/lib/findings';
import { useTheme } from '@/theme/ThemeProvider';
import { useAudits } from '../dashboard/hooks';

// A completed audit's own reported-issues grid — reached by tapping its
// card on the Completed Task screen. Same card-grid shape as a structural
// inspection's "Task Details" (colored severity dot + Total badge + one
// card per finding), just built from this app's own Reconciliation
// Findings data (buildFindings) instead of a defect-PIN/element model this
// app has no such fields for.
const SEVERITY_DOT: Record<FindingType, 'red' | 'amber' | 'green'> = {
  'Pallet Damage': 'red',
  'Mismatched SKU': 'amber',
  'Missing SKU': 'amber',
  'Manual Report': 'amber',
  'Pallet Empty': 'green',
};

export function TaskDetailsScreen() {
  const { tokens } = useTheme();
  const { auditId } = useLocalSearchParams<{ auditId: string }>();
  const { data: audits } = useAudits();
  const audit = audits?.find((a) => a.audit_id === auditId);
  const { data: tree, isLoading } = useLocationsTree(auditId);

  if (!audit || isLoading) {
    return (
      <View style={[styles.loading, { backgroundColor: tokens.muted }]}>
        <ActivityIndicator color={tokens.primary} />
      </View>
    );
  }

  const r = rollup(tree);
  const findings: Finding[] = buildFindings([audit], { [auditId]: tree }, [], undefined, undefined);
  const uis = uiStatus(audit);

  return (
    <View style={{ flex: 1, backgroundColor: tokens.muted }}>
      <AppHeader title="Task Details" showBack menuItems={[{ label: 'Sync Now', onPress: () => {} }]} />
      <ScrollView contentContainerStyle={styles.body}>
        <Card>
          <View style={styles.sectionLabelRow}>
            <View style={[styles.iconWrap, { backgroundColor: tokens.accentBlue.soft }]}>
              <Ionicons name="search-outline" size={16} color={tokens.accentBlue.strong} />
            </View>
            <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.base }}>Inspection Details</Text>
          </View>
          <View style={styles.grid}>
            <Field label="Audit Type" value={audit.audit_type} />
            <Field label="Inspection Date" value={fmtDate(audit.end_date)} />
            <Field label="Total Bay" value={String(r.bayTotal).padStart(2, '0')} />
            <View style={styles.field}>
              <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm, marginBottom: 4 }}>Status</Text>
              <View style={[styles.statusPill, { backgroundColor: tokens.rag[uis === 'Completed' ? 'green' : 'amber'].soft, borderRadius: tokens.radius.lg }]}>
                <Text
                  style={{
                    color: tokens.rag[uis === 'Completed' ? 'green' : 'amber'].strong,
                    fontSize: tokens.text.xs,
                    fontWeight: tokens.fontWeight.bold,
                  }}
                >
                  {audit.status}
                </Text>
              </View>
            </View>
            <Field label="Total Issue Reported" value={String(findings.length)} />
            <Field label="Total Locations" value={String(r.locTotal).padStart(2, '0')} />
          </View>
        </Card>

        <View style={[styles.totalBadge, { backgroundColor: tokens.accentBlue.soft, borderRadius: tokens.radius.lg }]}>
          <Text style={{ color: tokens.accentBlue.strong, fontSize: tokens.text.sm, fontWeight: tokens.fontWeight.bold }}>Total : {findings.length}</Text>
        </View>

        {findings.length ? (
          <View style={styles.findingsGrid}>
            {findings.map((f, i) => {
              const dotKey = SEVERITY_DOT[f.findingType];
              return (
                <View key={`${f.discId}-${f.unitId}-${i}`} style={[styles.findingCard, { backgroundColor: tokens.card, borderColor: tokens.border, borderRadius: tokens.radius.xl }]}>
                  <View style={styles.findingHeadRow}>
                    <View style={styles.findingHeadLeft}>
                      <Ionicons name="pricetag-outline" size={14} color={tokens.mutedForeground} />
                      <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.semibold, fontSize: tokens.text.xs }} numberOfLines={1}>
                        DISC-ID : {f.discId}
                      </Text>
                    </View>
                    <View style={[styles.severityChip, { backgroundColor: tokens.rag[dotKey].soft, borderRadius: tokens.radius.lg }]}>
                      <Text style={{ color: tokens.rag[dotKey].strong, fontSize: tokens.text.xxs, fontWeight: tokens.fontWeight.bold }}>
                        {dotKey === 'red' ? 'Red' : dotKey === 'amber' ? 'Amber' : 'Green'}
                      </Text>
                    </View>
                  </View>
                  <View style={styles.findingBody}>
                    <CardField label="Location" full value={`${f.layout} · Rack ${f.rack} · Bay ${f.bay} · ${f.locCode}`} />
                    <View style={styles.findingRow}>
                      <CardField label="Issue Type" value={f.findingType} />
                      <CardField label="SKU" value={f.sku || '-'} />
                    </View>
                    <View style={styles.findingRow}>
                      <CardField label="Pallet" value={f.pallet} />
                      <CardField label="Inspected on" value={f.inspectedOn} />
                    </View>
                  </View>
                </View>
              );
            })}
          </View>
        ) : (
          <Card style={styles.emptyCard}>
            <Ionicons name="checkmark-circle-outline" size={26} color="#667085" />
            <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.base }}>No issues reported</Text>
            <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.sm }}>Every pallet in this audit matched what was expected.</Text>
          </Card>
        )}
      </ScrollView>
    </View>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  const { tokens } = useTheme();
  return (
    <View style={styles.field}>
      <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm, marginBottom: 4 }}>{label}</Text>
      <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.sm }} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

function CardField({ label, value, full }: { label: string; value: string; full?: boolean }) {
  const { tokens } = useTheme();
  return (
    <View style={[styles.cardFieldWrap, full ? { width: '100%' } : null]}>
      <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xxs, marginBottom: 2 }}>{label}</Text>
      <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.semibold, fontSize: tokens.text.sm }} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  body: { padding: 16, gap: 14, paddingBottom: 40 },
  sectionLabelRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 4 },
  iconWrap: { width: 28, height: 28, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 12 },
  field: { width: '25%', minWidth: 140, marginBottom: 14 },
  statusPill: { alignSelf: 'flex-start', paddingHorizontal: 10, paddingVertical: 4 },
  totalBadge: { alignSelf: 'flex-start', paddingHorizontal: 12, paddingVertical: 5 },
  findingsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 14 },
  findingCard: { flexGrow: 0, flexShrink: 0, flexBasis: '23%', minWidth: 240, borderWidth: 1, overflow: 'hidden' },
  findingHeadRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingVertical: 10 },
  findingHeadLeft: { flexDirection: 'row', alignItems: 'center', gap: 6, flex: 1, minWidth: 0 },
  severityChip: { paddingHorizontal: 8, paddingVertical: 3 },
  findingBody: { padding: 12, gap: 10 },
  findingRow: { flexDirection: 'row', gap: 10 },
  cardFieldWrap: { flex: 1 },
  emptyCard: { alignItems: 'center', gap: 8, paddingVertical: 24 },
});
