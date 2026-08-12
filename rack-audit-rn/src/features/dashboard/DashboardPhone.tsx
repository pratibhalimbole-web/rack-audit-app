import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { AppHeader } from '@/components/AppHeader';
import { Card } from '@/components/Card';
import { Donut } from '@/components/Donut';
import { ProgressBar } from '@/components/ProgressBar';
import { TaskCard } from '@/components/TaskCard';
import { useAuthStore } from '@/store/useAuthStore';
import { flattenBays, fmtDate, priorityFor, uiStatus } from '@/lib/auditLogic';
import { useAuditProgress, useLocationsTree } from '@/hooks/useLocationsTree';
import type { Audit } from '@/lib/types';
import { useTheme } from '@/theme/ThemeProvider';
import { useCurrentOngoing, useMyAudits } from './hooks';

// Ports renderDashboard() (rack-audit-app.html ~1775-1872) — the phone
// layout: ongoing-audit card, task-progress donut, "My Audit Tasks" preview.
export function DashboardPhone() {
  const { tokens } = useTheme();
  const inspector = useAuthStore((s) => s.inspector);
  const { data: myTasks = [] } = useMyAudits();
  const ongoing = useCurrentOngoing();
  const { rollup, lastSaved } = useAuditProgress(ongoing?.audit_id);
  const { data: ongoingTree } = useLocationsTree(ongoing?.audit_id);

  const others = myTasks
    .filter((a) => a !== ongoing)
    .sort((a, b) => new Date(a.end_date).getTime() - new Date(b.end_date).getTime())
    .slice(0, 3);

  const totalTasks = myTasks.length;
  const completedTasks = myTasks.filter((a) => uiStatus(a) === 'Completed').length;
  const taskPct = totalTasks ? Math.round((completedTasks / totalTasks) * 100) : 0;
  const pct = rollup.locTotal ? Math.round((rollup.locDone / rollup.locTotal) * 100) : 0;
  const isFullyCounted = rollup.locTotal > 0 && rollup.locDone === rollup.locTotal;

  return (
    <View style={{ flex: 1, backgroundColor: tokens.muted }}>
      <AppHeader
        title="Dashboard"
        sub={inspector ? `${inspector.name.split(' ')[0]} · ${inspector.warehouse}` : undefined}
        avatar
        menuItems={[
          { label: 'Refresh', onPress: () => {} },
          { label: 'Settings', onPress: () => router.push('/settings') },
          { label: 'Help', onPress: () => {} },
          { label: 'Log out', onPress: () => useAuthStore.getState().signOut() },
        ]}
      />
      <ScrollView contentContainerStyle={styles.body}>
        <View style={styles.syncLine}>
          <View style={[styles.syncDot, { backgroundColor: tokens.rag.green.base }]} />
          <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xs }}>All caught up</Text>
          <Text style={{ color: tokens.slate400, fontSize: tokens.text.xxs, marginLeft: 'auto' }}>Synced 2 min ago</Text>
        </View>

        {ongoing ? (
          <Card>
            <View style={[styles.cardTitleRow, { borderBottomColor: tokens.border }]}>
              <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.extrabold, fontSize: tokens.text.base }}>
                Ongoing Audit
              </Text>
            </View>
            <View style={{ gap: 12 }}>
              <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
                <Text style={{ flex: 1, color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.base }}>
                  {ongoing.audit_name}
                </Text>
                <PriorityBadge audit={ongoing} />
              </View>
              <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xs }}>
                {ongoing.audit_id} · {ongoing.scope_values.join(', ')}
              </Text>
              <View>
                <View style={styles.progressLabelRow}>
                  <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xs }}>
                    {rollup.locDone}/{rollup.locTotal} locations counted
                  </Text>
                  <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.xs }}>{pct}%</Text>
                </View>
                <ProgressBar pct={pct} />
              </View>
              <View style={styles.metaRow}>
                <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xs }}>Due {fmtDate(ongoing.end_date)}</Text>
                {lastSaved ? (
                  <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xs }}>
                    Last <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold }}>{lastSaved.loc.code}</Text>
                  </Text>
                ) : null}
              </View>
              <Pressable
                onPress={() => {
                  if (isFullyCounted) {
                    router.push({ pathname: '/audit/[auditId]/summary', params: { auditId: ongoing.audit_id } } as never);
                    return;
                  }
                  // Resume Audit skips Audit Details entirely — straight to
                  // the Rack View canvas + form, picking up exactly where
                  // the inspector left off (the last-touched location).
                  if (lastSaved) {
                    router.push({
                      pathname: '/audit/[auditId]/rack/[rackId]',
                      params: { auditId: ongoing.audit_id, rackId: lastSaved.rack, layout: lastSaved.layout, bay: lastSaved.bay, loc: lastSaved.loc.code },
                    } as never);
                    return;
                  }
                  // Nothing touched yet — fall back to the first bay with
                  // work left (or the first bay overall).
                  const flatBays = flattenBays(ongoingTree);
                  const targetBay = flatBays.find((b) => !b.done) ?? flatBays[0];
                  if (targetBay) {
                    router.push({
                      pathname: '/audit/[auditId]/rack/[rackId]',
                      params: { auditId: ongoing.audit_id, rackId: targetBay.rack, layout: targetBay.layout, bay: targetBay.code },
                    } as never);
                    return;
                  }
                  router.push({ pathname: '/audit/[auditId]', params: { auditId: ongoing.audit_id } } as never);
                }}
                style={[styles.actionBtn, { backgroundColor: tokens.primary, borderRadius: tokens.radius.xxl }]}
              >
                <Text style={{ color: tokens.primaryForeground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm }}>
                  {isFullyCounted ? 'View Audit Summary' : 'Resume Audit'}
                </Text>
                <Ionicons name="chevron-forward" size={16} color={tokens.primaryForeground} />
              </Pressable>
            </View>
          </Card>
        ) : (
          <EmptyOngoingCard />
        )}

        <Card>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
            <Donut pct={taskPct} />
            <View>
              <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm }}>Task Progress</Text>
              <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xs, marginTop: 2 }}>
                {completedTasks}/{totalTasks} audits completed
              </Text>
            </View>
          </View>
        </Card>

        <View style={styles.sectionHeadRow}>
          <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.extrabold, fontSize: tokens.text.base }}>My Audit Tasks</Text>
          <Pressable onPress={() => router.push('/tasks')}>
            <Text style={{ color: tokens.primary, fontWeight: tokens.fontWeight.semibold, fontSize: tokens.text.sm }}>View All</Text>
          </Pressable>
        </View>
        {others.length ? (
          <View style={{ gap: 10 }}>
            {others.map((a) => (
              <TaskCard key={a.audit_id} audit={a} />
            ))}
          </View>
        ) : (
          <Card>
            <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.sm, textAlign: 'center' }}>No other tasks assigned.</Text>
          </Card>
        )}
      </ScrollView>
    </View>
  );
}

