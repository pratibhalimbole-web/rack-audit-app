import { Ionicons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { AppHeader } from '@/components/AppHeader';
import { Card } from '@/components/Card';
import { Pill } from '@/components/Pill';
import { ProgressBar } from '@/components/ProgressBar';
import { nextPending, rollup } from '@/lib/auditLogic';
import { useLocationsTree } from '@/hooks/useLocationsTree';
import type { LocationStatus, RackNode } from '@/lib/types';
import { useTheme } from '@/theme/ThemeProvider';
import { useAudits } from '../dashboard/hooks';

// Ports renderProgress() (rack-audit-app.html ~4169-4232) — the phone
// rack/bay breakdown: KPI row, then one card per rack listing its bays with
// a done/in-progress/not-started state and a "Continue to X" sticky action.
export function ProgressScreen() {
  const { tokens } = useTheme();
  const { auditId } = useLocalSearchParams<{ auditId: string }>();
  const { data: audits } = useAudits();
  const audit = audits?.find((a) => a.audit_id === auditId);
  const { data: tree, isLoading } = useLocationsTree(auditId);

  if (!audit || isLoading || !tree) {
    return (
      <View style={[styles.loading, { backgroundColor: tokens.muted }]}>
        <ActivityIndicator color={tokens.primary} />
      </View>
    );
  }

  const r = rollup(tree);
  const np = nextPending(tree);
  const layouts = tree.layouts;

  const bayStatus = (rack: RackNode, bayCode: string): { status: LocationStatus | 'In Progress'; done: number; total: number } => {
    const bay = rack.bays.find((b) => b.code === bayCode)!;
    const done = bay.locations.filter((l) => l.status === 'Completed').length;
    const total = bay.locations.length;
    const status = done === total ? 'Completed' : bay.locations.some((l) => l.status !== 'Not Started') ? 'In Progress' : 'Not Started';
    return { status, done, total };
  };

  return (
    <View style={{ flex: 1, backgroundColor: tokens.muted }}>
      <AppHeader title="Audit Progress" sub={`${audit.audit_id} · ${audit.scope_type} overview`} showBack menuItems={[{ label: 'Sync Now', onPress: () => {} }]} />
      <ScrollView contentContainerStyle={styles.body}>
        <View style={[styles.infoBanner, { backgroundColor: tokens.accentBlue.soft, borderColor: tokens.accentBlue.border }]}>
          <Text style={{ color: tokens.accentBlue.strong, fontSize: tokens.text.sm }}>Online · Synced</Text>
        </View>
        <Card>
          <View style={styles.kpiRow}>
            <Kpi value={`${r.rackDone}/${r.rackTotal}`} label="Racks" />
            <Kpi value={`${r.bayDone}/${r.bayTotal}`} label="Bays" />
            <Kpi value={`${r.locDone}/${r.locTotal}`} label="Locations" />
          </View>
        </Card>
        <View style={[styles.infoBanner, { backgroundColor: tokens.accentBlue.soft, borderColor: tokens.accentBlue.border }]}>
          <Text style={{ color: tokens.accentBlue.strong, fontSize: tokens.text.sm }}>
            When the last location in a bay is saved, the bay auto-completes — same logic rolls up to rack and layout.
          </Text>
        </View>

        {layouts.length ? (
          layouts.map((ly) => (
            <View key={ly.name} style={{ gap: 14 }}>
              {layouts.length > 1 ? (
                <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.base }}>{ly.name}</Text>
              ) : null}
              {ly.racks.map((rack) => {
                const rackDone = rack.bays.every((b) => b.locations.every((l) => l.status === 'Completed'));
                return (
                  <Card key={rack.code}>
                    <View style={styles.rackHeadRow}>
                      <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.extrabold, fontSize: tokens.text.base }}>Rack {rack.code}</Text>
                      <Pill label={rackDone ? 'Completed' : 'In Progress'} tone={rackDone ? 'Completed' : 'In Progress'} />
                    </View>
                    <View style={{ gap: 8 }}>
                      {rack.bays.map((bay) => {
                        const { status, done, total } = bayStatus(rack, bay.code);
                        const pct = total ? Math.round((done / total) * 100) : 0;
                        const openLoc = bay.locations.find((l) => l.status !== 'Completed') ?? bay.locations[0];
                        const isTarget = !!np && np.layout === ly.name && np.rack === rack.code && np.bay === bay.code;
                        return (
                          <Pressable
                            key={bay.code}
                            onPress={() =>
                              router.push({
                                pathname: '/audit/[auditId]/count-sheet',
                                params: { auditId, layout: ly.name, rack: rack.code, bay: bay.code, loc: openLoc?.code ?? '' },
                              } as never)
                            }
                            style={[styles.bayCard, { borderColor: isTarget ? tokens.primary : tokens.border, borderRadius: tokens.radius.lg }]}
                          >
                            <Ionicons
                              name={status === 'Completed' ? 'checkmark-circle' : 'cube-outline'}
                              size={20}
                              color={status === 'Completed' ? tokens.rag.green.strong : tokens.mutedForeground}
                            />
                            <View style={{ flex: 1 }}>
                              <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm }}>Bay {bay.code}</Text>
                              <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xs, marginTop: 2 }}>
                                {status} · {done}/{total} Locations
                              </Text>
                              {status === 'In Progress' ? (
                                <View style={{ marginTop: 6 }}>
                                  <ProgressBar pct={pct} />
                                </View>
                              ) : null}
                            </View>
                            <Ionicons name="chevron-forward" size={16} color={tokens.slate400} />
                          </Pressable>
                        );
                      })}
                    </View>
                  </Card>
                );
              })}
            </View>
          ))
        ) : (
          <Card style={styles.emptyCard}>
            <Ionicons name="cube-outline" size={26} color={tokens.slate400} />
            <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.sm }}>No racks in scope yet.</Text>
          </Card>
        )}
      </ScrollView>
      <View style={[styles.footerBar, { backgroundColor: tokens.card, borderTopColor: tokens.border }]}>
        <Pressable
          onPress={() =>
            np
              ? router.push({
                  pathname: '/audit/[auditId]/count-sheet',
                  params: { auditId, layout: np.layout, rack: np.rack, bay: np.bay, loc: np.loc.code },
                } as never)
              : router.push({ pathname: '/audit/[auditId]/summary', params: { auditId } } as never)
          }
          style={[styles.footerBtn, { backgroundColor: tokens.primary, borderRadius: tokens.radius.xxl }]}
        >
          <Text style={{ color: tokens.primaryForeground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm }}>
            {np ? `Continue to ${np.loc.code}` : 'View Audit Summary'}
          </Text>
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
  body: { padding: 16, gap: 14, paddingBottom: 100 },
  infoBanner: { borderWidth: 1, borderRadius: 10, padding: 12 },
  kpiRow: { flexDirection: 'row' },
  rackHeadRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  bayCard: { flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: 1, padding: 12 },
  emptyCard: { alignItems: 'center', gap: 8, paddingVertical: 24 },
  footerBar: { padding: 16, borderTopWidth: StyleSheet.hairlineWidth },
  footerBtn: { height: 48, alignItems: 'center', justifyContent: 'center' },
});
