import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { AppHeader } from '@/components/AppHeader';
import { Card } from '@/components/Card';
import { ProgressBar } from '@/components/ProgressBar';
import { Pill } from '@/components/Pill';
import { AUDIT_TYPE_ICON } from '@/lib/auditTypeIcon';
import { useAuthStore } from '@/store/useAuthStore';
import { fmtDate, uiStatus } from '@/lib/auditLogic';
import { useAuditProgress, useAuditProgressMap } from '@/hooks/useLocationsTree';
import type { Audit } from '@/lib/types';
import { useTheme } from '@/theme/ThemeProvider';
import { useCurrentOngoing, useMyAudits } from './hooks';

// Ports renderDashboardTablet() (rack-audit-app.html ~1877-2000) —
// genuinely different content from the phone dashboard: a dashed banner for
// the current/first audit, an overview + ongoing-project card row, and a
// table-style task list instead of stacked cards.
export function DashboardTablet() {
  const { tokens } = useTheme();
  const inspector = useAuthStore((s) => s.inspector);
  const { data: myTasks = [] } = useMyAudits();
  const ongoing = useCurrentOngoing();
  const banner = ongoing ?? myTasks[0];

  const auditIds = myTasks.map((a) => a.audit_id);
  const { map } = useAuditProgressMap(auditIds);
  const bannerProgress = useAuditProgress(banner?.audit_id);

  const totalAudits = myTasks.length;
  const ongoingCount = myTasks.filter((a) => uiStatus(a) === 'In Progress').length;
  const completedCount = myTasks.filter((a) => uiStatus(a) === 'Completed').length;
  const sumLoc = auditIds.reduce(
    (acc, id) => {
      const r = map[id]?.rollup;
      if (r) {
        acc.done += r.locDone;
        acc.total += r.locTotal;
      }
      return acc;
    },
    { done: 0, total: 0 },
  );
  const overallPct = sumLoc.total ? Math.round((sumLoc.done / sumLoc.total) * 100) : 0;

  const isFullyCounted = bannerProgress.rollup.locTotal > 0 && bannerProgress.rollup.locDone === bannerProgress.rollup.locTotal;
  const isOngoingBanner = banner === ongoing;
  const bannerActionLabel = !isOngoingBanner ? 'Open Audit' : isFullyCounted ? 'View Audit Summary' : 'Resume Audit';

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

        {banner ? (
          <View style={[styles.banner, { borderColor: tokens.border, borderRadius: tokens.radius.xl }]}>
            <BannerField label="Audit Name" value={banner.audit_name} />
            <BannerField label="Scheduled" value={`${fmtDate(banner.start_date)} to ${fmtDate(banner.end_date)}`} />
            <BannerField label="Total Locations" value={String(bannerProgress.rollup.locTotal)} />
            <BannerField label="Last Counted" value={bannerProgress.lastSaved ? bannerProgress.lastSaved.loc.code : '—'} />
            <Pressable
              onPress={() => router.push({ pathname: '/audit/[auditId]', params: { auditId: banner.audit_id } } as never)}
              style={[styles.bannerBtn, { backgroundColor: tokens.primary, borderRadius: tokens.radius.xxl }]}
            >
              <Text style={{ color: tokens.primaryForeground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm }}>
                {bannerActionLabel}
              </Text>
              <Ionicons name="chevron-forward" size={16} color={tokens.primaryForeground} />
            </Pressable>
          </View>
        ) : null}

        <View style={styles.overviewRow}>
          <Card style={styles.overviewCard}>
            <View style={styles.cardHeadRow}>
              <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.extrabold, fontSize: tokens.text.base }}>
                Audit Overview
              </Text>
              <OutlineButton label="See All" onPress={() => router.push('/tasks')} />
            </View>
            <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xs, marginTop: 2 }}>
              Progress across all assigned audits
            </Text>
            <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.extrabold, fontSize: 28, marginTop: 14 }}>
              {overallPct}%
            </Text>
            <ProgressBar pct={overallPct} />
            <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xs, marginTop: 8 }}>
              {sumLoc.done}/{sumLoc.total} assigned locations counted
            </Text>
            <View style={styles.statsRow}>
              <Stat value={totalAudits} label="Total Audits" />
              <Stat value={ongoingCount} label="Ongoing" />
              <Stat value={completedCount} label="Completed" />
            </View>
          </Card>

          {ongoing ? (
            <Card style={styles.overviewCard}>
              <View style={styles.cardHeadRow}>
                <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.extrabold, fontSize: tokens.text.base }}>
                  Ongoing Audit
                </Text>
                <OutlineButton
                  label="See Details"
                  onPress={() => router.push({ pathname: '/audit/[auditId]', params: { auditId: ongoing.audit_id } } as never)}
                />
              </View>
              <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xs, marginTop: 2 }}>
                {ongoing.audit_id} · {ongoing.audit_name}
              </Text>
              <Text style={[styles.sectionLabel, { color: tokens.mutedForeground }]}>Inspection Details</Text>
              <View style={styles.detailGrid}>
                <DetailField label="Warehouse" value={inspector?.warehouse ?? '—'} />
                <DetailField label="Rack" value={String(bannerProgress.rollup.rackTotal)} />
                <DetailField label="Total Bays" value={String(bannerProgress.rollup.bayTotal)} />
                <DetailField label="Pending Bays" value={String(bannerProgress.rollup.bayTotal - bannerProgress.rollup.bayDone)} />
              </View>
            </Card>
          ) : (
            <Card style={[styles.overviewCard, styles.emptyCard]}>
              <Ionicons name="cube-outline" size={26} color="#667085" />
              <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.base }}>
                No audit in progress
              </Text>
              <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.sm }}>Open a task below to start one.</Text>
            </Card>
          )}
        </View>

        <Card>
          <View style={styles.cardHeadRow}>
            <View>
              <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.extrabold, fontSize: tokens.text.base }}>
                My Audit Tasks
              </Text>
              <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xs, marginTop: 2 }}>Total Audits : {totalAudits}</Text>
            </View>
            <OutlineButton label="View All Tasks" onPress={() => router.push('/tasks')} />
          </View>
          <View style={{ marginTop: 12, gap: 8 }}>
            {myTasks.length ? (
              myTasks.map((a) => <AuditListRow key={a.audit_id} audit={a} locTotal={map[a.audit_id]?.rollup.locTotal ?? 0} />)
            ) : (
              <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.sm, textAlign: 'center', paddingVertical: 20 }}>
                No audits assigned.
              </Text>
            )}
          </View>
        </Card>
      </ScrollView>
    </View>
  );
}

