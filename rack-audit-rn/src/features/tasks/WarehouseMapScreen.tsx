import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import { AppHeader } from '@/components/AppHeader';
import { Card } from '@/components/Card';
import { Pill } from '@/components/Pill';
import { DUE_BUCKETS, dueBucket, uiStatus, type DueBucketKey } from '@/lib/auditLogic';
import { useAuditProgressMap } from '@/hooks/useLocationsTree';
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

const BUCKET_PRIORITY: DueBucketKey[] = ['Delayed', 'Today', 'This Week', 'This Month'];
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

const BAY_W = 24;
const BAY_H = 9;
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

  const tasksTouching = (cell: RackCell, pool: Audit[]) =>
    pool.filter((a) => (map[a.audit_id]?.allLocations ?? []).some((l) => l.layout === cell.layout && l.rack === cell.rack));

  const bayTasksTouching = (cell: BayCell, pool: Audit[]) =>
    pool.filter((a) => (map[a.audit_id]?.allLocations ?? []).some((l) => l.layout === cell.layout && l.rack === cell.rack && l.bay === cell.bay));

  // Assigned = touched by one of my active tasks, regardless of the current
  // due-bucket filter — this is what tells a rack apart from the rest of
  // the (dimmed) warehouse, separate from which color it's highlighted in.
  const isAssigned = (cell: RackCell) => tasksTouching(cell, myTasks).length > 0;

  const filteredTasks = myTasks.filter((a) => (filter === 'All' || dueBucket(a) === filter) && (typeFilter === 'All' || a.audit_type === typeFilter));
  const anyFilterActive = filter !== 'All' || typeFilter !== 'All';

  const bucketColorFor = (touching: Audit[]): string | null => {
    if (!touching.length) return null;
    const buckets = touching.map(dueBucket);
    const bucket = BUCKET_PRIORITY.find((b) => buckets.includes(b))!;
    const key = BUCKET_COLOR_KEY[bucket];
    return (key === 'accentBlue' ? tokens.accentBlue : tokens.rag[key]).base;
  };

  const selectedTasks = selectedCell ? tasksTouching(selectedCell, myTasks) : [];
  const totalRackCount = zones.reduce((n, z) => n + z.racks.length, 0);
  const assignedRackCount = zones.reduce((n, z) => n + z.racks.filter((r) => isAssigned({ layout: z.layout, rack: r.rack })).length, 0);

  return (
    <View style={{ flex: 1, backgroundColor: tokens.muted }}>
      <AppHeader title="Warehouse Map" sub={`${assignedRackCount} of ${totalRackCount} racks assigned to you`} showBack />

      {zones.length ? (
        <View style={styles.body}>
          <Card style={{ padding: 0, overflow: 'hidden', flex: 1 }}>
            <View style={[styles.diagramHeadRow, { backgroundColor: '#F7F8FA', borderBottomColor: tokens.border }]}>
              <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm }}>Warehouse Floor — Top View</Text>
              <Pressable
                onPress={() => setFilterOpen((o) => !o)}
                style={[styles.filterIconBtn, { backgroundColor: tokens.card, borderColor: filterOpen ? tokens.primary : tokens.border, borderRadius: tokens.radius.lg }]}
              >
                <Ionicons name="filter-outline" size={16} color={tokens.foreground} />
                {anyFilterActive ? <View style={[styles.filterActiveDot, { backgroundColor: tokens.primary, borderColor: tokens.card }]} /> : null}
              </Pressable>
            </View>
            <View style={styles.stage}>
              <GestureDetector gesture={floorGesture}>
                <View style={styles.stageCenter}>
                  <Animated.View style={floorAnimatedStyle}>
                    <View style={styles.planCanvas}>
                      {zones.map((zone) => (
                        <View key={zone.layout} style={styles.zone}>
                          <View style={styles.zoneHeadRow}>
                            <Ionicons name="business-outline" size={12} color={tokens.mutedForeground} />
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
                          <View style={styles.zoneAisle}>
                            {zone.racks.map((rackGroup) => {
                              const cell: RackCell = { layout: zone.layout, rack: rackGroup.rack };
                              const assigned = isAssigned(cell);
                              const touchingCount = tasksTouching(cell, filteredTasks).length;
                              const rackBorder = assigned ? ASSIGNED_WIRE : UNASSIGNED_WIRE;
                              return (
                                <Pressable key={rackGroup.rack} onPress={() => setSelectedCell(cell)} hitSlop={4} style={styles.rackWrap}>
                                  {touchingCount ? (
                                    <View style={[styles.taskBadge, { backgroundColor: bucketColorFor(tasksTouching(cell, filteredTasks)) ?? tokens.mutedForeground, borderColor: tokens.card }]}>
                                      <Ionicons name="flag" size={8} color="#fff" />
                                      {touchingCount > 1 ? <Text style={styles.taskBadgeCount}>{touchingCount}</Text> : null}
                                    </View>
                                  ) : null}
                                  <View style={[styles.rackFrame, { borderColor: rackBorder, backgroundColor: assigned ? '#F3F5F8' : '#FAFBFC' }]}>
                                    {rackGroup.bays.map((bayCell) => {
                                      const bayColor = bucketColorFor(bayTasksTouching(bayCell, filteredTasks));
                                      return (
                                        <View
                                          key={bayCell.bay}
                                          style={[
                                            styles.baySeg,
                                            { backgroundColor: bayColor ?? 'transparent', borderColor: bayColor ?? (assigned ? rackBorder : UNASSIGNED_WIRE) },
                                          ]}
                                        />
                                      );
                                    })}
                                  </View>
                                  <Text
                                    numberOfLines={1}
                                    style={{
                                      color: assigned ? tokens.foreground : tokens.slate400,
                                      fontWeight: assigned ? tokens.fontWeight.bold : tokens.fontWeight.medium,
                                      fontSize: 9,
                                      marginTop: 2,
                                    }}
                                  >
                                    Rack {rackGroup.rack}
                                  </Text>
                                </Pressable>
                              );
                            })}
                          </View>
                        </View>
                      ))}
                    </View>
                  </Animated.View>
                </View>
              </GestureDetector>
              <View style={[styles.zoomHint, { backgroundColor: tokens.card, borderColor: tokens.border, borderRadius: tokens.radius.lg }]}>
                <Ionicons name="resize-outline" size={13} color={tokens.mutedForeground} />
                <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xxs }}>Pinch to zoom · drag to pan</Text>
              </View>
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
                        <View key={a.audit_id} style={[styles.taskCard, { backgroundColor: tokens.muted, borderColor: tokens.border, borderRadius: tokens.radius.lg }]}>
                          <View style={{ flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between' }}>
                            <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm, flex: 1, marginRight: 8 }}>
                              {a.audit_name}
                            </Text>
                            <Pill label={uiStatus(a)} tone={uiStatus(a)} />
                          </View>
                          <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xxs, marginTop: 3 }}>
                            {a.audit_id} · {a.audit_type}
                          </Text>
                          <View style={[styles.bucketBadge, { backgroundColor: bucketTone.soft, borderRadius: tokens.radius.sm, marginTop: 8 }]}>
                            <Text style={{ color: bucketTone.strong, fontSize: tokens.text.xxs, fontWeight: tokens.fontWeight.bold }}>{bucket}</Text>
                          </View>
                          {otherRacks.length ? (
                            <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xxs, marginTop: 8, lineHeight: 16 }}>
                              Also spans {otherRacks.length} more location{otherRacks.length === 1 ? '' : 's'} on this task —{' '}
                              {otherRacks.map((l) => `${l.layout} · Rack ${l.rack}`).join(', ')}. Worth weighing how far that is before committing to this one.
                            </Text>
                          ) : (
                            <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xxs, marginTop: 8 }}>
                              This is the only location on this task.
                            </Text>
                          )}
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
  filterActiveDot: { position: 'absolute', top: -3, right: -3, width: 10, height: 10, borderRadius: 5, borderWidth: 1.5 },
  filterBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.3)', alignItems: 'flex-end', paddingTop: 90, paddingRight: 24 },
  filterDropdown: { width: 220, borderWidth: 1, paddingVertical: 6 },
  filterSectionLabel: { fontSize: 11, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.4, paddingHorizontal: 12, paddingTop: 8, paddingBottom: 4 },
  filterOption: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 10 },
  filterDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: 'transparent' },
  body: { flex: 1, padding: 12 },
  diagramHeadRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 14, paddingVertical: 10, borderBottomWidth: 1 },
  stage: { flex: 1, overflow: 'hidden' },
  stageCenter: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  planCanvas: { gap: 20, padding: 10 },
  zone: { gap: 6 },
  zoneHeadRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  zoneAisle: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  rackWrap: { alignItems: 'center', width: 62 },
  rackFrame: { borderWidth: 1.5, borderRadius: 3, padding: 2, gap: BAY_GAP },
  baySeg: { width: BAY_W, height: BAY_H, borderWidth: 1, borderRadius: 1 },
  taskBadge: {
    position: 'absolute',
    top: -6,
    right: -2,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    borderWidth: 1.5,
    justifyContent: 'center',
    paddingHorizontal: 3,
    zIndex: 1,
  },
  taskBadgeCount: { color: '#fff', fontSize: 8, fontWeight: '700' },
  zoomHint: { position: 'absolute', bottom: 14, alignSelf: 'center', flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: 1, paddingHorizontal: 10, paddingVertical: 6 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center', padding: 20 },
  sheet: { width: '100%', maxWidth: 440, maxHeight: '80%', padding: 18 },
  sheetHeadRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 14 },
  taskCard: { borderWidth: 1, padding: 12 },
  bucketBadge: { alignSelf: 'flex-start', paddingHorizontal: 8, paddingVertical: 3 },
  openTaskBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4, height: 36, marginTop: 10 },
});
