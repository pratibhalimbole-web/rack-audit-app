import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import Svg, { Line, Polygon } from 'react-native-svg';
import { AppHeader } from '@/components/AppHeader';
import { Pill } from '@/components/Pill';
import { DUE_BUCKETS, dueBucket, uiStatus, type DueBucketKey } from '@/lib/auditLogic';
import { useAuditProgressMap } from '@/hooks/useLocationsTree';
import type { Audit } from '@/lib/types';
import { useTheme } from '@/theme/ThemeProvider';
import { useAudits, useMyAudits } from '../dashboard/hooks';

const ISO_W = 28;
const ISO_TOP_H = 16;
const ISO_BODY_H = 40;
const ISO_TOTAL_W = ISO_W * 2;
const ISO_TOTAL_H = ISO_TOP_H + ISO_BODY_H;
const CELL = 74;
const ASSIGNED_WIRE_COLOR = '#5B6B82';
const UNASSIGNED_WIRE_COLOR = '#DCE1E7';

// A wireframe rack (stroke-only cuboid edges + a level/upright grid on each
// face, like a real racking frame elevation) — most of the warehouse is
// drawn this way, in a light neutral wire so it recedes into the floor.
// A rack that has one of my active tasks gets its three faces filled with
// a shaded tint of the task's due-bucket color (top lightest, right face
// darkest — like a lit cube) instead of just a tiny marker, so a task is
// obviously visible at a glance, even zoomed out over a big floor, not
// just discoverable by tapping around.
function IsoRackBlock({ assigned, markerColor }: { assigned: boolean; markerColor: string | null }) {
  const wire = markerColor ?? (assigned ? ASSIGNED_WIRE_COLOR : UNASSIGNED_WIRE_COLOR);
  const strokeW = markerColor ? 1.75 : assigned ? 1.5 : 1;
  const topFill = markerColor ? withOpacity(markerColor, 0.55) : 'none';
  const leftFill = markerColor ? withOpacity(markerColor, 0.32) : 'none';
  const rightFill = markerColor ? withOpacity(markerColor, 0.2) : 'none';
  const w = ISO_W;
  const levels = 4;
  const gridLines: React.ReactNode[] = [];
  for (let i = 1; i < levels; i++) {
    const t = i / levels;
    gridLines.push(
      <Line key={`l${i}`} x1={0} y1={ISO_TOP_H / 2 + ISO_BODY_H * t} x2={w} y2={ISO_TOP_H + ISO_BODY_H * t} stroke={wire} strokeWidth={strokeW * 0.7} opacity={assigned ? 0.7 : 0.5} />,
      <Line
        key={`r${i}`}
        x1={w}
        y1={ISO_TOP_H + ISO_BODY_H * t}
        x2={ISO_TOTAL_W}
        y2={ISO_TOP_H / 2 + ISO_BODY_H * t}
        stroke={wire}
        strokeWidth={strokeW * 0.7}
        opacity={assigned ? 0.7 : 0.5}
      />,
    );
  }
  const uprights = [0.33, 0.67];
  uprights.forEach((t, i) => {
    // Left-face upright: interpolate between the face's top edge (0,topH/2)-(w,topH)
    // and bottom edge (0,topH/2+bodyH)-(w,totalH) at fraction t.
    const lx = w * t;
    const ly0 = ISO_TOP_H / 2 + (ISO_TOP_H / 2) * t;
    const ly1 = ISO_TOP_H / 2 + ISO_BODY_H + (ISO_TOP_H / 2) * t;
    gridLines.push(<Line key={`lu${i}`} x1={lx} y1={ly0} x2={lx} y2={ly1} stroke={wire} strokeWidth={strokeW * 0.7} opacity={assigned ? 0.5 : 0.35} />);
    // Right-face upright, mirrored.
    const rx = w + w * t;
    const ry0 = ISO_TOP_H - (ISO_TOP_H / 2) * t;
    const ry1 = ISO_TOP_H + ISO_BODY_H - (ISO_TOP_H / 2) * t;
    gridLines.push(<Line key={`ru${i}`} x1={rx} y1={ry0} x2={rx} y2={ry1} stroke={wire} strokeWidth={strokeW * 0.7} opacity={assigned ? 0.5 : 0.35} />);
  });

  return (
    <Svg width={ISO_TOTAL_W} height={ISO_TOTAL_H + 4}>
      <Polygon points={`${w},0 ${ISO_TOTAL_W},${ISO_TOP_H / 2} ${w},${ISO_TOP_H} 0,${ISO_TOP_H / 2}`} fill={topFill} stroke={wire} strokeWidth={strokeW} />
      <Polygon points={`0,${ISO_TOP_H / 2} ${w},${ISO_TOP_H} ${w},${ISO_TOTAL_H} 0,${ISO_TOP_H / 2 + ISO_BODY_H}`} fill={leftFill} stroke={wire} strokeWidth={strokeW} />
      <Polygon
        points={`${w},${ISO_TOP_H} ${ISO_TOTAL_W},${ISO_TOP_H / 2} ${ISO_TOTAL_W},${ISO_TOP_H / 2 + ISO_BODY_H} ${w},${ISO_TOTAL_H}`}
        fill={rightFill}
        stroke={wire}
        strokeWidth={strokeW}
      />
      {gridLines}
    </Svg>
  );
}

// "#rrggbb" -> "rgba(r,g,b,alpha)", so a due-bucket tone (always solid hex
// in this app's theme, light and dark alike) can be used as a translucent
// SVG fill.
function withOpacity(hex: string, alpha: number): string {
  const num = parseInt(hex.replace('#', ''), 16);
  const r = (num >> 16) & 0xff;
  const g = (num >> 8) & 0xff;
  const b = num & 0xff;
  return `rgba(${r},${g},${b},${alpha})`;
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
  const scale = useSharedValue(0.4);
  const savedScale = useSharedValue(0.4);
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
      scale.value = Math.min(3, Math.max(0.2, savedScale.value * e.scale));
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

    // The real audit data only covers a handful of racks per aisle — nowhere
    // near what an actual warehouse floor looks like. Pad every aisle with
    // extra unassigned filler racks (and add a couple of aisles that are
    // entirely filler) so the floor reads as a genuinely large warehouse,
    // with the racks that are actually mine standing out against it.
    const RACKS_PER_ZONE = 14;
    const zoneNames = [...Array.from(byLayout.keys()), 'Layout D', 'Layout F'];
    zoneNames.forEach((layout) => {
      if (!byLayout.has(layout)) byLayout.set(layout, new Map());
      const racks = byLayout.get(layout)!;
      const prefix = layout.replace(/^Layout /, '');
      for (let n = 1; racks.size < RACKS_PER_ZONE && n <= 60; n++) {
        const code = `${prefix}-${String(n).padStart(2, '0')}`;
        if (!racks.has(code)) racks.set(code, { layout, rack: code });
      }
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
  isoRow: { flexDirection: 'row' },
  isoLabelCell: { width: CELL, height: CELL, alignItems: 'center', justifyContent: 'center' },
  isoCell: { width: CELL, height: CELL, alignItems: 'center', justifyContent: 'center' },
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
