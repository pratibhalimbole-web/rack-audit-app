import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import Svg, { Ellipse, Line, Polygon } from 'react-native-svg';
import { AppHeader } from '@/components/AppHeader';
import { Pill } from '@/components/Pill';
import { DUE_BUCKETS, dueBucket, uiStatus, type DueBucketKey } from '@/lib/auditLogic';
import { useAuditProgressMap } from '@/hooks/useLocationsTree';
import type { Audit } from '@/lib/types';
import { useTheme } from '@/theme/ThemeProvider';
import { useMyAudits } from '../dashboard/hooks';

// Darkens a "#rrggbb" hex color by `amount` (0-1) — used to derive the
// side-face shade of an isometric block from its base tone, since RagTone/
// AccentTone only give us two solid colors (base/strong), not three.
function darken(hex: string, amount: number): string {
  const num = parseInt(hex.replace('#', ''), 16);
  const r = Math.max(0, Math.round(((num >> 16) & 0xff) * (1 - amount)));
  const g = Math.max(0, Math.round(((num >> 8) & 0xff) * (1 - amount)));
  const b = Math.max(0, Math.round((num & 0xff) * (1 - amount)));
  return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
}

const ISO_W = 26;
const ISO_TOP_H = 15;
const ISO_BODY_H = 34;
const ISO_TOTAL_W = ISO_W * 2;
const ISO_TOTAL_H = ISO_TOP_H + ISO_BODY_H;
const CELL = 72;

