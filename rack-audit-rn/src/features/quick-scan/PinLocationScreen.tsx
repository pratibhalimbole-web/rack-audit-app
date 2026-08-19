import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { runOnJS, useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import Svg, { Circle, Line } from 'react-native-svg';
import { AppHeader } from '@/components/AppHeader';
import type { SheetOption } from '@/components/BottomSheetPicker';
import { Card } from '@/components/Card';
import { InlineDropdown, ToolbarField } from '@/components/ToolbarDropdownField';
import { useAuditProgressMap } from '@/hooks/useLocationsTree';
import { FLOOR_AREAS } from '@/lib/mockData';
import { useQuickScanPinStore } from '@/store/useQuickScanPinStore';
import { useTheme } from '@/theme/ThemeProvider';
import { useAudits } from '../dashboard/hooks';

type BayCell = { layout: string; rack: string; bay: string };
type RackGroup = { rack: string; bays: BayCell[] };
type ZoneGroup = { layout: string; racks: RackGroup[] };
type PalletCell = { code: string; level?: number; slot?: number };
type LinePoints = { x1: number; y1: number; x2: number; y2: number };

const BAY_SEG_W = 9;
const BAY_SEG_H = 14;
const BAY_GAP = 1.5;
const PIN_WIRE = '#DCE1E7';

// A rack-holding zone's real name IS "Layout X" — no longer relabeled to
// "Zone X" for display, since "Zone" is now reserved for the separate,
// rack-less floor-area concept (see FLOOR_AREAS) so the two don't get
// confused for one another.
function zoneLabel(zone: string): string {
  return zone;
}

// Level + slot on that level, e.g. level 5 / slot 1 -> "P-0501" — same
// pallet-ID convention Rack View's palletIdFor uses, minus the bay prefix
// (the Bay field already says which bay it's in here).
function palletLabel(loc: PalletCell): string {
  return loc.level != null && loc.slot != null ? `P-${String(loc.level).padStart(2, '0')}${String(loc.slot).padStart(2, '0')}` : loc.code;
}

const zoneAnchorKey = (layout: string) => `zone:${layout}`;
const rackAnchorKey = (layout: string, rack: string) => `rack:${layout}:${rack}`;

// Ports the same top-down zone/rack/bay floor-plan approach as Tasks on Map
// (src/features/tasks/WarehouseMapScreen.tsx) — same padding/grouping logic,
// same pinch-zoom-pan canvas — but driven by "where did I just pin," not by
// task assignment, and the whole warehouse (every audit's locations), not
// just mine, since a floor/rack find can turn up anywhere.
export function PinLocationScreen() {
  const { tokens } = useTheme();
  const target = useQuickScanPinStore((s) => s.target);
  const submitResult = useQuickScanPinStore((s) => s.submitResult);
  const { data: allAudits = [] } = useAudits();
  const { map } = useAuditProgressMap(allAudits.map((a) => a.audit_id));

  // The pin — settable either by tapping a rack/zone on the map, or by
  // picking from the Layout/Rack/Bay/Pallet dropdowns below. Both are just
  // two ways of writing the same state, so they always stay in sync with
  // whichever was used last, exactly like dropping a pin vs. typing an
  // address into the search box on Google Maps. Pallet is dropdown-only —
  // the map's floor plan only renders down to rack/bay grain, not
  // individual pallets.
  const [pinLayout, setPinLayout] = useState<string | null>(null);
  const [pinRack, setPinRack] = useState<string | null>(null);
  const [pinBay, setPinBay] = useState<string | null>(null);
  const [pinLoc, setPinLoc] = useState<string | null>(null);
  // Pinned to the aisle right next to pinRack, not a specific bay — a
  // pallet sitting in the walkway rather than racked. Mutually exclusive
  // with pinBay/pinLoc (a pallet is either racked or in the aisle, never
  // both), and with pinFloorAreaId below (an aisle is still "near a rack,"
  // unlike a standalone floor area).
  const [pinAisle, setPinAisle] = useState(false);
  // Pinned to a standalone open-floor area (see FLOOR_AREAS) — mutually
  // exclusive with the whole Layout/Rack/Bay/Aisle path, since a floor
  // area has no rack structure under it at all.
  const [pinFloorAreaId, setPinFloorAreaId] = useState<string | null>(null);
  const [openField, setOpenField] = useState<'layout' | 'rack' | 'bay' | 'loc' | null>(null);

  useEffect(() => {
    if (!target) router.back();
  }, [target]);

  // The dotted joint connecting the SKU's expected zone (a fixed red dot)
  // to wherever the inspector has pinned so far (blue) — measured in real
  // screen coordinates of the two anchor views (see anchorRefs below) each
  // time the pin changes, so it visually calls out the gap the moment
  // there's something to show, not just after Confirm Pin.
  const stageRef = useRef<View>(null);
  const anchorRefs = useRef<Record<string, View | null>>({});
  const [linePoints, setLinePoints] = useState<LinePoints | null>(null);

  const scale = useSharedValue(0.7);
  const savedScale = useSharedValue(0.7);
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const savedTranslateX = useSharedValue(0);
  const savedTranslateY = useSharedValue(0);
  // Re-measures the dotted joint's endpoints once the pan/pinch settles —
  // mid-gesture the line would otherwise trail the last pin position
  // instead of the on-screen anchors, which have moved under the gesture.
  const panGesture = Gesture.Pan()
    .onUpdate((e) => {
      translateX.value = savedTranslateX.value + e.translationX;
      translateY.value = savedTranslateY.value + e.translationY;
    })
    .onEnd(() => {
      savedTranslateX.value = translateX.value;
      savedTranslateY.value = translateY.value;
      runOnJS(remeasureLine)();
    });
  const pinchGesture = Gesture.Pinch()
    .onUpdate((e) => {
      scale.value = Math.min(3, Math.max(0.3, savedScale.value * e.scale));
    })
    .onEnd(() => {
      savedScale.value = scale.value;
      runOnJS(remeasureLine)();
    });
  const floorGesture = Gesture.Simultaneous(panGesture, pinchGesture);
  const floorAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }, { translateY: translateY.value }, { scale: scale.value }],
  }));

  const { zones, locationsByBay } = useMemo(() => {
    const byLayout = new Map<string, Map<string, Map<string, BayCell>>>();
    const byBay = new Map<string, PalletCell[]>();
    allAudits.forEach((a) => {
      (map[a.audit_id]?.allLocations ?? []).forEach(({ layout, rack, bay, loc }) => {
        if (!byLayout.has(layout)) byLayout.set(layout, new Map());
        const racks = byLayout.get(layout)!;
        if (!racks.has(rack)) racks.set(rack, new Map());
        const bays = racks.get(rack)!;
        if (!bays.has(bay)) bays.set(bay, { layout, rack, bay });
        const bayKey = `${layout}|${rack}|${bay}`;
        if (!byBay.has(bayKey)) byBay.set(bayKey, []);
        byBay.get(bayKey)!.push({ code: loc.code, level: loc.level, slot: loc.slot });
      });
    });

    const RACKS_PER_ZONE = 12;
    const BAYS_PER_RACK = 4;
    const zoneNames = [...Array.from(byLayout.keys()), 'Layout D', 'Layout E'];
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

    return {
      zones: Array.from(byLayout.entries())
        .map(([layout, racks]) => ({
          layout,
          racks: Array.from(racks.entries())
            .map(([rack, bays]) => ({ rack, bays: Array.from(bays.values()).sort((a, b) => a.bay.localeCompare(b.bay)) }))
            .sort((a, b) => a.rack.localeCompare(b.rack)),
        }))
        .sort((a, b) => a.layout.localeCompare(b.layout)),
      locationsByBay: byBay,
    };
  }, [allAudits, map]);

  const layoutOptions: SheetOption[] = zones.map((z) => ({ value: z.layout, label: zoneLabel(z.layout) }));
  const rackOptions: SheetOption[] = pinLayout
    ? (zones.find((z) => z.layout === pinLayout)?.racks ?? []).map((r) => ({ value: r.rack, label: `Rack ${r.rack}` }))
    : [];
  const bayOptions: SheetOption[] = pinLayout && pinRack
    ? (zones.find((z) => z.layout === pinLayout)?.racks.find((r) => r.rack === pinRack)?.bays ?? []).map((b) => ({ value: b.bay, label: `Bay ${b.bay}` }))
    : [];
  const locOptions: SheetOption[] = pinLayout && pinRack && pinBay
    ? (locationsByBay.get(`${pinLayout}|${pinRack}|${pinBay}`) ?? []).map((l) => ({ value: l.code, label: palletLabel(l) }))
    : [];
  console.log(
    '[PINDEBUG]',
    'allAudits=', allAudits.length,
    'zones=', zones.length,
    'layout=', pinLayout, 'rackOptions=', rackOptions.length,
    'rack=', pinRack, 'bayOptions=', bayOptions.length,
    'bay=', pinBay, 'locOptions=', locOptions.length,
    'byBayKeys=', Array.from(locationsByBay.keys()),
  );
  const selectedLocOption = pinLoc ? (locOptions.find((o) => o.value === pinLoc) ?? null) : null;

  // Measures the on-screen center of the expected-zone anchor and the
  // currently-pinned anchor (whichever's live right now — zone or rack),
  // relative to the stage's own origin, so the dashed Svg line — drawn as a
  // sibling of the pan/zoom-transformed canvas, in the stage's fixed
  // coordinate space — lines up with what's actually on screen at any zoom
  // level. No line when nothing's pinned yet, or the pin already lands on
  // the expected zone (same anchor both ends).
  const expectedKey = target?.expectedZone ? zoneAnchorKey(target.expectedZone) : null;
  const currentPinKey = pinRack && pinLayout ? rackAnchorKey(pinLayout, pinRack) : pinLayout ? zoneAnchorKey(pinLayout) : null;
  function remeasureLine() {
    const expectedEl = expectedKey ? anchorRefs.current[expectedKey] : null;
    const pinnedEl = currentPinKey ? anchorRefs.current[currentPinKey] : null;
    if (!expectedEl || !pinnedEl || !stageRef.current || expectedKey === currentPinKey) {
      setLinePoints(null);
      return;
    }
    stageRef.current.measure((_sx, _sy, _sw, _sh, stagePageX, stagePageY) => {
      expectedEl.measure((_ex, _ey, ew, eh, ePageX, ePageY) => {
        pinnedEl.measure((_px, _py, pw, ph, pPageX, pPageY) => {
          setLinePoints({
            x1: ePageX - stagePageX + ew / 2,
            y1: ePageY - stagePageY + eh / 2,
            x2: pPageX - stagePageX + pw / 2,
            y2: pPageY - stagePageY + ph / 2,
          });
        });
      });
    });
  }
  useEffect(() => {
    const t = setTimeout(remeasureLine, 60);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pinLayout, pinRack, pinBay, expectedKey, zones]);

  const pickLayout = (layout: string) => {
    setPinFloorAreaId(null);
    setPinLayout(layout);
    setPinRack(null);
    setPinBay(null);
    setPinLoc(null);
    setPinAisle(false);
    setOpenField(null);
  };
  const pickRack = (rack: string) => {
    setPinRack(rack);
    setPinBay(null);
    setPinLoc(null);
    setPinAisle(false);
    setOpenField(null);
  };
  const pickBay = (bay: string) => {
    setPinBay(bay);
    setPinLoc(null);
    setOpenField(null);
  };
  const pickLoc = (loc: string) => {
    setPinLoc(loc);
    setOpenField(null);
  };
  // Aisle storage sits next to pinRack, not inside any of its bays — picking
  // it clears whatever bay/pallet was chosen, the same way picking a real
  // bay clears the pallet below it.
  const toggleAisle = () => {
    setPinAisle((v) => !v);
    setPinBay(null);
    setPinLoc(null);
  };
  const pickFloorArea = (id: string) => {
    setPinFloorAreaId(id);
    setPinLayout(null);
    setPinRack(null);
    setPinBay(null);
    setPinLoc(null);
    setPinAisle(false);
    setOpenField(null);
  };

  // Tapping a rack card on the map pins that exact rack (zone + rack, bay
  // left open — a rack find is granular enough without forcing a specific
  // bay); tapping a zone's header pins the open floor within that zone
  // (zone only, no rack) — the floor-find case. Neither sets a pallet — the
  // map doesn't render that grain, so a specific pallet only ever comes
  // from the dropdown.
  const pinToRack = (layout: string, rack: string) => {
    setPinFloorAreaId(null);
    setPinLayout(layout);
    setPinRack(rack);
    setPinBay(null);
    setPinLoc(null);
    setPinAisle(false);
  };
  const pinToZoneFloor = (layout: string) => {
    setPinFloorAreaId(null);
    setPinLayout(layout);
    setPinRack(null);
    setPinBay(null);
    setPinLoc(null);
    setPinAisle(false);
  };

  const horizontalZones = zones.filter((_, i) => i % 2 === 0);
  const verticalZones = zones.filter((_, i) => i % 2 === 1);

  const handleConfirm = () => {
    if (!target) return;
    if (pinFloorAreaId) {
      const area = FLOOR_AREAS.find((a) => a.id === pinFloorAreaId);
      if (!area) return;
      submitResult({ itemId: target.itemId, zone: area.label, floorAreaId: area.id });
      router.back();
      return;
    }
    if (!pinLayout) return;
    submitResult({
      itemId: target.itemId,
      zone: pinLayout,
      rack: pinRack ?? undefined,
      bay: pinAisle ? undefined : (pinBay ?? undefined),
      loc: pinAisle ? undefined : (pinLoc ?? undefined),
      aisle: pinAisle && !!pinRack ? true : undefined,
    });
    router.back();
  };

  const renderZone = (zone: ZoneGroup, vertical: boolean) => {
    const scannedCount = target?.scannedZoneCounts[zone.layout] ?? 0;
    const zonePinned = pinLayout === zone.layout && !pinRack;
    const isExpectedZone = target?.expectedZone === zone.layout;
    return (
      <View key={zone.layout} style={styles.zone}>
        <Pressable
          ref={(el) => {
            anchorRefs.current[zoneAnchorKey(zone.layout)] = el;
          }}
          onPress={() => pinToZoneFloor(zone.layout)}
          style={styles.zoneHeadRow}
        >
          <Ionicons name={vertical ? 'swap-vertical-outline' : 'swap-horizontal-outline'} size={12} color={tokens.mutedForeground} />
          <Text
            style={{
              color: zonePinned ? tokens.accentBlue.strong : tokens.mutedForeground,
              fontWeight: tokens.fontWeight.bold,
              fontSize: tokens.text.xxs,
              textTransform: 'uppercase',
              letterSpacing: 0.4,
            }}
          >
            {zoneLabel(zone.layout)}
          </Text>
          {scannedCount ? (
            <View style={[styles.scanCountBadge, { backgroundColor: tokens.rag.green.soft }]}>
              <Ionicons name="scan-outline" size={9} color={tokens.rag.green.strong} />
              <Text style={{ color: tokens.rag.green.strong, fontSize: 8, fontWeight: tokens.fontWeight.bold }}>{scannedCount}</Text>
            </View>
          ) : null}
          {/* The SKU's expected zone — always visible, not only once
              pinned, so the inspector can see up front where the WMS
              thinks it should be. */}
          {isExpectedZone ? <View style={[styles.expectedDot, { backgroundColor: tokens.rag.red.strong, borderColor: tokens.card }]} /> : null}
          {zonePinned ? <Ionicons name="location" size={12} color={tokens.accentBlue.strong} /> : null}
        </Pressable>
        <View style={[styles.zoneAisle, vertical ? styles.zoneAisleVertical : null]}>
          {zone.racks.map((rackGroup) => {
            const isPinned = pinLayout === zone.layout && pinRack === rackGroup.rack;
            const rackBorder = isPinned ? tokens.accentBlue.base : PIN_WIRE;
            const bayCount = rackGroup.bays.length;
            return (
              <Pressable
                key={rackGroup.rack}
                ref={(el) => {
                  anchorRefs.current[rackAnchorKey(zone.layout, rackGroup.rack)] = el;
                }}
                onPress={() => pinToRack(zone.layout, rackGroup.rack)}
                hitSlop={4}
                style={[styles.rackCard, { borderColor: rackBorder, backgroundColor: isPinned ? tokens.accentBlue.soft : tokens.card, borderWidth: isPinned ? 2.5 : 1.5 }]}
              >
                {isPinned ? (
                  <View style={styles.pinBadge}>
                    <Ionicons name="location" size={16} color={tokens.accentBlue.base} />
                  </View>
                ) : null}
                <Text numberOfLines={1} style={{ color: isPinned ? tokens.accentBlue.strong : tokens.slate400, fontWeight: tokens.fontWeight.medium, fontSize: 9 }}>
                  Rack {rackGroup.rack}
                </Text>
                <View style={styles.bayRow}>
                  {rackGroup.bays.map((bayCell) => (
                    <View key={bayCell.bay} style={[styles.baySeg, { backgroundColor: 'transparent', borderColor: isPinned ? tokens.accentBlue.border : PIN_WIRE }]} />
                  ))}
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
  };

  if (!target) return null;

  return (
    <View style={{ flex: 1, backgroundColor: tokens.muted }}>
      <AppHeader title="Pin Exact Location" sub={target.skuLabel} showBack />

      {/* Same toolbar-chip + inline-dropdown pattern as Rack View's canvas
          toolbar (Layout/Rack/Bay), not a bottom sheet — both are just two
          ways of setting the same pin, kept visually consistent with the
          audit page's own dropdown UI. */}
      <View style={[styles.toolbar, { backgroundColor: tokens.card, borderBottomColor: tokens.border }]}>
        <View>
          <ToolbarField label={pinLayout ? zoneLabel(pinLayout) : 'Select Layout'} open={openField === 'layout'} onPress={() => setOpenField(openField === 'layout' ? null : 'layout')} />
          {openField === 'layout' ? (
            <>
              <Pressable style={StyleSheet.absoluteFill} onPress={() => setOpenField(null)} />
              <InlineDropdown options={layoutOptions} selectedValue={pinLayout ?? ''} onSelect={pickLayout} />
            </>
          ) : null}
        </View>
        <View>
          <ToolbarField label={pinRack ? `Rack ${pinRack}` : 'Any Rack'} open={openField === 'rack'} onPress={() => pinLayout && setOpenField(openField === 'rack' ? null : 'rack')} />
          {openField === 'rack' ? (
            <>
              <Pressable style={StyleSheet.absoluteFill} onPress={() => setOpenField(null)} />
              <InlineDropdown options={rackOptions} selectedValue={pinRack ?? ''} onSelect={pickRack} />
            </>
          ) : null}
        </View>
        {!pinAisle ? (
          <View>
            <ToolbarField label={pinBay ? `Bay ${pinBay}` : 'Any Bay'} open={openField === 'bay'} onPress={() => pinRack && setOpenField(openField === 'bay' ? null : 'bay')} />
            {openField === 'bay' ? (
              <>
                <Pressable style={StyleSheet.absoluteFill} onPress={() => setOpenField(null)} />
                <InlineDropdown options={bayOptions} selectedValue={pinBay ?? ''} onSelect={pickBay} />
              </>
            ) : null}
          </View>
        ) : null}
        {/* Aisle storage — the pallet sits in the walkway next to this
            rack, not inside any of its bays, so checking it swaps out the
            Bay/Pallet fields entirely rather than leaving them dangling
            with nothing meaningful to select. A plain checkbox (no chip
            border/background) sitting right of the Bay dropdown, not a
            separate bordered button competing with the toolbar's own
            dropdown chips. */}
        {pinRack ? (
          <Pressable onPress={toggleAisle} hitSlop={6} style={styles.aisleCheckbox}>
            <Ionicons name={pinAisle ? 'checkbox' : 'square-outline'} size={16} color={pinAisle ? tokens.accentBlue.strong : tokens.mutedForeground} />
            <Text style={{ color: pinAisle ? tokens.accentBlue.strong : tokens.foreground, fontSize: tokens.text.xs, fontWeight: tokens.fontWeight.semibold }}>Aisle</Text>
          </Pressable>
        ) : null}
        {!pinAisle ? (
          <View>
            <ToolbarField label={selectedLocOption ? selectedLocOption.label : 'Any Pallet'} open={openField === 'loc'} onPress={() => pinBay && setOpenField(openField === 'loc' ? null : 'loc')} />
            {openField === 'loc' ? (
              <>
                <Pressable style={StyleSheet.absoluteFill} onPress={() => setOpenField(null)} />
                <InlineDropdown options={locOptions} selectedValue={pinLoc ?? ''} onSelect={pickLoc} />
              </>
            ) : null}
          </View>
        ) : null}
        <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xxs, marginLeft: 'auto', flexShrink: 1 }} numberOfLines={2}>
          Or tap the map directly
        </Text>
      </View>

      {/* Plain-language explanation of what checking Aisle actually means —
          only shown once it's actually checked, not just because the
          checkbox is on screen (that would read as explaining a choice
          the inspector hasn't made yet). */}
      {pinAisle ? (
        <View style={[styles.aisleHintRow, { backgroundColor: tokens.muted, borderBottomColor: tokens.border }]}>
          <Ionicons name="information-circle-outline" size={13} color={tokens.mutedForeground} />
          <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xxs, flex: 1 }}>
            Aisle means the pallet is sitting in the walkway beside Rack {pinRack}, not inside one of its bays.
          </Text>
        </View>
      ) : null}

      <View style={styles.mapWrap}>
        <Card style={{ padding: 0, overflow: 'hidden', flex: 1, borderColor: tokens.border }}>
          <View style={[styles.canvasToolbarRow, { backgroundColor: '#F7F8FA', borderBottomColor: tokens.border }]}>
            <Ionicons name="location-outline" size={13} color={tokens.mutedForeground} />
            <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xxs }}>Tap a zone name for open floor, a rack for an exact shelf, or a floor area</Text>
            {target.expectedZone ? (
              <View style={styles.legendItem}>
                <View style={[styles.expectedDot, { backgroundColor: tokens.rag.red.strong, borderColor: '#F7F8FA' }]} />
                <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xxs }}>Expected</Text>
              </View>
            ) : null}
          </View>
          <View style={styles.stage} ref={stageRef}>
            <GestureDetector gesture={floorGesture}>
              <View style={styles.stageCenter}>
                <Animated.View style={floorAnimatedStyle}>
                  <View style={styles.planCanvas}>
                    <View style={styles.zoneGroupCol}>
                      {horizontalZones.map((zone) => renderZone(zone, false))}
                      {/* Standalone open-floor areas — genuinely no Layout/
                          Rack/Bay under them, unlike the zones above (still
                          real Layouts). Picking one is the whole pin —
                          there's no further grain to narrow down to, same
                          as tapping anywhere in a drawn floor area on a
                          real map would be. Inside the same pannable
                          canvas as the rest of the floor plan, not a
                          separate toolbar row above it. */}
                      <View style={styles.zone}>
                        <View style={styles.zoneHeadRow}>
                          <Ionicons name="ellipse-outline" size={12} color={tokens.mutedForeground} />
                          <Text
                            style={{
                              color: tokens.mutedForeground,
                              fontWeight: tokens.fontWeight.bold,
                              fontSize: tokens.text.xxs,
                              textTransform: 'uppercase',
                              letterSpacing: 0.4,
                            }}
                          >
                            Floor Areas
                          </Text>
                        </View>
                        <View style={styles.zoneAisle}>
                          {FLOOR_AREAS.map((area) => {
                            const active = pinFloorAreaId === area.id;
                            return (
                              <Pressable
                                key={area.id}
                                onPress={() => pickFloorArea(area.id)}
                                hitSlop={4}
                                style={[styles.floorAreaCard, { borderColor: active ? tokens.accentBlue.base : PIN_WIRE, backgroundColor: active ? tokens.accentBlue.soft : tokens.card }]}
                              >
                                {active ? <Ionicons name="location" size={12} color={tokens.accentBlue.strong} /> : null}
                                <Text
                                  numberOfLines={2}
                                  style={{ color: active ? tokens.accentBlue.strong : tokens.slate400, fontWeight: tokens.fontWeight.medium, fontSize: 9, textAlign: 'center' }}
                                >
                                  {area.label}
                                </Text>
                              </Pressable>
                            );
                          })}
                        </View>
                      </View>
                    </View>
                    <View style={styles.zoneGroupRow}>{verticalZones.map((zone) => renderZone(zone, true))}</View>
                  </View>
                </Animated.View>
              </View>
            </GestureDetector>
            {/* Drawn as a fixed-space sibling of the transformed canvas, not
                inside it — the anchor points are measured live on screen
                (already reflecting the current pan/zoom), so the overlay
                itself must stay in that same untransformed stage space. */}
            {linePoints ? (
              <Svg style={StyleSheet.absoluteFill} pointerEvents="none">
                <Line x1={linePoints.x1} y1={linePoints.y1} x2={linePoints.x2} y2={linePoints.y2} stroke={tokens.rag.amber.strong} strokeWidth={2} strokeDasharray="6,5" />
                <Circle cx={linePoints.x1} cy={linePoints.y1} r={5} fill={tokens.rag.red.strong} stroke="#fff" strokeWidth={1.5} />
                <Circle cx={linePoints.x2} cy={linePoints.y2} r={5} fill={tokens.accentBlue.strong} stroke="#fff" strokeWidth={1.5} />
              </Svg>
            ) : null}
          </View>
        </Card>
      </View>

      <View style={[styles.footerBar, { backgroundColor: tokens.card, borderTopColor: tokens.border }]}>
        <View style={{ flex: 1 }}>
          <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xxs }}>Pinned Location</Text>
          <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm }} numberOfLines={1}>
            {pinFloorAreaId
              ? FLOOR_AREAS.find((a) => a.id === pinFloorAreaId)?.label
              : pinLayout
                ? [
                    zoneLabel(pinLayout),
                    pinRack ? `Rack ${pinRack}` : null,
                    pinAisle ? 'Aisle' : pinBay ? `Bay ${pinBay}` : null,
                    !pinAisle && selectedLocOption ? selectedLocOption.label : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')
                : 'Nothing pinned yet'}
          </Text>
        </View>
        <Pressable
          disabled={!pinLayout && !pinFloorAreaId}
          onPress={handleConfirm}
          style={[styles.confirmBtn, { backgroundColor: pinLayout || pinFloorAreaId ? tokens.primary : tokens.muted, borderRadius: tokens.radius.xxl }]}
        >
          <Text style={{ color: pinLayout || pinFloorAreaId ? tokens.primaryForeground : tokens.mutedForeground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm }}>
            Confirm Pin
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  toolbar: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', rowGap: 8, columnGap: 8, paddingHorizontal: 12, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  aisleCheckbox: { flexDirection: 'row', alignItems: 'center', gap: 6, height: 36, paddingHorizontal: 4 },
  aisleHintRow: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth },
  floorAreaCard: { width: 66, minHeight: 44, borderWidth: 1.5, borderStyle: 'dashed', borderRadius: 5, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4, gap: 2 },
  mapWrap: { flex: 1, padding: 16 },
  canvasToolbarRow: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, paddingVertical: 10, borderBottomWidth: 1 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 4, marginLeft: 'auto' },
  expectedDot: { width: 7, height: 7, borderRadius: 4, borderWidth: 1 },
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
  pinBadge: { position: 'absolute', top: -14, alignSelf: 'center' },
  scanCountBadge: { flexDirection: 'row', alignItems: 'center', gap: 2, paddingHorizontal: 4, paddingVertical: 1, borderRadius: 6 },
  footerBar: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 16, borderTopWidth: StyleSheet.hairlineWidth },
  confirmBtn: { height: 48, paddingHorizontal: 22, alignItems: 'center', justifyContent: 'center' },
});
