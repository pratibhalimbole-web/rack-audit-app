import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import { AppHeader } from '@/components/AppHeader';
import { Card } from '@/components/Card';
import { Pill } from '@/components/Pill';
import { DUE_BUCKETS, dueBucket, isOverdue, uiStatus, type DueBucketKey } from '@/lib/auditLogic';
import { useAuditProgressMap } from '@/hooks/useLocationsTree';
import { EXPECTED_SKUS } from '@/lib/mockData';
import type { Audit, AuditType } from '@/lib/types';
import { useTheme } from '@/theme/ThemeProvider';
import { useAudits, useMyAudits } from '../dashboard/hooks';

// Not a tracker of where the inspector physically is — there's no device
// location signal here — this is a visual "where do my tasks actually sit"
// map of the warehouse, so an inspector can judge for themselves (by their
// own sense of distance, how long the walk/lift ride is, which bay levels
// need a ladder or a vehicle) which task to tackle next.
//
// Drawn as a top-down plan instead of an isometric scene: a Layout holds
// several Racks, and each Rack is itself made up of several Bays (levels
// stack vertically within a bay and aren't visible from directly above,
// same as a real architectural floor plan) — a single generic cuboid per
// rack was hiding that structure entirely. Racks sit in a row per layout
// "zone" (aisle); each rack is drawn as its own small stack of bay
// segments, so a task's exact bay(s) can be picked out from the rest of
// that rack, not just "somewhere in this rack."
type BayCell = { layout: string; rack: string; bay: string };
type RackGroup = { rack: string; bays: BayCell[] };
type ZoneGroup = { layout: string; racks: RackGroup[] };
type RackCell = { layout: string; rack: string };
type FilterKey = 'All' | DueBucketKey;
type TypeFilterKey = 'All' | AuditType;

const BUCKET_COLOR_KEY: Record<DueBucketKey, 'red' | 'green' | 'accentBlue' | 'amber'> = {
  Delayed: 'red',
  Today: 'green',
  'This Week': 'accentBlue',
  'This Month': 'amber',
};
const TASK_TYPES: AuditType[] = ['Full', 'Cycle Count', 'Spot Check'];
const TASK_TYPE_ICON: Record<AuditType, keyof typeof Ionicons.glyphMap> = {
  Full: 'layers-outline',
  'Cycle Count': 'refresh-outline',
  'Spot Check': 'locate-outline',
};

const BAY_SEG_W = 9;
const BAY_SEG_H = 14;
const BAY_GAP = 1.5;
const ASSIGNED_WIRE = '#5B6B82';
const UNASSIGNED_WIRE = '#DCE1E7';

