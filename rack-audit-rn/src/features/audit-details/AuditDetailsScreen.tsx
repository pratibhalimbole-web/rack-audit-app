import { Ionicons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { AppHeader } from '@/components/AppHeader';
import { Card } from '@/components/Card';
import { flattenBays, fmtDate, lastSaved, nextPending, rollup, uiStatus, type FlatBay } from '@/lib/auditLogic';
import { useDeviceClass } from '@/hooks/useDeviceClass';
import { useLocationsTree } from '@/hooks/useLocationsTree';
import { FLOOR_AREAS, ZONE_EXPECTED_SKUS } from '@/lib/mockData';
import { useAuthStore } from '@/store/useAuthStore';
import { useZoneAuditStore } from '@/store/useZoneAuditStore';
import { useTheme } from '@/theme/ThemeProvider';
import { useAudits } from '../dashboard/hooks';

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
  // True accordion at each level, not independent per-key toggles: only one
  // layout open at a time, and only one rack open at a time within it.
  // Opening a different layout always resets the rack accordion inside it.
  const [openLayout, setOpenLayout] = useState<string | null>(null);
  const [openRack, setOpenRack] = useState<string | null>(null);

  const audit = audits?.find((a) => a.audit_id === auditId);
  const zoneScansByAudit = useZoneAuditStore((s) => s.scansByAudit);
  const r = useMemo(() => rollup(tree), [tree]);
  const layouts = tree?.layouts ?? [];
  const flatBays = useMemo(() => flattenBays(tree), [tree]);
  const bayDoneCount = flatBays.filter((b) => b.done).length;
  const bayPendingCount = flatBays.length - bayDoneCount;

  // Auto-opens the first layout when landing on a (new) audit, rather than
  // starting fully collapsed or with every layout open at once.
  useEffect(() => {
    setOpenLayout(layouts.length ? `layout:${layouts[0].name}` : null);
    setOpenRack(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-seed on a different audit, not every layouts re-render
  }, [auditId]);

  const toggleLayout = (key: string) => {
    setOpenLayout((prev) => (prev === key ? null : key));
    setOpenRack(null);
  };
  const toggleRack = (key: string) => {
    setOpenRack((prev) => (prev === key ? null : key));
  };

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
  // Driven by real scan progress (has any location actually been counted
  // yet), not the audit's own status field — a "Scheduled" audit the
  // inspector already started scanning, or an "In Progress" one nothing's
  // actually been recorded for yet, both read correctly this way.
  const startLabel = showCompletedState ? 'View Audit Summary' : r.locDone > 0 ? 'Resume Audit' : 'Start Audit';
  // Coarser than every other scope_type — this audit is only ever worked
  // at the whole-zone grain, never drilled down to a specific bay, so the
  // usual bay-chip grid and Rack View entry point don't apply here at all.
  const isZoneScope = audit.scope_type === 'Zone';
  // A SKU Wise audit's real coverage is per-SKU, not per-rack — the same
  // SKU can legitimately be expected in several racks/zones at once, so the
  // Location Wise rack->bay accordion (grouped by physical place) doesn't
  // represent it. Zone-scoped audits (no location tree at all) still take
  // priority over this — zoneBody's whole-zone pick-list flow applies there
  // regardless of event_scope_type.
  const isSkuScope = !isZoneScope && audit.event_scope_type === 'SKU Wise';

  // Same destination on phone and tablet — the Rack View canvas, with its
  // expected-SKU highlighting, exactly as reached via Tasks > Warehouse Map
  // > Start Task. Count Sheet's plain list view is no longer where a bay
  // chip lands on phone.
  // fromChip defaults to true since every direct caller of onPressBay is an
  // actual bay-chip tap; onPressStart below is the one caller that isn't —
  // it opens the audit generally (via whichever bay happens to be first),
  // not a specific bay the inspector chose, so it opts out of the lock.
  const onPressBay = (bay: FlatBay, fromChip = true) => {
    if (isSubmitted) return;
    // source: 'bay-chip' keeps Rack View's bay lock absolute for this entry
    // point specifically — only this bay's SKUs are selectable on the
    // canvas, and other bays' expected SKUs require the Bay dropdown.
    router.push({
      pathname: '/audit/[auditId]/rack/[rackId]',
      params: { auditId: audit.audit_id, rackId: bay.rack, layout: bay.layout, bay: bay.code, ...(fromChip ? { source: 'bay-chip' } : {}) },
    } as never);
  };

  const onPressStart = () => {
    if (showCompletedState) {
      router.push({ pathname: '/audit/[auditId]/summary', params: { auditId: audit.audit_id } } as never);
      return;
    }
    if (isZoneScope) {
      router.push({ pathname: '/audit/[auditId]/zone-map', params: { auditId: audit.audit_id } } as never);
      return;
    }
    if (isTablet) {
      // Resuming (something's already been scanned) preselects a real
      // pallet in the dropdown, not just a bay filter — the same pallet
      // already scanned/saved most recently if there is one, or the
      // nearest still-pending one otherwise. A genuinely fresh start opens
      // the rack's canvas with nothing pre-picked at all — no bay filter,
      // no pallet — so the inspector chooses where to begin themselves,
      // from the dropdown or by tapping the canvas directly.
      if (r.locDone > 0) {
        const resumeEntry = lastSaved(tree) ?? nextPending(tree);
        if (resumeEntry) {
          router.push({
            pathname: '/audit/[auditId]/rack/[rackId]',
            params: { auditId: audit.audit_id, rackId: resumeEntry.rack, layout: resumeEntry.layout, bay: resumeEntry.bay, loc: resumeEntry.loc.code },
          } as never);
          return;
        }
        const targetBay = flatBays.find((b) => !b.done) ?? flatBays[0];
        if (targetBay) {
          onPressBay(targetBay, false);
          return;
        }
      } else if (flatBays[0]) {
        router.push({
          pathname: '/audit/[auditId]/rack/[rackId]',
          params: { auditId: audit.audit_id, rackId: flatBays[0].rack, layout: flatBays[0].layout, fresh: '1' },
        } as never);
        return;
      }
    }
    router.push({ pathname: '/audit/[auditId]/count-sheet', params: { auditId: audit.audit_id } } as never);
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

  // Every event type now reads the same physical-first coverage view — a
  // flattened Racks accordion (no per-Layout grouping) when scope_type
  // isn't Zone, or a flat Zone chip row when it is. SKU Wise's SKU Types/
  // Batch are summarized up in the schedule card instead of driving a
  // separate per-SKU breakdown down here.
  const skuTypesSet = new Set(audit.sku_types ?? []);
  // A zone counts as done once every SKU it's expected to hold (narrowed to
  // this audit's own sku_types when SKU Wise) has been fully scanned —
  // shared by both the generic zone chip grid and the SKU Wise variant.
  const zoneDone = (zoneName: string) => {
    const zoneId = FLOOR_AREAS.find((f) => f.label === zoneName)?.id;
    const pickList = (ZONE_EXPECTED_SKUS[zoneName] ?? []).filter((p) => !isSkuScope || !skuTypesSet.size || skuTypesSet.has(p.sku));
    if (!pickList.length) return false;
    const scans = (zoneId && zoneScansByAudit[audit.audit_id]?.[zoneId]) || [];
    return pickList.every((p) => new Set(scans.filter((s) => s.sku === p.sku).map((s) => s.label)).size >= p.expectedCount);
  };
  const zoneScopeDoneCount = isZoneScope ? audit.scope_values.filter(zoneDone).length : 0;
  const zoneScopePendingCount = isZoneScope ? audit.scope_values.length - zoneScopeDoneCount : 0;

  const skuZoneBody = audit.scope_values.length ? (
    <View style={styles.bayGrid}>
      {audit.scope_values.map((zoneName) => {
        const done = zoneDone(zoneName);
        return (
          <View
            key={zoneName}
            style={[styles.zonePill, { backgroundColor: done ? tokens.rag.green.soft : tokens.muted, borderColor: done ? tokens.rag.green.border : tokens.border }]}
          >
            <Text style={{ color: done ? tokens.rag.green.strong : tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm }}>
              {zoneName}
            </Text>
          </View>
        );
      })}
    </View>
  ) : (
    <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.sm, paddingVertical: 12 }}>No zones in scope yet.</Text>
  );

  // Flattened across layouts — reads as one Racks accordion (Total
  // Racks: N) instead of grouped under each Layout's own name. Location
  // Wise scoped to a single Layout is the one exception: it keeps that
  // Layout's own generic "Layout 1" wrapper instead of "Racks", matching
  // the reference — every other combination (Rack scope, or any non
  // Location Wise event type) reads "Racks".
  const allRacksFlat = layouts.flatMap((ly) => ly.racks.map((rack) => ({ layout: ly.name, rack })));
  const racksWrapperLabel =
    (!audit.event_scope_type || audit.event_scope_type === 'Location Wise') && audit.scope_type === 'Layout' ? 'Layout 1' : 'Racks';
  const racksRootOpen = openLayout === 'sku-racks-root';
  const skuRackBody = (
    <View>
      <Pressable onPress={() => toggleLayout('sku-racks-root')} style={styles.accHeader}>
        <View style={[styles.accIconWrap, { backgroundColor: tokens.accentBlue.soft }]}>
          <Ionicons name="business-outline" size={18} color={tokens.accentBlue.base} />
        </View>
        <Text style={{ flex: 1, color: tokens.foreground, fontWeight: tokens.fontWeight.semibold, fontSize: tokens.text.sm }}>{racksWrapperLabel}</Text>
        <View style={[styles.accBadge, { backgroundColor: tokens.accentBlue.soft, borderRadius: tokens.radius.lg }]}>
          <Text style={{ color: tokens.accentBlue.strong, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.xs }}>
            Total Racks: {String(allRacksFlat.length).padStart(2, '0')}
          </Text>
        </View>
        <Ionicons name={racksRootOpen ? 'chevron-up' : 'chevron-down'} size={16} color="#667085" />
      </Pressable>
      {racksRootOpen
        ? allRacksFlat.map(({ layout, rack }) => {
            const rackKey = `sku-rack:${layout}|${rack.code}`;
            const rackOpen = openRack === rackKey;
            const bays = flatBays.filter((b) => b.layout === layout && b.rack === rack.code);
            const doneInRack = bays.filter((b) => b.done).length;
            return (
              <View key={rackKey} style={styles.accSubSection}>
                <Pressable onPress={() => toggleRack(rackKey)} style={styles.accHeader}>
                  <View style={[styles.accIconWrap, { backgroundColor: tokens.accentBlue.soft }]}>
                    <Ionicons name="server-outline" size={18} color={tokens.accentBlue.base} />
                  </View>
                  <Text style={{ flex: 1, color: tokens.foreground, fontWeight: tokens.fontWeight.semibold, fontSize: tokens.text.sm }}>Rack {rack.code}</Text>
                  <View style={[styles.accBadge, { backgroundColor: tokens.accentBlue.soft, borderRadius: tokens.radius.lg }]}>
                    <Text style={{ color: tokens.accentBlue.strong, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.xs }}>
                      Total Bays: {String(doneInRack).padStart(2, '0')}/{String(bays.length).padStart(2, '0')}
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
            <View style={[styles.accIconWrap, { backgroundColor: tokens.accentBlue.soft }]}>
              <Ionicons name="search-outline" size={16} color={tokens.accentBlue.base} />
            </View>
            <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.base }}>
              Audit Schedule Details
            </Text>
          </View>
          <View style={styles.inspGrid}>
            <InspField label="Event Name & ID" value={`${audit.audit_name} - ${audit.audit_id}`} />
            <InspField label="Event Type" value={audit.event_scope_type ?? 'Location Wise'} />
            <InspField label="Start Date" value={fmtDate(audit.start_date)} />
            <InspField label="End Date" value={fmtDate(audit.end_date)} />
            {(audit.event_scope_type ?? 'Location Wise') === 'Location Wise' ? (
              isZoneScope ? (
                <>
                  <InspField label="Scope Type" value={audit.scope_type} />
                  <InspField label="No.of zones" value={String(audit.scope_values.length).padStart(2, '0')} />
                </>
              ) : (
                <>
                  <InspField label="Scope Type" value={audit.scope_type} />
                  <InspField label="Scope Values" value={audit.scope_values.length ? audit.scope_values.join(', ') : 'Not narrowed'} />
                  {audit.scope_type === 'Rack' ? <InspField label="Total Racks" value={String(allRacksFlat.length).padStart(2, '0')} /> : null}
                  <InspField label="Total Bay" value={String(flatBays.length).padStart(2, '0')} />
                </>
              )
            ) : audit.event_scope_type === 'SKU Wise' ? (
              <>
                <InspField label="No.of SKU Types" value={truncateList(audit.sku_types)} />
                <InspField label="No.of batch" value={truncateList(audit.batch_lot?.split(',').map((s) => s.trim()))} />
                <InspField
                  label={isZoneScope ? 'Total zone' : 'Total Bay'}
                  value={String(isZoneScope ? audit.scope_values.length : flatBays.length).padStart(2, '0')}
                />
              </>
            ) : audit.event_scope_type === 'Full Warehouse' ? (
              isZoneScope ? (
                <InspField label="Total Zone" value={String(audit.scope_values.length).padStart(2, '0')} />
              ) : (
                <>
                  <InspField label="Total Racks" value={String(allRacksFlat.length).padStart(2, '0')} />
                  <InspField label="Total Bay" value={String(flatBays.length).padStart(2, '0')} />
                </>
              )
            ) : null}
            <InspField label="Work Scope" value={audit.work_scope?.length ? audit.work_scope.join(', ') : 'Not selected'} />
          </View>
        </Card>

        <Card>
          <View style={styles.bayHeadRow}>
            <View style={styles.bayCountRow}>
              <View style={[styles.accIconWrap, { backgroundColor: tokens.accentBlue.soft }]}>
                <Ionicons name="cube-outline" size={16} color={tokens.accentBlue.base} />
              </View>
              <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm }}>
                {isZoneScope ? 'Total Zone :' : 'Total Bay :'}
              </Text>
              <View style={[styles.badge, { backgroundColor: tokens.accentBlue.soft, borderRadius: tokens.radius.lg }]}>
                <Text style={{ color: tokens.accentBlue.strong, fontWeight: tokens.fontWeight.extrabold, fontSize: tokens.text.sm }}>
                  {isZoneScope ? audit.scope_values.length : flatBays.length}
                </Text>
              </View>
            </View>
            <View style={styles.legendRow}>
              <View style={styles.legendItem}>
                <View style={[styles.legendDot, { backgroundColor: tokens.rag.green.soft, borderColor: tokens.rag.green.base }]} />
                <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xs, fontWeight: tokens.fontWeight.semibold }}>
                  Completed : {String(isZoneScope ? zoneScopeDoneCount : bayDoneCount).padStart(2, '0')}
                </Text>
              </View>
              <View style={styles.legendItem}>
                <View style={[styles.legendDot, { backgroundColor: tokens.muted, borderColor: tokens.border }]} />
                <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xs, fontWeight: tokens.fontWeight.semibold }}>
                  Pending : {String(isZoneScope ? zoneScopePendingCount : bayPendingCount).padStart(2, '0')}
                </Text>
              </View>
            </View>
          </View>
          {isZoneScope ? skuZoneBody : skuRackBody}
        </Card>
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

