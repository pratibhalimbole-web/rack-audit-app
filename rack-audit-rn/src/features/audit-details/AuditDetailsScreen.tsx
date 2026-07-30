import { Ionicons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { AppHeader } from '@/components/AppHeader';
import { Card } from '@/components/Card';
import { Pill } from '@/components/Pill';
import { fmtDate, priorityFor, rollup, uiStatus } from '@/lib/auditLogic';
import { useDeviceClass } from '@/hooks/useDeviceClass';
import { useLocationsTree } from '@/hooks/useLocationsTree';
import { useAuthStore } from '@/store/useAuthStore';
import type { AuditLocationsTree } from '@/lib/types';
import { useTheme } from '@/theme/ThemeProvider';
import { useAudits } from '../dashboard/hooks';

type FlatBay = { layout: string; rack: string; code: string; done: boolean; openLoc: string | null };

function flattenBays(tree: AuditLocationsTree | undefined): FlatBay[] {
  const layouts = tree?.layouts ?? [];
  const out: FlatBay[] = [];
  layouts.forEach((ly) =>
    ly.racks.forEach((rack) =>
      rack.bays.forEach((b) => {
        const done = b.locations.length > 0 && b.locations.every((l) => l.status === 'Completed');
        const openLoc = b.locations.find((l) => l.status !== 'Completed') ?? b.locations[0];
        out.push({ layout: ly.name, rack: rack.code, code: b.code, done, openLoc: openLoc ? openLoc.code : null });
      }),
    ),
  );
  return out;
}

// Ports renderAuditDetails() (rack-audit-app.html ~2374-2508): schedule
// card, bay-completion summary + pill grid (accordion once scope spans more
// than one rack), and a footer action button that reads Start/Resume/View
// Summary depending on progress.
export function AuditDetailsScreen() {
  const { tokens } = useTheme();
  const { auditId } = useLocalSearchParams<{ auditId: string }>();
  const inspector = useAuthStore((s) => s.inspector);
  const device = useDeviceClass();
  const isTablet = device === 'tablet';
  const { data: audits } = useAudits();
  const { data: tree, isLoading } = useLocationsTree(auditId);
  const [closedSections, setClosedSections] = useState<Record<string, boolean>>({});

  const audit = audits?.find((a) => a.audit_id === auditId);
  const r = useMemo(() => rollup(tree), [tree]);
  const layouts = tree?.layouts ?? [];
  const flatBays = useMemo(() => flattenBays(tree), [tree]);
  const bayDoneCount = flatBays.filter((b) => b.done).length;
  const bayPendingCount = flatBays.length - bayDoneCount;
  const totalRackCount = layouts.reduce((n, ly) => n + ly.racks.length, 0);

  if (!audit || isLoading) {
    return (
      <View style={[styles.loading, { backgroundColor: tokens.muted }]}>
        <ActivityIndicator color={tokens.primary} />
      </View>
    );
  }

  const isSubmitted = ['Submitted', 'Reconciled', 'Closed'].includes(audit.status);
  const isFullyCounted = r.locTotal > 0 && r.locTotal === r.locDone;
  const showCompletedState = isSubmitted || isFullyCounted;
  const startLabel = showCompletedState ? 'View Audit Summary' : audit.status === 'In Progress' ? 'Resume Audit' : 'Start Audit';

  const toggleSection = (key: string) => setClosedSections((prev) => ({ ...prev, [key]: !prev[key] }));
  const isOpen = (key: string) => !closedSections[key];

  const onPressBay = (bay: FlatBay) => {
    if (isSubmitted) return;
    if (isTablet) {
      router.push({ pathname: '/audit/[auditId]/rack/[rackId]', params: { auditId: audit.audit_id, rackId: bay.rack, layout: bay.layout, bay: bay.code } } as never);
    } else {
      router.push({
        pathname: '/audit/[auditId]/count-sheet',
        params: { auditId: audit.audit_id, layout: bay.layout, rack: bay.rack, bay: bay.code, loc: bay.openLoc ?? '' },
      } as never);
    }
  };

  const onPressStart = () => {
    if (showCompletedState) {
      router.push({ pathname: '/audit/[auditId]/summary', params: { auditId: audit.audit_id } } as never);
    } else {
      router.push({ pathname: '/audit/[auditId]/count-sheet', params: { auditId: audit.audit_id } } as never);
    }
  };

  const renderBayPill = (bay: FlatBay) => (
    <Pressable
      key={`${bay.layout}|${bay.rack}|${bay.code}`}
      disabled={isSubmitted}
      onPress={() => onPressBay(bay)}
      style={[
        styles.bayPill,
        {
          backgroundColor: bay.done ? tokens.rag.green.soft : tokens.muted,
          borderColor: bay.done ? tokens.rag.green.border : tokens.border,
        },
      ]}
    >
      <Text style={{ color: bay.done ? tokens.rag.green.strong : tokens.mutedForeground, fontWeight: tokens.fontWeight.bold, fontSize: 12.5 }}>
        {bay.code}
      </Text>
    </Pressable>
  );

  const bayBody =
    totalRackCount > 1 ? (
      <View>
        {layouts.map((ly) => {
          const layoutKey = `layout:${ly.name}`;
          const layoutOpen = isOpen(layoutKey);
          return (
            <View key={ly.name} style={[styles.accSection, { borderBottomColor: tokens.border }]}>
              <Pressable onPress={() => toggleSection(layoutKey)} style={styles.accHeader}>
                <Ionicons name="grid-outline" size={18} color="#667085" />
                <Text style={{ flex: 1, color: tokens.foreground, fontWeight: tokens.fontWeight.semibold, fontSize: tokens.text.sm }}>
                  {ly.name}
                </Text>
                <View style={[styles.accBadge, { backgroundColor: tokens.accentBlue.soft, borderRadius: tokens.radius.lg }]}>
                  <Text style={{ color: tokens.accentBlue.strong, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.xs }}>
                    Total Racks: {String(ly.racks.length).padStart(2, '0')}
                  </Text>
                </View>
                <Ionicons name={layoutOpen ? 'chevron-up' : 'chevron-down'} size={16} color="#667085" />
              </Pressable>
              {layoutOpen
                ? ly.racks.map((rack) => {
                    const rackKey = `rack:${ly.name}|${rack.code}`;
                    const rackOpen = isOpen(rackKey);
                    const bays = flatBays.filter((b) => b.layout === ly.name && b.rack === rack.code);
                    return (
                      <View key={rack.code} style={styles.accSubSection}>
                        <Pressable onPress={() => toggleSection(rackKey)} style={styles.accHeader}>
                          <Ionicons name="server-outline" size={18} color="#667085" />
                          <Text style={{ flex: 1, color: tokens.foreground, fontWeight: tokens.fontWeight.semibold, fontSize: tokens.text.sm }}>
                            Rack {rack.code}
                          </Text>
                          <View style={[styles.accBadge, { backgroundColor: tokens.accentBlue.soft, borderRadius: tokens.radius.lg }]}>
                            <Text style={{ color: tokens.accentBlue.strong, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.xs }}>
                              Total Bays: {String(bays.length).padStart(2, '0')}
                            </Text>
                          </View>
                          <Ionicons name={rackOpen ? 'chevron-up' : 'chevron-down'} size={16} color="#667085" />
                        </Pressable>
                        {rackOpen ? <View style={styles.bayGrid}>{bays.map(renderBayPill)}</View> : null}
                      </View>
                    );
                  })
                : null}
            </View>
          );
        })}
      </View>
    ) : (
      <View style={styles.bayGrid}>
        {flatBays.length ? (
          flatBays.map(renderBayPill)
        ) : (
          <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.sm, paddingVertical: 12 }}>No bays in scope yet.</Text>
        )}
      </View>
    );

  return (
    <View style={{ flex: 1, backgroundColor: tokens.muted }}>
      <AppHeader
        title="Audit Details"
        sub={`${audit.audit_id} · ${inspector?.warehouse ?? ''}`}
        showBack
        menuItems={[{ label: 'Sync Now', onPress: () => {} }]}
      />
      <ScrollView contentContainerStyle={styles.body}>
        <Card>
          <View style={styles.sectionLabelRow}>
            <Ionicons name="search-outline" size={16} color={tokens.foreground} />
            <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.base }}>
              Audit Schedule Details
            </Text>
          </View>
          <View style={styles.inspGrid}>
            <InspField label="Audit Type" value={audit.audit_type} />
            <InspField label="Audit Date" value={fmtDate(audit.start_date)} />
            <InspField label="Total Bay" value={String(r.bayTotal)} />
            <View style={styles.inspFieldWrap}>
              <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm, marginBottom: 4 }}>
                Priority
              </Text>
              <Pill label={priorityFor(audit)} tone={priorityFor(audit)} />
            </View>
          </View>
        </Card>

        <Card>
          <View style={styles.bayHeadRow}>
            <View style={styles.bayCountRow}>
              <Ionicons name="cube-outline" size={16} color={tokens.foreground} />
              <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm }}>Total Bay :</Text>
              <View style={[styles.badge, { backgroundColor: tokens.accentBlue.soft, borderRadius: tokens.radius.lg }]}>
                <Text style={{ color: tokens.accentBlue.strong, fontWeight: tokens.fontWeight.extrabold, fontSize: tokens.text.sm }}>
                  {flatBays.length}
                </Text>
              </View>
            </View>
            <View style={styles.legendRow}>
              <View style={styles.legendItem}>
                <View style={[styles.legendDot, { backgroundColor: tokens.rag.green.soft, borderColor: tokens.rag.green.base }]} />
                <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xs, fontWeight: tokens.fontWeight.semibold }}>
                  Completed : {String(bayDoneCount).padStart(2, '0')}
                </Text>
              </View>
              <View style={styles.legendItem}>
                <View style={[styles.legendDot, { backgroundColor: tokens.muted, borderColor: tokens.border }]} />
                <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xs, fontWeight: tokens.fontWeight.semibold }}>
                  Pending : {String(bayPendingCount).padStart(2, '0')}
                </Text>
              </View>
            </View>
          </View>
          {bayBody}
        </Card>

        <Pressable onPress={() => router.push('/progress')} style={styles.linkBtn}>
          <Text style={{ color: tokens.primary, fontWeight: tokens.fontWeight.semibold, fontSize: tokens.text.sm }}>
            View Full Rack/Bay Breakdown
          </Text>
        </Pressable>
      </ScrollView>
      <View style={[styles.footerBar, { backgroundColor: tokens.card, borderTopColor: tokens.border }]}>
        <Pressable onPress={onPressStart} style={[styles.startBtn, { backgroundColor: tokens.primary, borderRadius: tokens.radius.lg }]}>
          <Text style={{ color: tokens.primaryForeground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.base }}>{startLabel}</Text>
          <Ionicons name="arrow-forward-circle" size={18} color={tokens.primaryForeground} />
        </Pressable>
      </View>
    </View>
  );
}