export function WarehouseMapScreen() {
  const { tokens } = useTheme();
  const { data: myAudits = [] } = useMyAudits();
  // The floor itself is drawn from every audit in the warehouse (not just
  // mine) so unassigned racks actually show up on the map — otherwise
  // there'd be nothing to dim, since a rack only exists in this data model
  // as part of some audit's scope.
  const { data: allAudits = [] } = useAudits();
  const [filter, setFilter] = useState<FilterKey>('All');
  const [typeFilter, setTypeFilter] = useState<TypeFilterKey>('All');
  const [filterOpen, setFilterOpen] = useState(false);
  const [selectedCell, setSelectedCell] = useState<RackCell | null>(null);

  const myTasks = useMemo(() => myAudits.filter((a) => !['Submitted', 'Reconciled', 'Closed'].includes(a.status)), [myAudits]);
  const { map } = useAuditProgressMap(allAudits.map((a) => a.audit_id));

  // Pinch-to-zoom/pan on the floor, same pattern as Rack View's canvas.
  const scale = useSharedValue(0.7);
  const savedScale = useSharedValue(0.7);
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const savedTranslateX = useSharedValue(0);
  const savedTranslateY = useSharedValue(0);
  const panGesture = Gesture.Pan()
    .onUpdate((e) => {
      translateX.value = savedTranslateX.value + e.translationX;
      translateY.value = savedTranslateY.value + e.translationY;
    })
    .onEnd(() => {
      savedTranslateX.value = translateX.value;
      savedTranslateY.value = translateY.value;
    });
  const pinchGesture = Gesture.Pinch()
    .onUpdate((e) => {
      scale.value = Math.min(3, Math.max(0.3, savedScale.value * e.scale));
    })
    .onEnd(() => {
      savedScale.value = scale.value;
    });
  const floorGesture = Gesture.Simultaneous(panGesture, pinchGesture);
  const floorAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }, { translateY: translateY.value }, { scale: scale.value }],
  }));

  // The grid itself (every rack + bay in the warehouse, from every audit)
  // stays fixed regardless of the active filter — only the highlight
  // changes — so the map doesn't jump around when a filter option changes.
  const zones = useMemo<ZoneGroup[]>(() => {
    const byLayout = new Map<string, Map<string, Map<string, BayCell>>>();
    allAudits.forEach((a) => {
      (map[a.audit_id]?.allLocations ?? []).forEach(({ layout, rack, bay }) => {
        if (!byLayout.has(layout)) byLayout.set(layout, new Map());
        const racks = byLayout.get(layout)!;
        if (!racks.has(rack)) racks.set(rack, new Map());
        const bays = racks.get(rack)!;
        if (!bays.has(bay)) bays.set(bay, { layout, rack, bay });
      });
    });

    // The real audit data only covers a handful of racks/bays — nowhere
    // near an actual warehouse's scale. Pad every aisle with extra
    // unassigned filler racks (and a couple of aisles that are entirely
    // filler), and pad every rack with extra filler bays, so the floor
    // reads as a genuinely large warehouse with the racks that are mine
    // standing out against it.
    const RACKS_PER_ZONE = 12;
    const BAYS_PER_RACK = 4;
    const zoneNames = [...Array.from(byLayout.keys()), 'Layout D', 'Layout F'];
    zoneNames.forEach((layout) => {
      if (!byLayout.has(layout)) byLayout.set(layout, new Map());
      const racks = byLayout.get(layout)!;
      const prefix = layout.replace(/^Layout /, '');
      for (let n = 1; racks.size < RACKS_PER_ZONE && n <= 60; n++) {
        const code = `${prefix}-${String(n).padStart(2, '0')}`;
        if (!racks.has(code)) racks.set(code, new Map());
      }
      racks.forEach((bays, rackCode) => {
        for (let b = 1; bays.size < BAYS_PER_RACK && b <= 20; b++) {
          const bayCode = `B-${String(b).padStart(2, '0')}`;
          if (!bays.has(bayCode)) bays.set(bayCode, { layout, rack: rackCode, bay: bayCode });
        }
      });
    });

    return Array.from(byLayout.entries())
      .map(([layout, racks]) => ({
        layout,
        racks: Array.from(racks.entries())
          .map(([rack, bays]) => ({ rack, bays: Array.from(bays.values()).sort((a, b) => a.bay.localeCompare(b.bay)) }))
          .sort((a, b) => a.rack.localeCompare(b.rack)),
      }))
      .sort((a, b) => a.layout.localeCompare(b.layout));
  }, [allAudits, map]);

  // A location only actually counts toward an audit's footprint on the map
  // if it's genuinely in that audit's scope — for a spot-check audit with a
  // target_sku, that means the location's expected SKU has to match it.
  // Without this, a bay that's physically part of the same rack but never
  // in scope (e.g. Rack A-21's 4th bay, added purely so Rack View can show
  // the whole physical rack) would still read as "assigned" here just for
  // sharing the same audit's location tree.
  const inAuditScope = (a: Audit, l: { loc: { code: string } }) => !a.target_sku || (EXPECTED_SKUS[l.loc.code] ?? []).some((line) => line.sku === a.target_sku);

  const tasksTouching = (cell: RackCell, pool: Audit[]) =>
    pool.filter((a) => (map[a.audit_id]?.allLocations ?? []).some((l) => l.layout === cell.layout && l.rack === cell.rack && inAuditScope(a, l)));

  const bayTasksTouching = (cell: BayCell, pool: Audit[]) =>
    pool.filter((a) => (map[a.audit_id]?.allLocations ?? []).some((l) => l.layout === cell.layout && l.rack === cell.rack && l.bay === cell.bay && inAuditScope(a, l)));

  const bayLocs = (cell: BayCell, pool: Audit[]) =>
    pool.flatMap((a) => (map[a.audit_id]?.allLocations ?? []).filter((l) => l.layout === cell.layout && l.rack === cell.rack && l.bay === cell.bay && inAuditScope(a, l)).map((l) => l.loc));

  const rackLocs = (cell: RackCell, pool: Audit[]) =>
    pool.flatMap((a) => (map[a.audit_id]?.allLocations ?? []).filter((l) => l.layout === cell.layout && l.rack === cell.rack && inAuditScope(a, l)).map((l) => l.loc));

  // Assigned = touched by one of my active tasks, regardless of the current
  // due-bucket filter — this is what tells a rack apart from the rest of
  // the (dimmed) warehouse, separate from which color it's highlighted in.
  const isAssigned = (cell: RackCell) => tasksTouching(cell, myTasks).length > 0;

  // With no due-date filter picked, delayed tasks are hidden from the map
  // by default — a rack only shows red once "Delayed" is explicitly
  // selected in the filter, rather than every overdue task standing out
  // unasked-for the moment the screen opens.
  const filteredTasks = myTasks.filter(
    (a) => (filter === 'All' ? !isOverdue(a) : dueBucket(a) === filter) && (typeFilter === 'All' || a.audit_type === typeFilter),
  );

  // Just three states instead of a color per due-bucket: red if any touching
  // task is overdue (delayed wins regardless of anything else), green if
  // every location this cell covers is actually marked Completed, blue for
  // everything else that's simply assigned/in progress. `locs` are the
  // specific location leaves this cell (a bay, or a whole rack) covers —
  // completion is judged from their real status, not just "has a task."
  const statusColorFor = (touching: Audit[], locs: { status: string }[]): string | null => {
    if (!touching.length) return null;
    if (touching.some(isOverdue)) return tokens.rag.red.base;
    if (locs.length && locs.every((l) => l.status === 'Completed')) return tokens.rag.green.base;
    return tokens.accentBlue.border;
  };

  // Horizontal-aisle zones and vertical-aisle zones are rendered as two
  // separate grouped columns (not one interleaved wrapped row) so each
  // orientation reads as its own clean block instead of a jumbled mix.
  const horizontalZones = zones.filter((_, i) => i % 2 === 0);
  const verticalZones = zones.filter((_, i) => i % 2 === 1);

  const renderZone = (zone: ZoneGroup, vertical: boolean) => (
    <View key={zone.layout} style={styles.zone}>
      <View style={styles.zoneHeadRow}>
        <Ionicons name={vertical ? 'swap-vertical-outline' : 'swap-horizontal-outline'} size={12} color={tokens.mutedForeground} />
        <Text
          style={{
            color: tokens.mutedForeground,
            fontWeight: tokens.fontWeight.bold,
            fontSize: tokens.text.xxs,
            textTransform: 'uppercase',
            letterSpacing: 0.4,
          }}
        >
          {zone.layout}
        </Text>
      </View>
      <View style={[styles.zoneAisle, vertical ? styles.zoneAisleVertical : null]}>
        {zone.racks.map((rackGroup) => {
          const cell: RackCell = { layout: zone.layout, rack: rackGroup.rack };
          const assigned = isAssigned(cell);
          const rackColor = statusColorFor(tasksTouching(cell, filteredTasks), rackLocs(cell, filteredTasks));
          const isSelected = selectedCell?.layout === cell.layout && selectedCell?.rack === cell.rack;
          // Tapping a rack always highlights it in the app's default (solid)
          // blue, regardless of its status color — a clear "this is the one
          // you just picked" cue distinct from the lighter blue "Assigned"
          // fill/border used passively everywhere else.
          const rackBorder = isSelected ? tokens.accentBlue.base : (rackColor ?? (assigned ? ASSIGNED_WIRE : UNASSIGNED_WIRE));
          const bayCount = rackGroup.bays.length;
          return (
            <Pressable
              key={rackGroup.rack}
              onPress={() => setSelectedCell(cell)}
              hitSlop={4}
              style={[
                styles.rackCard,
                { borderColor: rackBorder, backgroundColor: assigned ? '#F3F5F8' : tokens.card, borderWidth: isSelected ? 2.5 : 1.5 },
              ]}
            >
              <Text
                numberOfLines={1}
                style={{
                  color: assigned ? tokens.foreground : tokens.slate400,
                  fontWeight: assigned ? tokens.fontWeight.bold : tokens.fontWeight.medium,
                  fontSize: 9,
                }}
              >
                Rack {rackGroup.rack}
              </Text>
              <View style={styles.bayRow}>
                {rackGroup.bays.map((bayCell) => {
                  const bayColor = statusColorFor(bayTasksTouching(bayCell, filteredTasks), bayLocs(bayCell, filteredTasks));
                  return (
                    <View
                      key={bayCell.bay}
                      style={[styles.baySeg, { backgroundColor: bayColor ?? 'transparent', borderColor: bayColor ?? (assigned ? rackBorder : UNASSIGNED_WIRE) }]}
                    />
                  );
                })}
              </View>
              <Text style={{ color: tokens.slate400, fontSize: 7, marginTop: 1 }}>
                {bayCount} {bayCount === 1 ? 'bay' : 'bays'}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );

  const selectedTasks = selectedCell ? tasksTouching(selectedCell, myTasks) : [];
  const totalRackCount = zones.reduce((n, z) => n + z.racks.length, 0);
  const assignedRackCount = zones.reduce((n, z) => n + z.racks.filter((r) => isAssigned({ layout: z.layout, rack: r.rack })).length, 0);

  return (
    <View style={{ flex: 1, backgroundColor: tokens.muted }}>
      <AppHeader title="Tasks on Map" sub={`${assignedRackCount} of ${totalRackCount} racks assigned to you`} showBack />

      {zones.length ? (
        <View style={styles.body}>
          <Card style={{ padding: 0, overflow: 'hidden', flex: 1, borderColor: tokens.border }}>
            {/* Sticky toolbar, Figma-style — the filter lives here, fixed at
                the top of the canvas card. Everything below (GestureDetector
                + Animated.View) is the actual movable/zoomable layer; this
                row never pans or zooms with it. */}
            <View style={[styles.canvasToolbarRow, { backgroundColor: '#F7F8FA', borderBottomColor: tokens.border }]}>
              {(
                [
                  { label: 'Completed', color: tokens.rag.green.base },
                  { label: 'Assigned', color: tokens.accentBlue.border },
                ] as const
              ).map((item) => (
                <View key={item.label} style={styles.legendItem}>
                  <View style={[styles.legendDot, { backgroundColor: item.color }]} />
                  <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xxs }}>{item.label}</Text>
                </View>
              ))}
              <View style={{ flex: 1 }} />
              {filter !== 'All' ? (
                <View style={[styles.activeChip, { backgroundColor: tokens.accentBlue.soft, borderRadius: tokens.radius.sm }]}>
                  <Text style={{ color: tokens.accentBlue.strong, fontSize: tokens.text.xxs, fontWeight: tokens.fontWeight.semibold }}>{filter}</Text>
                  <Pressable onPress={() => setFilter('All')} hitSlop={6}>
                    <Ionicons name="close" size={12} color={tokens.accentBlue.strong} />
                  </Pressable>
                </View>
              ) : null}
              {typeFilter !== 'All' ? (
                <View style={[styles.activeChip, { backgroundColor: tokens.accentBlue.soft, borderRadius: tokens.radius.sm }]}>
                  <Text style={{ color: tokens.accentBlue.strong, fontSize: tokens.text.xxs, fontWeight: tokens.fontWeight.semibold }}>{typeFilter}</Text>
                  <Pressable onPress={() => setTypeFilter('All')} hitSlop={6}>
                    <Ionicons name="close" size={12} color={tokens.accentBlue.strong} />
                  </Pressable>
                </View>
              ) : null}
              <Pressable
                onPress={() => setFilterOpen((o) => !o)}
                style={[styles.filterIconBtn, { backgroundColor: tokens.card, borderColor: filterOpen ? tokens.primary : tokens.border, borderRadius: tokens.radius.lg }]}
              >
                <Ionicons name="filter-outline" size={16} color={tokens.foreground} />
              </Pressable>
            </View>
            <View style={styles.stage}>
              <GestureDetector gesture={floorGesture}>
                <View style={styles.stageCenter}>
                  <Animated.View style={floorAnimatedStyle}>
                    <View style={styles.planCanvas}>
                      <View style={styles.zoneGroupCol}>{horizontalZones.map((zone) => renderZone(zone, false))}</View>
                      <View style={styles.zoneGroupRow}>{verticalZones.map((zone) => renderZone(zone, true))}</View>
                    </View>
                  </Animated.View>
                </View>
              </GestureDetector>
            </View>
          </Card>
        </View>
      ) : (
        <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.sm, textAlign: 'center', paddingVertical: 40 }}>
          No task locations to map yet.
        </Text>
      )}

      {/* Its own top-level Modal (not just an absolutely-positioned View
          inside the Card) because the Card clips overflow to keep the
          pinch/pan canvas contained — a dropdown positioned inside it would
          get cut off at the Card's edge. */}
      <Modal visible={filterOpen} transparent animationType="fade" onRequestClose={() => setFilterOpen(false)}>
        <Pressable style={styles.filterBackdrop} onPress={() => setFilterOpen(false)}>
          <Pressable style={[styles.filterDropdown, { backgroundColor: tokens.card, borderColor: tokens.border, borderRadius: tokens.radius.lg }]} onPress={(e) => e.stopPropagation()}>
            <Text style={[styles.filterSectionLabel, { color: tokens.mutedForeground }]}>Due Date</Text>
            {(['All', ...DUE_BUCKETS.map((b) => b.key)] as FilterKey[]).map((key) => {
              const active = filter === key;
              const bucketColor = key !== 'All' ? BUCKET_COLOR_KEY[key as DueBucketKey] : null;
              const tone = bucketColor ? (bucketColor === 'accentBlue' ? tokens.accentBlue : tokens.rag[bucketColor]) : null;
              return (
                <Pressable key={key} onPress={() => setFilter(key)} style={[styles.filterOption, active ? { backgroundColor: tokens.muted } : null]}>
                  {tone ? <View style={[styles.filterDot, { backgroundColor: tone.base }]} /> : <View style={styles.filterDot} />}
                  <Text style={{ color: tokens.foreground, fontWeight: active ? tokens.fontWeight.bold : tokens.fontWeight.medium, fontSize: tokens.text.sm, flex: 1 }}>
                    {key}
                  </Text>
                  {active ? <Ionicons name="checkmark" size={16} color={tokens.primary} /> : null}
                </Pressable>
              );
            })}

            <Text style={[styles.filterSectionLabel, { color: tokens.mutedForeground, marginTop: 8 }]}>Task Type</Text>
            {(['All', ...TASK_TYPES] as TypeFilterKey[]).map((key) => {
              const active = typeFilter === key;
              return (
                <Pressable key={key} onPress={() => setTypeFilter(key)} style={[styles.filterOption, active ? { backgroundColor: tokens.muted } : null]}>
                  <Ionicons
                    name={key === 'All' ? 'apps-outline' : TASK_TYPE_ICON[key as AuditType]}
                    size={15}
                    color={active ? tokens.primary : tokens.mutedForeground}
                  />
                  <Text style={{ color: tokens.foreground, fontWeight: active ? tokens.fontWeight.bold : tokens.fontWeight.medium, fontSize: tokens.text.sm, flex: 1 }}>
                    {key}
                  </Text>
                  {active ? <Ionicons name="checkmark" size={16} color={tokens.primary} /> : null}
                </Pressable>
              );
            })}
          </Pressable>
        </Pressable>
      </Modal>

      <Modal visible={!!selectedCell} transparent animationType="fade" onRequestClose={() => setSelectedCell(null)}>
        <Pressable style={styles.backdrop} onPress={() => setSelectedCell(null)}>
          <Pressable style={[styles.sheet, { backgroundColor: tokens.card, borderRadius: tokens.radius.xxl }]} onPress={(e) => e.stopPropagation()}>
            {selectedCell ? (
              <>
                <View style={styles.sheetHeadRow}>
                  <View>
                    <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.extrabold, fontSize: tokens.text.base }}>
                      Rack {selectedCell.rack}
                    </Text>
                    <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xs, marginTop: 2 }}>{selectedCell.layout}</Text>
                  </View>
                  <Pressable onPress={() => setSelectedCell(null)} hitSlop={8}>
                    <Ionicons name="close" size={22} color={tokens.mutedForeground} />
                  </Pressable>
                </View>
                <View style={[styles.sheetDivider, { backgroundColor: tokens.border }]} />

                {selectedTasks.length ? (
                  <Text style={styles.sheetSectionLabel}>
                    Part of {selectedTasks.length} task{selectedTasks.length === 1 ? '' : 's'}
                  </Text>
                ) : null}

                <ScrollView style={{ maxHeight: 420 }} contentContainerStyle={{ gap: 10 }}>
                  {selectedTasks.length ? (
                    selectedTasks.map((a) => {
                      const bucket = dueBucket(a);
                      const bucketColorKey = BUCKET_COLOR_KEY[bucket];
                      const bucketTone = bucketColorKey === 'accentBlue' ? tokens.accentBlue : tokens.rag[bucketColorKey];
                      const otherRacks = Array.from(
                        new Map(
                          (map[a.audit_id]?.allLocations ?? [])
                            .filter((l) => !(l.layout === selectedCell.layout && l.rack === selectedCell.rack))
                            .map((l) => [`${l.layout}|${l.rack}`, l]),
                        ).values(),
                      );
                      return (
                        <View key={a.audit_id} style={{ gap: 8 }}>
                        <View
                          style={[
                            styles.taskCard,
                            { backgroundColor: tokens.muted, borderColor: tokens.border, borderRadius: tokens.radius.lg, borderLeftWidth: 4, borderLeftColor: bucketTone.base },
                          ]}
                        >
                          <View style={{ flex: 1 }}>
                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                              <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm, flex: 1 }} numberOfLines={1}>
                                {a.audit_name}
                              </Text>
                              <Pill label={uiStatus(a)} tone={uiStatus(a)} />
                            </View>
                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 }}>
                              <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xxs }}>{a.audit_id}</Text>
                              <View style={styles.metaDivider} />
                              <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xxs }}>{a.audit_type}</Text>
                              <View style={styles.metaDivider} />
                              <Text style={{ color: bucketTone.strong, fontSize: tokens.text.xxs, fontWeight: tokens.fontWeight.bold }}>{bucket}</Text>
                            </View>

                            <View style={[styles.cardDivider, { backgroundColor: tokens.border }]} />

                            <View>
                              <Text style={styles.rackChipsLabel}>
                                {otherRacks.length ? `Also on this task (${otherRacks.length})` : 'Only location on this task'}
                              </Text>
                              {otherRacks.length ? (
                                <View style={{ gap: 8 }}>
                                  {/* Grouped by layout — racks from the same layout sit
                                      together under one heading instead of a flat mixed
                                      row, so it's clear at a glance which layout each one
                                      belongs to (and that e.g. two racks share a layout). */}
                                  {Array.from(
                                    otherRacks
                                      .reduce((byLayout, l) => {
                                        if (!byLayout.has(l.layout)) byLayout.set(l.layout, []);
                                        byLayout.get(l.layout)!.push(l);
                                        return byLayout;
                                      }, new Map<string, typeof otherRacks>())
                                      .entries(),
                                  ).map(([layoutName, racksInLayout]) => (
                                    <View key={layoutName}>
                                      <Text style={styles.rackGroupLayoutLabel}>{layoutName}</Text>
                                      <View style={styles.rackChipsRow}>
                                        {racksInLayout.map((l) => (
                                          <View key={`${l.layout}|${l.rack}`} style={[styles.rackChip, { backgroundColor: tokens.card, borderColor: tokens.border }]}>
                                            <Text style={{ color: tokens.foreground, fontSize: tokens.text.xxs, fontWeight: tokens.fontWeight.semibold }}>
                                              Rack {l.rack}
                                            </Text>
                                          </View>
                                        ))}
                                      </View>
                                    </View>
                                  ))}
                                </View>
                              ) : null}
                            </View>
                          </View>
                        </View>

                        {/* Outside the card box itself (per the sheet's own layout,
                            not nested in the card) — still one per task, since each
                            can belong to a different audit to start. */}
                        <Pressable
                          onPress={() => {
                            setSelectedCell(null);
                            // Straight into the Rack View canvas for the exact
                            // rack tapped on the floor — not the Audit Details
                            // page — showing that rack's full bay diagram with
                            // it already selected. No specific bay came from the
                            // floor (only rack-level), so `bay` is left blank;
                            // Rack View self-heals to that rack's first bay.
                            router.push({
                              pathname: '/audit/[auditId]/rack/[rackId]',
                              params: { auditId: a.audit_id, layout: selectedCell.layout, rackId: selectedCell.rack, bay: '' },
                            } as never);
                          }}
                          style={[styles.openTaskBtn, { backgroundColor: tokens.primary, borderRadius: tokens.radius.lg }]}
                        >
                          <Text style={{ color: tokens.primaryForeground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.xs }}>Start Task</Text>
                          <Ionicons name="chevron-forward" size={14} color={tokens.primaryForeground} />
                        </Pressable>
                        </View>
                      );
                    })
                  ) : (
                    <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.sm, textAlign: 'center', paddingVertical: 20 }}>
                      No task currently touches this rack.
                    </Text>
                  )}
                </ScrollView>
              </>
            ) : null}
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  filterIconBtn: { width: 34, height: 34, alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
  activeChip: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 4 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  legendDot: { width: 8, height: 8, borderRadius: 4 },
  filterBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.3)', alignItems: 'flex-end', paddingTop: 90, paddingRight: 24 },
  filterDropdown: { width: 220, borderWidth: 1, paddingVertical: 6 },
  filterSectionLabel: { fontSize: 11, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.4, paddingHorizontal: 12, paddingTop: 8, paddingBottom: 4 },
  filterOption: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 10 },
  filterDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: 'transparent' },
  body: { flex: 1, padding: 12 },
  canvasToolbarRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 6, paddingHorizontal: 14, paddingVertical: 10, borderBottomWidth: 1 },
  stage: { flex: 1, overflow: 'hidden' },
  stageCenter: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  planCanvas: { flexDirection: 'row', alignItems: 'flex-start', gap: 40, padding: 10 },
  zoneGroupCol: { flexDirection: 'column', gap: 24 },
  zoneGroupRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 24 },
  zone: { gap: 6 },
  zoneHeadRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  zoneAisle: { flexDirection: 'row', flexWrap: 'wrap', gap: 4 },
  zoneAisleVertical: { flexDirection: 'column', flexWrap: 'nowrap' },
  rackCard: { alignItems: 'center', width: 66, borderWidth: 1.5, borderRadius: 5, paddingVertical: 5, paddingHorizontal: 4, gap: 3 },
  bayRow: { flexDirection: 'row', gap: BAY_GAP },
  baySeg: { width: BAY_SEG_W, height: BAY_SEG_H, borderWidth: 1, borderRadius: 1.5 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center', padding: 20 },
  sheet: { width: '100%', maxWidth: 520, maxHeight: '88%', padding: 20 },
  sheetHeadRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 12 },
  sheetDivider: { height: 1, marginBottom: 14 },
  cardDivider: { height: 1, marginTop: 10, marginBottom: 10 },
  taskCard: { borderWidth: 1, padding: 12 },
  sheetSectionLabel: { fontSize: 11, fontWeight: '700', color: '#8A94A3', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 8 },
  metaDivider: { width: 3, height: 3, borderRadius: 1.5, backgroundColor: '#C4CCD6' },
  rackChipsLabel: { fontSize: 10, fontWeight: '600', color: '#8A94A3', marginBottom: 5 },
  rackGroupLayoutLabel: { fontSize: 9, fontWeight: '700', color: '#AEB6C2', textTransform: 'uppercase', letterSpacing: 0.3, marginBottom: 4 },
  rackChipsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  rackChip: { borderWidth: 1, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 4, alignItems: 'center' },
  openTaskBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4, height: 36 },
});
