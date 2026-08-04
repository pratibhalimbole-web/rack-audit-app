import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import Svg, { Line, Polygon, Polyline } from 'react-native-svg';
import { AppHeader } from '@/components/AppHeader';
import { Pill } from '@/components/Pill';
import { DUE_BUCKETS, dueBucket, uiStatus, type DueBucketKey } from '@/lib/auditLogic';
import { useAuditProgressMap } from '@/hooks/useLocationsTree';
import type { Audit } from '@/lib/types';
import { useTheme } from '@/theme/ThemeProvider';
import { useAudits, useMyAudits } from '../dashboard/hooks';

// A rack elevation is much taller than it is wide (real racking is tall
// vertical shelving, not a squat cube) — RACK_W/RACK_H below reflect that
// ~1:3 ratio, matching what an actual rack front elevation looks like.
const RACK_W = 22;
const RACK_H = 62;
const CELL_W = 60;
// Taller than the rack's own render height (rack + ground shadow + label
// text below it) so adjacent aisle rows don't visually overlap once the
// floor's scaleY(0.5) isometric squash is applied.
const CELL_H = 92;
const ASSIGNED_WIRE_COLOR = '#5B6B82';
const UNASSIGNED_WIRE_COLOR = '#DCE1E7';

// Rendered as a flat, upright wireframe rack elevation (uprights + shelf-
// level beams) — NOT its own little isometric cuboid. An earlier version
// drew each rack as a mini 3D box, which combined with the floor's own
// rotate+scaleY isometric transform made every rack look tilted/leaning
// sideways instead of standing up straight. A flat 2D "elevation" sprite
// placed on the rotated floor grid (the same trick isometric game maps use
// for buildings/props) reads correctly as a rack standing on the floor.
function IsoRackBlock({ assigned, markerColor }: { assigned: boolean; markerColor: string | null }) {
  const wire = assigned ? ASSIGNED_WIRE_COLOR : UNASSIGNED_WIRE_COLOR;
  const strokeW = assigned ? 1.5 : 1;
  const levels = 4;
  const gridLines: React.ReactNode[] = [];
  // Shelf-level beams (horizontal).
  for (let i = 1; i < levels; i++) {
    const y = (RACK_H * i) / levels;
    gridLines.push(<Line key={`beam${i}`} x1={0} y1={y} x2={RACK_W} y2={y} stroke={wire} strokeWidth={strokeW * 0.7} opacity={assigned ? 0.7 : 0.5} />);
  }
  // A center upright, splitting the frame into two bays.
  gridLines.push(<Line key="upright" x1={RACK_W / 2} y1={0} x2={RACK_W / 2} y2={RACK_H} stroke={wire} strokeWidth={strokeW * 0.7} opacity={assigned ? 0.6 : 0.4} />);

  const zigzag = markerColor
    ? Array.from({ length: 5 }, (_, i) => {
        const y = RACK_H * 0.15 + (RACK_H * 0.7 * i) / 4;
        const x = RACK_W / 2 + (i % 2 === 0 ? -5 : 5);
        return `${x},${y}`;
      }).join(' ')
    : null;

  return (
    <Svg width={RACK_W} height={RACK_H + 6}>
      {/* Ground shadow, so the rack reads as standing on the floor. */}
      <Polygon points={`${RACK_W * 0.15},${RACK_H + 4} ${RACK_W * 0.85},${RACK_H + 4} ${RACK_W},${RACK_H} 0,${RACK_H}`} fill="rgba(15,23,42,0.08)" />
      <Polygon points={`0,0 ${RACK_W},0 ${RACK_W},${RACK_H} 0,${RACK_H}`} fill="none" stroke={wire} strokeWidth={strokeW} />
      {gridLines}
      {zigzag ? <Polyline points={zigzag} fill="none" stroke={markerColor!} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" /> : null}
    </Svg>
  );
}

// Not a tracker of where the inspector physically is — there's no device
// location signal here — this is a visual "where do my tasks actually sit"
// map of the warehouse, so an inspector can judge for themselves (by their
// own sense of distance, how long the walk/lift ride is, which bay levels
// need a ladder or a vehicle) which task to tackle next. Racks are grouped
// into "zones" by layout, since that's the only structure the data already
// has — there's no real x/y floor-plan coordinate anywhere in this app.
type RackCell = { layout: string; rack: string };
type FilterKey = 'All' | DueBucketKey;

const BUCKET_PRIORITY: DueBucketKey[] = ['Delayed', 'Today', 'This Week', 'This Month'];
const BUCKET_COLOR_KEY: Record<DueBucketKey, 'red' | 'green' | 'accentBlue' | 'amber'> = {
  Delayed: 'red',
  Today: 'green',
  'This Week': 'accentBlue',
  'This Month': 'amber',
};

export function WarehouseMapScreen() {
  const { tokens } = useTheme();
  const { data: myAudits = [] } = useMyAudits();
  // The floor itself is drawn from every audit in the warehouse (not just
  // mine) so unassigned racks actually show up on the map — otherwise
  // there'd be nothing to dim, since a rack only exists in this data model
  // as part of some audit's scope.
  const { data: allAudits = [] } = useAudits();
  const [filter, setFilter] = useState<FilterKey>('All');
  const [filterOpen, setFilterOpen] = useState(false);
  const [selectedCell, setSelectedCell] = useState<RackCell | null>(null);

  const myTasks = useMemo(() => myAudits.filter((a) => !['Submitted', 'Reconciled', 'Closed'].includes(a.status)), [myAudits]);
  const { map } = useAuditProgressMap(allAudits.map((a) => a.audit_id));

  // Pinch-to-zoom/pan on the floor, same pattern as Rack View's canvas —
  // the isometric floor is wide, so exploring it on a phone-sized screen
  // needs zoom, not just a fixed layout.
  const scale = useSharedValue(0.85);
  const savedScale = useSharedValue(0.85);
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
      scale.value = Math.min(3, Math.max(0.4, savedScale.value * e.scale));
    })
    .onEnd(() => {
      savedScale.value = scale.value;
    });
  const floorGesture = Gesture.Simultaneous(panGesture, pinchGesture);
  const floorAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }, { translateY: translateY.value }, { scale: scale.value }],
  }));

  // The grid itself (every rack in the warehouse, from every audit) stays
  // fixed regardless of the active filter — only the highlight changes —
  // so the map doesn't jump around every time someone taps a filter option.
  const zones = useMemo(() => {
    const byLayout = new Map<string, Map<string, RackCell>>();
    allAudits.forEach((a) => {
      (map[a.audit_id]?.allLocations ?? []).forEach(({ layout, rack }) => {
        if (!byLayout.has(layout)) byLayout.set(layout, new Map());
        const racks = byLayout.get(layout)!;
        if (!racks.has(rack)) racks.set(rack, { layout, rack });
      });
    });
    return Array.from(byLayout.entries())
      .map(([layout, racks]) => ({ layout, cells: Array.from(racks.values()).sort((a, b) => a.rack.localeCompare(b.rack)) }))
      .sort((a, b) => a.layout.localeCompare(b.layout));
  }, [allAudits, map]);

  const tasksTouching = (cell: RackCell, pool: Audit[]) =>
    pool.filter((a) => (map[a.audit_id]?.allLocations ?? []).some((l) => l.layout === cell.layout && l.rack === cell.rack));

  // Assigned = touched by one of my active tasks, regardless of the current
  // due-bucket filter — this is what tells a rack apart from the rest of
  // the (dimmed) warehouse, separate from which color it's highlighted in.
  const isAssigned = (cell: RackCell) => tasksTouching(cell, myTasks).length > 0;

  const filteredTasks = filter === 'All' ? myTasks : myTasks.filter((a) => dueBucket(a) === filter);

  const colorForCell = (cell: RackCell): string | null => {
    const touching = tasksTouching(cell, filteredTasks);
    if (!touching.length) return null;
    const buckets = touching.map(dueBucket);
    const bucket = BUCKET_PRIORITY.find((b) => buckets.includes(b))!;
    const key = BUCKET_COLOR_KEY[bucket];
    return (key === 'accentBlue' ? tokens.accentBlue : tokens.rag[key]).base;
  };

  const selectedTasks = selectedCell ? tasksTouching(selectedCell, myTasks) : [];
  const totalRackCount = zones.reduce((n, z) => n + z.cells.length, 0);
  const assignedRackCount = zones.reduce((n, z) => n + z.cells.filter(isAssigned).length, 0);

  return (
    <View style={{ flex: 1, backgroundColor: tokens.muted }}>
      <AppHeader title="Warehouse Map" sub={`${assignedRackCount} of ${totalRackCount} racks assigned to you`} showBack />

      <View style={styles.filterBarRow}>
        <Pressable
          onPress={() => setFilterOpen((o) => !o)}
          style={[styles.filterBtn, { backgroundColor: tokens.card, borderColor: filterOpen ? tokens.primary : tokens.border, borderRadius: tokens.radius.lg }]}
        >
          <Ionicons name="filter-outline" size={16} color={tokens.foreground} />
          <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.semibold, fontSize: tokens.text.xs }}>{filter}</Text>
          <Ionicons name={filterOpen ? 'chevron-up' : 'chevron-down'} size={14} color={tokens.mutedForeground} />
        </Pressable>

        {filterOpen ? (
          <>
            <Pressable style={styles.filterBackdrop} onPress={() => setFilterOpen(false)} />
            <View style={[styles.filterDropdown, { backgroundColor: tokens.card, borderColor: tokens.border, borderRadius: tokens.radius.lg }]}>
              {(['All', ...DUE_BUCKETS.map((b) => b.key)] as FilterKey[]).map((key) => {
                const active = filter === key;
                const bucketColor = key !== 'All' ? BUCKET_COLOR_KEY[key as DueBucketKey] : null;
                const tone = bucketColor ? (bucketColor === 'accentBlue' ? tokens.accentBlue : tokens.rag[bucketColor]) : null;
                return (
                  <Pressable
                    key={key}
                    onPress={() => {
                      setFilter(key);
                      setFilterOpen(false);
                    }}
                    style={[styles.filterOption, active ? { backgroundColor: tokens.muted } : null]}
                  >
                    {tone ? <View style={[styles.filterDot, { backgroundColor: tone.base }]} /> : <View style={styles.filterDot} />}
                    <Text style={{ color: tokens.foreground, fontWeight: active ? tokens.fontWeight.bold : tokens.fontWeight.medium, fontSize: tokens.text.sm, flex: 1 }}>
                      {key}
                    </Text>
                    {active ? <Ionicons name="checkmark" size={16} color={tokens.primary} /> : null}
                  </Pressable>
                );
              })}
            </View>
          </>
        ) : null}
      </View>

      {zones.length ? (
        <View style={styles.stage}>
          <GestureDetector gesture={floorGesture}>
            <View style={styles.stageCenter}>
              <Animated.View style={floorAnimatedStyle}>
                {/* True top-down isometric: the whole floor (ordinary stacked
                    rows/columns) is rotated 45° then squashed vertically by
                    half — the standard "rotate + scaleY(0.5)" trick that
                    turns a flat grid into a diamond floor plan. Each rack
                    inside gets the exact inverse transform so it renders
                    upright and readable while still sitting in its grid
                    slot on the diamond. */}
                <View style={styles.isoFloor}>
                <View style={[styles.warehouseBoundary, { borderColor: tokens.border, backgroundColor: tokens.card }]}>
                  {zones.map((zone) => (
                    <View key={zone.layout} style={styles.isoRow}>
                      <View style={styles.isoLabelCell}>
                        <View style={styles.isoCounterRotate}>
                          <View style={[styles.zoneLabelChip, { backgroundColor: tokens.card, borderColor: tokens.border, borderRadius: tokens.radius.lg }]}>
                            <Ionicons name="business-outline" size={11} color={tokens.mutedForeground} />
                            <Text style={{ color: tokens.mutedForeground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.xxs }}>{zone.layout}</Text>
                          </View>
                        </View>
                      </View>
                      {zone.cells.map((cell) => {
                        const assigned = isAssigned(cell);
                        const markerColor = colorForCell(cell);
                        const touchingCount = tasksTouching(cell, filteredTasks).length;
                        return (
                          <View key={cell.rack} style={styles.isoCell}>
                            <View style={styles.isoCounterRotate}>
                              <Pressable onPress={() => setSelectedCell(cell)} hitSlop={6} style={{ alignItems: 'center' }}>
                                <IsoRackBlock assigned={assigned} markerColor={markerColor} />
                                {touchingCount ? (
                                  <View style={[styles.taskBadge, { backgroundColor: markerColor ?? tokens.mutedForeground, borderColor: tokens.card }]}>
                                    <Ionicons name="flag" size={9} color="#fff" />
                                    {touchingCount > 1 ? <Text style={styles.taskBadgeCount}>{touchingCount}</Text> : null}
                                  </View>
                                ) : null}
                                <Text
                                  numberOfLines={1}
                                  style={{
                                    color: assigned ? tokens.foreground : tokens.slate400,
                                    fontWeight: assigned ? tokens.fontWeight.bold : tokens.fontWeight.medium,
                                    fontSize: tokens.text.xxs,
                                    marginTop: 2,
                                  }}
                                >
                                  {cell.rack}
                                </Text>
                              </Pressable>
                            </View>
                          </View>
                        );
                      })}
                    </View>
                  ))}
                </View>
                </View>
              </Animated.View>
            </View>
          </GestureDetector>
          <View style={[styles.zoomHint, { backgroundColor: tokens.card, borderColor: tokens.border, borderRadius: tokens.radius.lg }]}>
            <Ionicons name="resize-outline" size={13} color={tokens.mutedForeground} />
            <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xxs }}>Pinch to zoom · drag to pan</Text>
          </View>
        </View>
      ) : (
        <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.sm, textAlign: 'center', paddingVertical: 40 }}>
          No task locations to map yet.
        </Text>
      )}

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
                              router.push({ pathname: '/audit/[auditId]', params: { auditId: a.audit_id } } as never);
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
  filterBarRow: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 4 },
  filterBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', borderWidth: 1, paddingHorizontal: 12, height: 38 },
  filterBackdrop: { position: 'absolute', top: -1000, left: -1000, right: -1000, bottom: -1000, zIndex: 5 },
  filterDropdown: { position: 'absolute', top: 42, left: 0, width: 200, borderWidth: 1, paddingVertical: 4, zIndex: 6 },
  filterOption: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 10 },
  filterDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: 'transparent' },
  stage: { flex: 1, overflow: 'hidden' },
  stageCenter: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  isoFloor: { transform: [{ rotateZ: '45deg' }, { scaleY: 0.5 }] },
  warehouseBoundary: { borderWidth: 3, padding: 18 },
  isoRow: { flexDirection: 'row' },
  isoLabelCell: { width: CELL_W, height: CELL_H, alignItems: 'center', justifyContent: 'center' },
  isoCell: { width: CELL_W, height: CELL_H, alignItems: 'center', justifyContent: 'flex-end', paddingBottom: 8 },
  isoCounterRotate: { transform: [{ scaleY: 2 }, { rotateZ: '-45deg' }] },
  zoneLabelChip: { flexDirection: 'row', alignItems: 'center', gap: 4, borderWidth: 1, paddingHorizontal: 8, paddingVertical: 4 },
  zoomHint: { position: 'absolute', bottom: 14, alignSelf: 'center', flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: 1, paddingHorizontal: 10, paddingVertical: 6 },
  taskBadge: {
    position: 'absolute',
    top: -4,
    right: 6,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 1.5,
    justifyContent: 'center',
    paddingHorizontal: 4,
    zIndex: 1,
  },
  taskBadgeCount: { color: '#fff', fontSize: 9, fontWeight: '700' },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center', padding: 20 },
  sheet: { width: '100%', maxWidth: 440, maxHeight: '80%', padding: 18 },
  sheetHeadRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 14 },
  taskCard: { borderWidth: 1, padding: 12 },
  bucketBadge: { alignSelf: 'flex-start', paddingHorizontal: 8, paddingVertical: 3 },
  openTaskBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4, height: 36, marginTop: 10 },
});