// A real isometric cuboid (top/left/right faces as SVG parallelograms, each
// a different shade of the same tone) plus a soft ground-shadow ellipse —
// not a flat rounded square with a drop shadow. Thin lines across the left/
// right faces suggest shelf levels (like a real rack elevation), matching
// the "mesh" texture of a real rack rather than a plain solid block.
function IsoRackBlock({ tone }: { tone: { base: string; strong: string } | null }) {
  const topColor = tone ? tone.base : '#E4E7EC';
  const leftColor = tone ? tone.strong : '#C6CCD3';
  const rightColor = tone ? darken(tone.strong, 0.22) : '#A8B0B9';
  const lineColor = tone ? darken(tone.strong, 0.38) : '#8D96A1';
  const w = ISO_W;
  const levels = 4;
  const leftLines = Array.from({ length: levels - 1 }, (_, i) => {
    const t = (i + 1) / levels;
    const x0 = 0;
    const y0 = ISO_TOP_H / 2 + ISO_BODY_H * t;
    const x1 = w;
    const y1 = ISO_TOP_H + ISO_BODY_H * t;
    return <Line key={`l${i}`} x1={x0} y1={y0} x2={x1} y2={y1} stroke={lineColor} strokeWidth={0.75} opacity={0.55} />;
  });
  const rightLines = Array.from({ length: levels - 1 }, (_, i) => {
    const t = (i + 1) / levels;
    const x0 = w;
    const y0 = ISO_TOP_H + ISO_BODY_H * t;
    const x1 = ISO_TOTAL_W;
    const y1 = ISO_TOP_H / 2 + ISO_BODY_H * t;
    return <Line key={`r${i}`} x1={x0} y1={y0} x2={x1} y2={y1} stroke={lineColor} strokeWidth={0.75} opacity={0.4} />;
  });
  return (
    <Svg width={ISO_TOTAL_W} height={ISO_TOTAL_H + 10}>
      <Ellipse cx={w} cy={ISO_TOTAL_H + 5} rx={w * 0.85} ry={4} fill="rgba(15,23,42,0.16)" />
      <Polygon points={`${w},0 ${ISO_TOTAL_W},${ISO_TOP_H / 2} ${w},${ISO_TOP_H} 0,${ISO_TOP_H / 2}`} fill={topColor} />
      <Polygon points={`0,${ISO_TOP_H / 2} ${w},${ISO_TOP_H} ${w},${ISO_TOTAL_H} 0,${ISO_TOP_H / 2 + ISO_BODY_H}`} fill={leftColor} />
      <Polygon points={`${w},${ISO_TOP_H} ${ISO_TOTAL_W},${ISO_TOP_H / 2} ${ISO_TOTAL_W},${ISO_TOP_H / 2 + ISO_BODY_H} ${w},${ISO_TOTAL_H}`} fill={rightColor} />
      {leftLines}
      {rightLines}
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
  const { data: audits = [] } = useMyAudits();
  const [filter, setFilter] = useState<FilterKey>('All');
  const [selectedCell, setSelectedCell] = useState<RackCell | null>(null);

  const myTasks = useMemo(() => audits.filter((a) => !['Submitted', 'Reconciled', 'Closed'].includes(a.status)), [audits]);
  const { map } = useAuditProgressMap(myTasks.map((a) => a.audit_id));

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

  // The grid itself (which zones/racks exist) stays fixed regardless of the
  // active filter — only the highlight changes — so the map doesn't jump
  // around every time someone taps a different filter chip.
  const zones = useMemo(() => {
    const byLayout = new Map<string, Map<string, RackCell>>();
    myTasks.forEach((a) => {
      (map[a.audit_id]?.allLocations ?? []).forEach(({ layout, rack }) => {
        if (!byLayout.has(layout)) byLayout.set(layout, new Map());
        const racks = byLayout.get(layout)!;
        if (!racks.has(rack)) racks.set(rack, { layout, rack });
      });
    });
    return Array.from(byLayout.entries())
      .map(([layout, racks]) => ({ layout, cells: Array.from(racks.values()).sort((a, b) => a.rack.localeCompare(b.rack)) }))
      .sort((a, b) => a.layout.localeCompare(b.layout));
  }, [myTasks, map]);

  const tasksTouching = (cell: RackCell, pool: Audit[]) =>
    pool.filter((a) => (map[a.audit_id]?.allLocations ?? []).some((l) => l.layout === cell.layout && l.rack === cell.rack));

  const filteredTasks = filter === 'All' ? myTasks : myTasks.filter((a) => dueBucket(a) === filter);

  const colorForCell = (cell: RackCell) => {
    const touching = tasksTouching(cell, filteredTasks);
    if (!touching.length) return null;
    const buckets = touching.map(dueBucket);
    const bucket = BUCKET_PRIORITY.find((b) => buckets.includes(b))!;
    const key = BUCKET_COLOR_KEY[bucket];
    return key === 'accentBlue' ? tokens.accentBlue : tokens.rag[key];
  };

  const selectedTasks = selectedCell ? tasksTouching(selectedCell, myTasks) : [];

  return (
    <View style={{ flex: 1, backgroundColor: tokens.muted }}>
      <AppHeader title="Warehouse Map" sub={`${myTasks.length} task${myTasks.length === 1 ? '' : 's'} across the floor`} showBack />

      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filterRow}>
        {(['All', ...DUE_BUCKETS.map((b) => b.key)] as FilterKey[]).map((key) => {
          const active = filter === key;
          const bucketColor = key !== 'All' ? BUCKET_COLOR_KEY[key as DueBucketKey] : null;
          const tone = bucketColor ? (bucketColor === 'accentBlue' ? tokens.accentBlue : tokens.rag[bucketColor]) : null;
          return (
            <Pressable
              key={key}
              onPress={() => setFilter(key)}
              style={[
                styles.filterChip,
                {
                  backgroundColor: active ? (tone ? tone.base : tokens.primary) : tokens.card,
                  borderColor: active ? (tone ? tone.base : tokens.primary) : tokens.border,
                  borderRadius: tokens.radius.lg,
                },
              ]}
            >
              <Text
                style={{
                  color: active ? tokens.primaryForeground : tokens.foreground,
                  fontWeight: tokens.fontWeight.semibold,
                  fontSize: tokens.text.xs,
                }}
              >
                {key}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>

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
                        const tone = colorForCell(cell);
                        const touchingCount = tasksTouching(cell, filteredTasks).length;
                        return (
                          <View key={cell.rack} style={styles.isoCell}>
                            <View style={styles.isoCounterRotate}>
                              <Pressable onPress={() => setSelectedCell(cell)} hitSlop={4} style={{ alignItems: 'center' }}>
                                <IsoRackBlock tone={tone} />
                                {touchingCount > 1 ? (
                                  <View style={[styles.multiBadge, { backgroundColor: tokens.foreground }]}>
                                    <Text style={{ color: tokens.card, fontSize: 9, fontWeight: tokens.fontWeight.bold }}>{touchingCount}</Text>
                                  </View>
                                ) : null}
                                <Text numberOfLines={1} style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.xxs, marginTop: 2 }}>
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

      <Modal visible={!!selectedCell} transparent animationType="slide" onRequestClose={() => setSelectedCell(null)}>
        <Pressable style={styles.backdrop} onPress={() => setSelectedCell(null)}>
          <Pressable style={[styles.sheet, { backgroundColor: tokens.card, borderTopLeftRadius: tokens.radius.xxl, borderTopRightRadius: tokens.radius.xxl }]} onPress={(e) => e.stopPropagation()}>
            <View style={styles.sheetHandle} />
            {selectedCell ? (
              <>
                <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.extrabold, fontSize: tokens.text.base }}>
                  Rack {selectedCell.rack}
                </Text>
                <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xs, marginTop: 2, marginBottom: 14 }}>{selectedCell.layout}</Text>

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
                            style={[styles.openTaskBtn, { borderColor: tokens.border, borderRadius: tokens.radius.lg }]}
                          >
                            <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.semibold, fontSize: tokens.text.xs }}>Open Task</Text>
                            <Ionicons name="chevron-forward" size={14} color={tokens.mutedForeground} />
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

                <Pressable onPress={() => setSelectedCell(null)} style={[styles.closeBtn, { borderColor: tokens.border, borderRadius: tokens.radius.lg }]}>
                  <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.semibold, fontSize: tokens.text.sm }}>Close</Text>
                </Pressable>
              </>
            ) : null}
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  filterRow: { flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 4 },
  filterChip: { paddingHorizontal: 14, paddingVertical: 8, borderWidth: 1 },
  stage: { flex: 1, overflow: 'hidden' },
  stageCenter: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  isoFloor: { transform: [{ rotateZ: '45deg' }, { scaleY: 0.5 }] },
  isoRow: { flexDirection: 'row' },
  isoLabelCell: { width: CELL, height: CELL, alignItems: 'center', justifyContent: 'center' },
  isoCell: { width: CELL, height: CELL, alignItems: 'center', justifyContent: 'center' },
  isoCounterRotate: { transform: [{ scaleY: 2 }, { rotateZ: '-45deg' }] },
  zoneLabelChip: { flexDirection: 'row', alignItems: 'center', gap: 4, borderWidth: 1, paddingHorizontal: 8, paddingVertical: 4 },
  zoomHint: { position: 'absolute', bottom: 14, alignSelf: 'center', flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: 1, paddingHorizontal: 10, paddingVertical: 6 },
  multiBadge: { position: 'absolute', top: -6, right: 8, minWidth: 18, height: 18, borderRadius: 9, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 3, zIndex: 1 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  sheet: { padding: 16, paddingTop: 10, maxHeight: '80%' },
  sheetHandle: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: '#D0D5DD', marginBottom: 14 },
  taskCard: { borderWidth: 1, padding: 12 },
  bucketBadge: { alignSelf: 'flex-start', paddingHorizontal: 8, paddingVertical: 3 },
  openTaskBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4, borderWidth: 1, height: 34, marginTop: 10 },
  closeBtn: { alignItems: 'center', justifyContent: 'center', borderWidth: 1, height: 46, marginTop: 14 },
});