function PriorityBadge({ audit }: { audit: Audit }) {
  const { tokens } = useTheme();
  const p = priorityFor(audit);
  const colors = p === 'High' ? tokens.rag.red : p === 'Medium' ? tokens.rag.amber : tokens.rag.green;
  return (
    <View style={[styles.priorityBadge, { backgroundColor: colors.soft, borderRadius: tokens.radius.sm }]}>
      <Text style={{ color: colors.strong, fontSize: tokens.text.xxs, fontWeight: tokens.fontWeight.bold }}>{p}</Text>
    </View>
  );
}

function EmptyOngoingCard() {
  const { tokens } = useTheme();
  return (
    <Card style={styles.emptyCard}>
      <Ionicons name="cube-outline" size={26} color="#667085" />
      <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.base }}>No audit in progress</Text>
      <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.sm }}>Open a task below to start one.</Text>
    </Card>
  );
}

const styles = StyleSheet.create({
  body: { padding: 16, gap: 14 },
  syncLine: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  syncDot: { width: 6, height: 6, borderRadius: 3 },
  cardTitleRow: { paddingBottom: 12, marginBottom: 4, borderBottomWidth: StyleSheet.hairlineWidth },
  progressLabelRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 },
  metaRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  actionBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, height: 44 },
  priorityBadge: { paddingHorizontal: 8, paddingVertical: 3, flexShrink: 0 },
  sectionHeadRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 4 },
  emptyCard: { alignItems: 'center', gap: 6, paddingVertical: 22 },
});