function BannerField({ label, value }: { label: string; value: string }) {
  const { tokens } = useTheme();
  return (
    <View style={styles.bannerField}>
      <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xxs }}>{label}</Text>
      <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.semibold, fontSize: tokens.text.sm, marginTop: 2 }}>{value}</Text>
    </View>
  );
}

function Stat({ value, label }: { value: number; label: string }) {
  const { tokens } = useTheme();
  return (
    <View style={{ alignItems: 'center', flex: 1 }}>
      <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.extrabold, fontSize: tokens.text.lg }}>{value}</Text>
      <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xxs, marginTop: 2 }}>{label}</Text>
    </View>
  );
}

function DetailField({ label, value }: { label: string; value: string }) {
  const { tokens } = useTheme();
  return (
    <View style={{ width: '50%', marginBottom: 10 }}>
      <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xxs }}>{label}</Text>
      <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm, marginTop: 2 }}>{value}</Text>
    </View>
  );
}

function OutlineButton({ label, onPress }: { label: string; onPress: () => void }) {
  const { tokens } = useTheme();
  return (
    <Pressable onPress={onPress} style={[styles.outlineBtn, { borderColor: tokens.border, borderRadius: tokens.radius.lg }]}>
      <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.semibold, fontSize: tokens.text.xs }}>{label}</Text>
    </Pressable>
  );
}

function AuditListRow({ audit, locTotal }: { audit: Audit; locTotal: number }) {
  const { tokens } = useTheme();
  const uis = uiStatus(audit);
  return (
    <Pressable
      onPress={() => router.push({ pathname: '/audit/[auditId]', params: { auditId: audit.audit_id } } as never)}
      style={[styles.listRow, { borderColor: tokens.border, borderRadius: tokens.radius.lg }]}
    >
      <View style={[styles.iconWrap, { backgroundColor: tokens.muted, borderRadius: tokens.radius.lg }]}>
        <Ionicons name={AUDIT_TYPE_ICON[audit.audit_type]} size={16} color="#667085" />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text numberOfLines={1} style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm }}>
          {audit.audit_name}
        </Text>
        <Text numberOfLines={1} style={{ color: tokens.mutedForeground, fontSize: tokens.text.xs, marginTop: 2 }}>
          {audit.audit_id} · {audit.scope_values.join(', ')}
        </Text>
      </View>
      <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xs, marginRight: 10 }}>
        Due {fmtDate(audit.end_date)} | {locTotal} locations
      </Text>
      <Pill label={uis} tone={uis} />
      <Ionicons name="chevron-forward" size={16} color="#667085" style={{ marginLeft: 10 }} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  body: { padding: 20, gap: 16 },
  syncLine: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  syncDot: { width: 6, height: 6, borderRadius: 3 },
  banner: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 20, borderWidth: 1, borderStyle: 'dashed', padding: 16 },
  bannerField: { minWidth: 120 },
  bannerBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 16, height: 40, marginLeft: 'auto' },
  overviewRow: { flexDirection: 'row', gap: 16 },
  overviewCard: { flex: 1 },
  cardHeadRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  statsRow: { flexDirection: 'row', marginTop: 16, borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 14 },
  sectionLabel: { fontSize: 11, fontWeight: '700', marginTop: 14, marginBottom: 8 },
  detailGrid: { flexDirection: 'row', flexWrap: 'wrap' },
  outlineBtn: { borderWidth: 1, paddingHorizontal: 12, paddingVertical: 7 },
  emptyCard: { alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 22 },
  listRow: { flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, padding: 10 },
  iconWrap: { width: 34, height: 34, alignItems: 'center', justifyContent: 'center' },
});