function InspField({ label, value }: { label: string; value: string }) {
  const { tokens } = useTheme();
  return (
    <View style={styles.inspFieldWrap}>
      <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm, marginBottom: 4 }}>{label}</Text>
      <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.sm }}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  body: { padding: 16, gap: 14, paddingBottom: 40 },
  sectionLabelRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 4 },
  inspGrid: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 12 },
  inspFieldWrap: { width: '50%', marginBottom: 14 },
  bayHeadRow: { gap: 10, marginBottom: 6 },
  bayCountRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  badge: { paddingHorizontal: 12, paddingVertical: 4 },
  legendRow: { flexDirection: 'row', gap: 16, flexWrap: 'wrap' },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  legendDot: { width: 10, height: 10, borderRadius: 5, borderWidth: 1.5 },
  bayGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 16 },
  bayPill: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 999, borderWidth: 1 },
  accSection: { borderBottomWidth: StyleSheet.hairlineWidth, paddingVertical: 14 },
  accSubSection: { marginTop: 10, marginLeft: 4 },
  accHeader: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  accBadge: { paddingHorizontal: 10, paddingVertical: 4 },
  linkBtn: { paddingVertical: 6, alignItems: 'center' },
  footerBar: { padding: 16, borderTopWidth: StyleSheet.hairlineWidth },
  startBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, height: 48 },
});
