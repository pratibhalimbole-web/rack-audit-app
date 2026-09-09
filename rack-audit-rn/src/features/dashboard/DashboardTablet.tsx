import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { runOnJS } from 'react-native-reanimated';
import { AppHeader } from '@/components/AppHeader';
import { Card } from '@/components/Card';
import { ProgressBar } from '@/components/ProgressBar';
import { Pill } from '@/components/Pill';
import { AUDIT_TYPE_ICON } from '@/lib/auditTypeIcon';
import { useAuthStore } from '@/store/useAuthStore';
import { flattenBays, fmtDate, uiStatus } from '@/lib/auditLogic';
import { useAuditProgress, useAuditProgressMap, useLocationsTree } from '@/hooks/useLocationsTree';
import type { Audit } from '@/lib/types';
import { useTheme } from '@/theme/ThemeProvider';
import { useMyAudits } from './hooks';

// Ports renderDashboardTablet() (rack-audit-app.html ~1877-2000) —
// genuinely different content from the phone dashboard: a dashed banner for
// the current/first audit, an overview + ongoing-project card row, and a
// table-style task list instead of stacked cards.
export function DashboardTablet() {
  const { tokens } = useTheme();
  const inspector = useAuthStore((s) => s.inspector);
  const { data: myTasks = [] } = useMyAudits();
  // Every audit whose own status field is literally "In Progress" —
  // independent of whether it's also run past its end date. Folding an
  // overdue-but-in-progress audit into "Overdue" (uiStatus/currentOngoing's
  // definition) made the Ongoing count and card silently drop it, which is
  // what caused the mismatch: 2 audits genuinely in progress, 0 counted.
  const ongoingAudits = myTasks.filter((a) => a.status === 'In Progress');
  const [ongoingIndex, setOngoingIndex] = useState(0);
  const activeOngoingIndex = Math.min(ongoingIndex, Math.max(0, ongoingAudits.length - 1));
  const ongoing = ongoingAudits[activeOngoingIndex];
  const banner = ongoing ?? myTasks[0];

  // Slide left/right on the card to page to the next/previous ongoing
  // audit — the dots below still work too, this just makes the "swipe to
  // see another one" gesture actually do something.
  const stepOngoing = (dir: 1 | -1) => {
    setOngoingIndex((prev) => {
      const base = Math.min(prev, Math.max(0, ongoingAudits.length - 1));
      return (base + dir + ongoingAudits.length) % ongoingAudits.length;
    });
  };
  const ongoingSwipeGesture = Gesture.Pan()
    .activeOffsetX([-15, 15])
    .onEnd((e) => {
      if (ongoingAudits.length <= 1) return;
      if (e.translationX < -40) runOnJS(stepOngoing)(1);
      else if (e.translationX > 40) runOnJS(stepOngoing)(-1);
    });

  const auditIds = myTasks.map((a) => a.audit_id);
  const { map } = useAuditProgressMap(auditIds);
  const bannerProgress = useAuditProgress(banner?.audit_id);
  const { data: bannerTree } = useLocationsTree(banner?.audit_id);

  const totalAudits = myTasks.length;
  const ongoingCount = ongoingAudits.length;
  const completedCount = myTasks.filter((a) => uiStatus(a) === 'Completed').length;
  // Scheduled but not yet started, and not overdue — same bucket the To Do
  // board's own date columns pull from, just counted here as one number.
  const upcomingCount = myTasks.filter((a) => uiStatus(a) === 'To Do').length;

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
          <View style={[styles.banner, { borderColor: tokens.primary, borderRadius: tokens.radius.xl }]}>
            <BannerField label="Audit Name" value={banner.audit_name} />
            <BannerField label="Scheduled" value={`${fmtDate(banner.start_date)} to ${fmtDate(banner.end_date)}`} />
            <BannerField label="Total Locations" value={String(bannerProgress.rollup.locTotal)} />
            <BannerField label="Last Counted" value={bannerProgress.lastSaved ? bannerProgress.lastSaved.loc.code : '—'} />
            <Pressable
              onPress={() => {
                if (!isOngoingBanner) {
                  router.push({ pathname: '/audit/[auditId]', params: { auditId: banner.audit_id } } as never);
                  return;
                }
                if (isFullyCounted) {
                  router.push({ pathname: '/audit/[auditId]/summary', params: { auditId: banner.audit_id } } as never);
                  return;
                }
                // Resume Audit skips Audit Details entirely — straight to
                // the Rack View canvas + form, picking up exactly where
                // the inspector left off (the last-touched location).
                if (bannerProgress.lastSaved) {
                  const { lastSaved } = bannerProgress;
                  router.push({
                    pathname: '/audit/[auditId]/rack/[rackId]',
                    params: { auditId: banner.audit_id, rackId: lastSaved.rack, layout: lastSaved.layout, bay: lastSaved.bay, loc: lastSaved.loc.code },
                  } as never);
                  return;
                }
                // Nothing touched yet — fall back to the first bay with
                // work left (or the first bay overall).
                const flatBays = flattenBays(bannerTree);
                const targetBay = flatBays.find((b) => !b.done) ?? flatBays[0];
                if (targetBay) {
                  router.push({
                    pathname: '/audit/[auditId]/rack/[rackId]',
                    params: { auditId: banner.audit_id, rackId: targetBay.rack, layout: targetBay.layout, bay: targetBay.code },
                  } as never);
                  return;
                }
                router.push({ pathname: '/audit/[auditId]', params: { auditId: banner.audit_id } } as never);
              }}
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
          <Card style={styles.overviewCardNarrow}>
            <View style={[styles.cardHeadRow, { borderBottomColor: tokens.border }]}>
              <View>
                <Text style={[styles.cardTitle, { color: tokens.mutedForeground }]}>Audit Overview</Text>
                <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xs, marginTop: 2 }}>
                  Progress across all assigned audits
                </Text>
              </View>
              <OutlineButton label="See All" onPress={() => router.push('/tasks')} />
            </View>
            <View style={styles.statTileGrid}>
              <StatTile value={totalAudits} label="Total Assigned Audits" icon="clipboard-outline" />
              <StatTile value={upcomingCount} label="Upcoming" icon="time-outline" />
              <StatTile value={ongoingCount} label="Ongoing" icon="sync-outline" />
              <StatTile value={completedCount} label="Completed" icon="checkmark-circle-outline" />
            </View>
          </Card>

          {ongoing ? (
            <Card style={styles.overviewCardWide}>
              <View style={[styles.cardHeadRow, { borderBottomColor: tokens.border }]}>
                <View>
                  <View style={styles.ongoingTitleRow}>
                    <Text style={[styles.cardTitle, { color: tokens.mutedForeground }]}>Ongoing Audit</Text>
                    <View style={[styles.todayPill, { backgroundColor: tokens.accentBlue.soft, borderRadius: tokens.radius.lg }]}>
                      <View style={[styles.todayDot, { backgroundColor: tokens.accentBlue.strong }]} />
                      <Text style={{ color: tokens.accentBlue.strong, fontSize: tokens.text.xxs, fontWeight: tokens.fontWeight.bold }}>Today</Text>
                    </View>
                  </View>
                  <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xs, marginTop: 2 }}>
                    Total Ongoing : {String(ongoingAudits.length).padStart(2, '0')}
                  </Text>
                </View>
                <OutlineButton
                  label="See Details"
                  onPress={() => router.push({ pathname: '/audit/[auditId]', params: { auditId: ongoing.audit_id } } as never)}
                />
              </View>
              <GestureDetector gesture={ongoingSwipeGesture}>
                <View style={[styles.ongoingCardBox, { borderColor: tokens.accentBlue.base, borderRadius: 8 }]}>
                  <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm }} numberOfLines={1}>
                    {ongoing.audit_name}
                  </Text>
                  <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xs, marginTop: 2 }}>{ongoing.audit_id}</Text>
                  <Text style={[styles.sectionLabel, { color: tokens.mutedForeground }]}>Audit Details</Text>
                  <View style={styles.detailGrid}>
                    <DetailField label="Start Date" value={fmtDate(ongoing.start_date)} />
                    <DetailField label="End Date" value={fmtDate(ongoing.end_date)} />
                    <DetailField label="Layout" value={ongoing.scope_type === 'Layout' && ongoing.scope_values.length ? ongoing.scope_values.join(', ') : '—'} />
                    <DetailField label="Rack" value={String(bannerProgress.rollup.rackTotal)} />
                    <DetailField label="Total Bays" value={String(bannerProgress.rollup.bayTotal)} />
                    <DetailField label="Pending Bays" value={String(bannerProgress.rollup.bayTotal - bannerProgress.rollup.bayDone)} />
                    <DetailField label="Locations Scanned" value={String(bannerProgress.rollup.locDone)} />
                    <DetailField label="Locations Pending" value={String(bannerProgress.rollup.locTotal - bannerProgress.rollup.locDone)} />
                  </View>
                </View>
              </GestureDetector>
              {ongoingAudits.length > 1 ? (
                // One dot per ongoing audit — tap a dot, or slide the card
                // above left/right, to page to that audit.
                <View style={styles.dotRow}>
                  {ongoingAudits.map((a, i) => (
                    <Pressable key={a.audit_id} onPress={() => setOngoingIndex(i)} hitSlop={8}>
                      <View
                        style={[
                          styles.dot,
                          { backgroundColor: i === activeOngoingIndex ? tokens.primary : tokens.border },
                        ]}
                      />
                    </Pressable>
                  ))}
                </View>
              ) : null}
            </Card>
          ) : (
            <Card style={[styles.overviewCardWide, styles.emptyCard]}>
              <Ionicons name="cube-outline" size={26} color="#667085" />
              <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.base }}>
                No audit in progress
              </Text>
              <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.sm }}>Open a task below to start one.</Text>
            </Card>
          )}
        </View>

        <Card>
          <View style={[styles.cardHeadRow, { borderBottomColor: tokens.border }]}>
            <View>
              <Text style={[styles.cardTitle, { color: tokens.mutedForeground }]}>My Assigned Tasks</Text>
              <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xs, marginTop: 2 }}>Total Audits : {totalAudits}</Text>
            </View>
            <OutlineButton label="View All Tasks" onPress={() => router.push('/tasks')} />
          </View>
          <View style={{ marginTop: 12, gap: 8 }}>
            {myTasks.length ? (
              // Card only ever previews up to 3 — however many there really
              // are (up to 7 or more), the rest live behind "View All Tasks".
              myTasks.slice(0, 3).map((a) => <AuditListRow key={a.audit_id} audit={a} locTotal={map[a.audit_id]?.rollup.locTotal ?? 0} />)
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

// A 2x2 tile grid replaces the old single-row Stat + progress bar — plain
// neutral tiles, no per-category tint.
function StatTile({ value, label, icon }: { value: number; label: string; icon: keyof typeof Ionicons.glyphMap }) {
  const { tokens } = useTheme();
  return (
    <View style={[styles.statTile, { backgroundColor: tokens.muted, borderColor: tokens.border, borderWidth: 1 }]}>
      <View style={styles.statTileLabelRow}>
        <Ionicons name={icon} size={13} color={tokens.mutedForeground} />
        <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xs, fontWeight: tokens.fontWeight.semibold }}>{label}</Text>
      </View>
      <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.extrabold, fontSize: 22, marginTop: 4 }}>{value}</Text>
    </View>
  );
}