// "SKU-3301, 2+more" — first value plus a count of the rest, rather than
// the full comma-joined list, which would blow out this field's width for
// an audit scoped to a dozen+ SKU types/batches.
function truncateList(values: string[] | undefined): string {
  if (!values?.length) return '—';
  if (values.length === 1) return values[0];
  return `${values[0]}, ${values.length - 1}+more`;
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
  inspFieldWrap: { width: '33.33%', marginBottom: 14 },
  bayHeadRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 16, marginBottom: 6 },
  bayCountRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  badge: { paddingHorizontal: 12, paddingVertical: 4 },
  legendRow: { flexDirection: 'row', gap: 16, flexWrap: 'wrap' },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  legendDot: { width: 10, height: 10, borderRadius: 5, borderWidth: 1.5 },
  bayGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 16 },
  bayPill: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 999, borderWidth: 1 },
  zonePill: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 12, borderWidth: 1, alignSelf: 'flex-start' },
  accSubSection: { marginTop: 10, marginLeft: 4 },
  accHeader: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  accBadge: { paddingHorizontal: 10, paddingVertical: 4 },
  accIconWrap: { width: 28, height: 28, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  footerBar: { padding: 16, borderTopWidth: StyleSheet.hairlineWidth },
  startBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, height: 48 },
});
