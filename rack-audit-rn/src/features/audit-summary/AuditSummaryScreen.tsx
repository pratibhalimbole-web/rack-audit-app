import { Ionicons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { AppHeader } from '@/components/AppHeader';
import { Card } from '@/components/Card';
import { Pill } from '@/components/Pill';
import { rollup, summaryStats } from '@/lib/auditLogic';
import { useLocationsTree } from '@/hooks/useLocationsTree';
import { submitAudit } from '@/lib/auditsRepo';
import { CONDITIONS } from '@/lib/types';
import { useTheme } from '@/theme/ThemeProvider';
import { useAudits } from '../dashboard/hooks';
import { useQueryClient } from '@tanstack/react-query';

// Ports renderAuditSummary() (rack-audit-app.html ~4235-4303) — final KPIs,
// condition breakdown, and flagged-items list, shown once every location is
// completed (or reachable early to preview progress); Submit Audit flips the
// audit to Submitted and becomes a read-only summary from then on.
export function AuditSummaryScreen() {
  const { tokens } = useTheme();
  const { auditId } = useLocalSearchParams<{ auditId: string }>();
  const queryClient = useQueryClient();
  const { data: audits } = useAudits();
  const audit = audits?.find((a) => a.audit_id === auditId);
  const { data: tree, isLoading } = useLocationsTree(auditId);
  const [submitting, setSubmitting] = useState(false);

  if (!audit || isLoading) {
    return (
      <View style={[styles.loading, { backgroundColor: tokens.muted }]}>
        <ActivityIndicator color={tokens.primary} />
      </View>
    );
  }

  const r = rollup(tree);
  const s = summaryStats(tree);
  const nothingCounted = s.palletCount === 0;
  const conditionRows = CONDITIONS.filter((c) => s.byCondition[c]);

  const handleSubmit = async () => {
    setSubmitting(true);
    try {
      await submitAudit(auditId);
      await queryClient.invalidateQueries({ queryKey: ['audits'] });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: tokens.muted }}>
      <AppHeader title="Audit Summary" sub={`${audit.audit_id} · ${audit.scope_type} overview`} showBack menuItems={[{ label: 'Sync Now', onPress: () => {} }]} />
      <ScrollView contentContainerStyle={styles.body}>
        <View
          style={[
            styles.banner,
            nothingCounted ? { backgroundColor: tokens.accentBlue.soft, borderColor: tokens.accentBlue.border } : { backgroundColor: tokens.rag.green.soft, borderColor: tokens.rag.green.border },
          ]}
        >
          <Text style={{ color: nothingCounted ? tokens.accentBlue.strong : tokens.rag.green.strong, fontSize: tokens.text.sm }}>
            {nothingCounted
              ? 'No locations counted yet — totals below will fill in as the inspector saves pallet records.'
              : 'Audit fully counted — every assigned location has been completed.'}
          </Text>
        </View>

        <Card>
          <View style={styles.kpiRow}>
            <Kpi value={`${r.rackDone}/${r.rackTotal}`} label="Racks" />
            <Kpi value={`${r.bayDone}/${r.bayTotal}`} label="Bays" />
            <Kpi value={`${r.locDone}/${r.locTotal}`} label="Locations" />
          </View>
        </Card>
        <Card>
          <View style={styles.kpiRow}>
            <Kpi value={String(s.palletCount)} label="Pallets" />
            <Kpi value={String(s.lineCount)} label="SKU Lines" />
            <Kpi value={String(s.qtyTotal)} label="Total Qty" />
          </View>
        </Card>

        {nothingCounted ? (
          <Card style={styles.emptyCard}>
            <Ionicons name="cube-outline" size={26} color={tokens.slate400} />
            <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.base }}>Nothing counted yet</Text>
            <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.sm, textAlign: 'center' }}>
              Condition breakdown and flagged items will show up here once pallets are saved.
            </Text>
          </Card>
        ) : (
          <>
            {conditionRows.length ? (
              <Card>
                <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.extrabold, fontSize: tokens.text.base, marginBottom: 12 }}>
                  Condition Breakdown
                </Text>
                {conditionRows.map((c, i) => (
                  <View key={c} style={[styles.kvRow, i === conditionRows.length - 1 ? null : { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: tokens.border }]}>
                    <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.sm }}>{c}</Text>
                    <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.semibold, fontSize: tokens.text.sm }}>{s.byCondition[c]}</Text>
                  </View>
                ))}
              </Card>
            ) : null}

            {s.flagged.length ? (
              <Card>
                <View style={styles.flaggedHeadRow}>
                  <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.extrabold, fontSize: tokens.text.base }}>Flagged Items</Text>
                  <Pill label={String(s.flagged.length)} tone="Medium" />
                </View>
                {s.flagged.map((f, i) => (
                  <View
                    key={i}
                    style={[styles.kvRow, i === s.flagged.length - 1 ? null : { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: tokens.border }]}
                  >
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm }}>{f.name}</Text>
                      <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xs, marginTop: 1 }}>
                        {f.sku} · {f.locCode} · Qty {f.qty}
                      </Text>
                    </View>
                    <Pill label={f.condition} tone={f.condition === 'Damaged' || f.condition === 'Broken' ? 'Overdue' : 'Medium'} />
                  </View>
                ))}
              </Card>
            ) : null}
          </>
        )}

        {audit.status === 'Submitted' ? (
          <View style={[styles.banner, { backgroundColor: tokens.rag.green.soft, borderColor: tokens.rag.green.border }]}>
            <Text style={{ color: tokens.rag.green.strong, fontSize: tokens.text.sm }}>Already submitted — this is a read-only summary.</Text>
          </View>
        ) : null}
      </ScrollView>
      <View style={[styles.footerBar, { backgroundColor: tokens.card, borderTopColor: tokens.border }]}>
        {audit.status !== 'Submitted' ? (
          <Pressable
            disabled={submitting}
            onPress={handleSubmit}
            style={[styles.primaryBtn, { backgroundColor: tokens.primary, borderRadius: tokens.radius.xxl, opacity: submitting ? 0.6 : 1 }]}
          >
            <Text style={{ color: tokens.primaryForeground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm }}>Submit Audit</Text>
            <Ionicons name="checkmark" size={16} color={tokens.primaryForeground} />
          </Pressable>
        ) : null}
        <Pressable onPress={() => router.replace('/')} style={[styles.outlineBtn, { borderColor: tokens.border, borderRadius: tokens.radius.lg }]}>
          <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.semibold, fontSize: tokens.text.sm }}>Back to Dashboard</Text>
        </Pressable>
      </View>
    </View>
  );
}

function Kpi({ value, label }: { value: string; label: string }) {
  const { tokens } = useTheme();
  return (
    <View style={{ flex: 1, alignItems: 'center' }}>
      <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.extrabold, fontSize: tokens.text.lg }}>{value}</Text>
      <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xxs, marginTop: 2 }}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  body: { padding: 16, gap: 14, paddingBottom: 40 },
  banner: { borderWidth: 1, borderRadius: 10, padding: 12 },
  kpiRow: { flexDirection: 'row' },
  emptyCard: { alignItems: 'center', gap: 8, paddingVertical: 24 },
  kvRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 10, gap: 10 },
  flaggedHeadRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 },
  footerBar: { gap: 10, padding: 16, borderTopWidth: StyleSheet.hairlineWidth },
  primaryBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, height: 48 },
  outlineBtn: { alignItems: 'center', justifyContent: 'center', height: 48, borderWidth: 1 },
});