function DetailField({ label, value }: { label: string; value: string }) {
  const { tokens } = useTheme();
  return (
    <View style={{ width: '25%', marginBottom: 10 }}>
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
  banner: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 20, borderWidth: 1.5, borderStyle: 'dashed', padding: 16 },
  bannerField: { flex: 1, minWidth: 120 },
  bannerBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 16, height: 40, marginLeft: 'auto' },
  overviewRow: { flexDirection: 'row', gap: 16 },
  // Audit Overview no longer carries a progress bar, so it needs less
  // width than the Ongoing Audit card next to it — narrower here, wider
  // there, so the row still reads as balanced rather than the first card
  // leaving obvious empty space.
  overviewCardNarrow: { flex: 0.82 },
  overviewCardWide: { flex: 1.18 },
  cardHeadRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderBottomWidth: StyleSheet.hairlineWidth, paddingBottom: 12, marginBottom: 8 },
  cardTitle: { fontSize: 11, fontWeight: '700', letterSpacing: 0.4, textTransform: 'uppercase' },
  statTileGrid: { flexDirection: 'row', flexWrap: 'wrap', rowGap: 12, columnGap: 22, marginTop: 16 },
  statTile: { flexBasis: '47%', flexGrow: 1, borderRadius: 14, padding: 14 },
  statTileLabelRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  sectionLabel: { fontSize: 11, fontWeight: '700', marginTop: 14, marginBottom: 8 },
  detailGrid: { flexDirection: 'row', flexWrap: 'wrap' },
  ongoingCardBox: { borderWidth: 1.5, padding: 12, marginTop: 14 },
  ongoingTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  todayPill: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 8, paddingVertical: 3 },
  todayDot: { width: 5, height: 5, borderRadius: 2.5 },
  dotRow: { flexDirection: 'row', justifyContent: 'center', gap: 8, marginTop: 4 },
  dot: { width: 7, height: 7, borderRadius: 3.5 },
  outlineBtn: { borderWidth: 1, paddingHorizontal: 12, paddingVertical: 7 },
  emptyCard: { alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 22 },
  listRow: { flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, padding: 10 },
  iconWrap: { width: 34, height: 34, alignItems: 'center', justifyContent: 'center' },
});
