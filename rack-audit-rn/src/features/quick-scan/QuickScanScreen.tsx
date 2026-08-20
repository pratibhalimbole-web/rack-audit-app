import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { cancelAnimation, runOnJS, useAnimatedStyle, useSharedValue, withRepeat, withSequence, withTiming } from 'react-native-reanimated';
import { AppHeader } from '@/components/AppHeader';
import { BarcodeScannerModal } from '@/components/BarcodeScannerModal';
import { Card } from '@/components/Card';
import { EvidenceBlock } from '@/components/EvidenceBlock';
import { NewAttachmentModal } from '@/components/NewAttachmentModal';
import type { SheetOption } from '@/components/BottomSheetPicker';
import { InlineDropdown, ToolbarField } from '@/components/ToolbarDropdownField';
import { useAuditProgressMap } from '@/hooks/useLocationsTree';
import { expectedZoneForSku, fillBayLevels, FLOOR_AREAS, generateWaveformBars, INVENTORY_POOL, SKU_ZONE_EXPECTATIONS } from '@/lib/mockData';
import { useQuickScanPinStore } from '@/store/useQuickScanPinStore';
import { CONDITIONS, type Condition, type Evidence, type LocationNode, type SkuScanCode } from '@/lib/types';
import { useTheme } from '@/theme/ThemeProvider';
import { useAudits } from '../dashboard/hooks';
import { buildBayDiagram } from '../rack-view/buildBayDiagram';

// A rack-holding zone's real name IS "Layout X" — no longer relabeled to
// "Zone X" for display, since "Zone" is now reserved for the separate,
// rack-less floor-area concept (see FLOOR_AREAS) so the two don't get
// confused for one another.
function zoneLabel(zone: string): string {
  return zone;
}

// A real scan is timestamped the moment the device's camera fires it —
// same as any handheld scanner or POS terminal — so this is just the
// device clock at scan time, not a simulated value.
function formatScanTime(ts: number): string {
  const d = new Date(ts);
  return `${d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })} · ${d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}`;
}

type BayCell = { layout: string; rack: string; bay: string };
type RackGroup = { rack: string; bays: BayCell[] };
type LayoutGroup = { layout: string; racks: RackGroup[] };
type PalletCell = { code: string; level?: number; slot?: number };

// Same pallet-ID convention Pin Exact Location's palletLabel uses — level +
// slot on that level, e.g. level 5 / slot 1 -> "P-0501".
function palletLabel(loc: PalletCell): string {
  return loc.level != null && loc.slot != null ? `P-${String(loc.level).padStart(2, '0')}${String(loc.slot).padStart(2, '0')}` : loc.code;
}

// Same selected-pallet blink as Rack View's own RackCell
// (src/features/rack-view/RackViewScreen.tsx) — a light blue fill with a
// dark blue pulsing border, so picking a pallet in Front View here feels
// identical to picking one there.
function FrontViewCell({ selected, bg, border, onPress }: { selected: boolean; bg: string; border: string; onPress: () => void }) {
  const opacity = useSharedValue(1);
  useEffect(() => {
    if (selected) {
      opacity.value = withRepeat(withSequence(withTiming(0.35, { duration: 350 }), withTiming(1, { duration: 350 })), -1, true);
    } else {
      cancelAnimation(opacity);
      opacity.value = withTiming(1, { duration: 150 });
    }
  }, [selected]);
  const animatedStyle = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return (
    <Pressable onPress={onPress}>
      <Animated.View
        style={[
          { width: 38, height: 26, borderRadius: 4, backgroundColor: bg, borderColor: border, borderWidth: selected ? 2 : 1 },
          animatedStyle,
        ]}
      />
    </Pressable>
  );
}

// Which of the three ways this SKU's location was captured — drives the
// card's "Zone Find"/"Rack Find"/"Floor Find" label, which section it
// lands in on the Scanned SKUs list, and (for Zone/Rack) whether the
// location was already resolved at scan time vs. still needing a
// Floor-mode pin afterward.
type Origin = 'zone' | 'rack' | 'floor';

type ScannedSku = {
  id: string;
  sku: string;
  name: string;
  origin: Origin;
  expectedZone: string | null;
  matched: boolean | null; // null until resolved — either awaiting a Floor pin, or resolved with no WMS expectation on record
  pinnedZone?: string;
  pinnedRack?: string;
  pinnedBay?: string;
  pinnedLoc?: string;
  pinnedAisle?: boolean;
  pinnedFloorAreaId?: string;
  issueRaised?: boolean;
  scannedAt: number; // device clock at the moment the camera scan fired
  pinnedAt?: number; // device clock at the moment the location was resolved
  // Reconciliation Form fields — same structure as Rack View's and Zone
  // Scan's own Reconciliation Form (Pallet Condition gate, per-field
  // Raise Issue, per-field Evidence), filled in on the overlay panel that
  // opens the moment a scan resolves.
  qty: number;
  condition: Condition;
  palletConditionGood?: boolean | null;
  qtyIssueRaised?: boolean;
  conditionIssueRaised?: boolean;
  qtyEvidence?: Evidence;
  conditionEvidence?: Evidence;
};

// A QR found in a rack encodes JSON {sku,...}; a Zone/Rack-mode scan (where
// the location is already picked on the canvas before scanning) just needs
// the SKU itself, and may reuse the same "<sku>::<label>" pallet-label
// format Zone Scan uses. This one parser handles all three shapes so every
// mode's scanner feeds through the same code path.
function parseScanCode(data: string): Partial<SkuScanCode> | null {
  const raw = data.trim();
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.sku) return parsed as Partial<SkuScanCode>;
  } catch {
    // not JSON — fall through
  }
  const sku = raw.includes('::') ? raw.split('::')[0] : raw;
  return sku ? { sku } : null;
}

const MODE_OPTIONS: SheetOption[] = [
  { value: 'zone', label: 'In Zone' },
  { value: 'rack', label: 'In Rack' },
  { value: 'floor', label: 'At Floor' },
];
const MODE_LABEL: Record<Origin, string> = { zone: 'In Zone', rack: 'In Rack', floor: 'At Floor' };

// Quick Scan — an inspector picks where they're scanning (a rack-holding
// zone's open floor, a specific rack, or open floor generally) via the
// tabs below, then scans against a full-page map. In Zone/Rack mode the
// location is already known before the SKU is even scanned, so match/
// mismatch resolves immediately; in Floor mode nothing is pre-picked, so
// each scan still needs its own "Pin Exact Location" afterward. The
// scanned list itself lives on its own full page (list icon, bottom
// right), grouped by which of the three ways each SKU was found — same
// "canvas page ⇄ its own list page" split as Zone Scan
// (src/features/zone-audit/ZoneAuditMapScreen.tsx).
export function QuickScanScreen() {
  const { tokens } = useTheme();
  const [items, setItems] = useState<ScannedSku[]>([]);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const idRef = useRef(0);
  const skuCycleRef = useRef(0);
  const nextId = () => `s${idRef.current++}`;
  const openPin = useQuickScanPinStore((s) => s.openPin);
  const pinResult = useQuickScanPinStore((s) => s.result);
  const clearPin = useQuickScanPinStore((s) => s.clear);

  const [mode, setMode] = useState<Origin>('zone');
  const [activeFloorAreaId, setActiveFloorAreaId] = useState<string | null>(null);
  const [activeLayout, setActiveLayout] = useState<string | null>(null);
  const [activeRack, setActiveRack] = useState<string | null>(null);
  const [activeBay, setActiveBay] = useState<string | null>(null);
  const [activeLoc, setActiveLoc] = useState<string | null>(null);
  // One dropdown open at a time — the Mode picker itself, or (depending on
  // mode) the Zone picker, or one of the Rack-mode Layout/Rack/Bay/Pallet
  // pickers, same "toolbar chip + inline dropdown" pattern as Pin Exact
  // Location's own toolbar (src/features/quick-scan/PinLocationScreen.tsx).
  const [openField, setOpenField] = useState<'mode' | 'zone' | 'layout' | 'rack' | 'bay' | 'loc' | null>(null);

  // The Reconciliation Form opens as a right-side overlay the moment a
  // scan resolves — same split canvas/form layout Rack View and Zone Scan
  // both use — rather than a scan going straight onto the list unreviewed.
  const [pendingItem, setPendingItem] = useState<ScannedSku | null>(null);
  const [qtyText, setQtyText] = useState('1');
  const [attachmentTarget, setAttachmentTarget] = useState<'qty' | 'condition' | null>(null);

  const ensureFieldEvidence = (field: 'qtyEvidence' | 'conditionEvidence'): Evidence =>
    pendingItem?.[field] ?? { note: '', noteOpen: false, audio: null, images: [], videos: [] };
  const updateFieldEvidence = (field: 'qtyEvidence' | 'conditionEvidence', patch: Partial<Evidence>) => {
    setPendingItem((prev) => (prev ? { ...prev, [field]: { ...ensureFieldEvidence(field), ...patch } } : prev));
  };
  const raiseFieldIssue = (field: 'qtyIssueRaised' | 'conditionIssueRaised') => {
    setPendingItem((prev) => (prev ? { ...prev, [field]: true } : prev));
  };

  const { data: allAudits = [] } = useAudits();
  const { map } = useAuditProgressMap(allAudits.map((a) => a.audit_id));

  // Same Layout/Rack padding as Pin Exact Location's own canvas
  // (src/features/quick-scan/PinLocationScreen.tsx) — every real audit
  // location plus enough placeholder racks/bays that the reference canvas
  // reads as a real warehouse, not a sparse test fixture.
  const { layoutZones, locationsByBay } = useMemo(() => {
    const byLayout = new Map<string, Map<string, Map<string, BayCell>>>();
    const byBay = new Map<string, LocationNode[]>();
    allAudits.forEach((a) => {
      (map[a.audit_id]?.allLocations ?? []).forEach(({ layout, rack, bay, loc }) => {
        if (!byLayout.has(layout)) byLayout.set(layout, new Map());
        const racks = byLayout.get(layout)!;
        if (!racks.has(rack)) racks.set(rack, new Map());
        const bays = racks.get(rack)!;
        if (!bays.has(bay)) bays.set(bay, { layout, rack, bay });
        const bayKey = `${layout}|${rack}|${bay}`;
        if (!byBay.has(bayKey)) byBay.set(bayKey, []);
        byBay.get(bayKey)!.push(loc);
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
    // Every bay gets a real, tappable pallet set — a bay with no actual
    // audit data (most of the padding racks above) would otherwise render
    // as an all-empty Front View with nothing selectable, same
    // "every bay gets padded to a real multi-level rack" fill Rack View's
    // own mock data uses (source: fillBayLevels in @/lib/mockData).
    byLayout.forEach((racks, layout) => {
      racks.forEach((bays, rack) => {
        bays.forEach((_, bay) => {
          const bayKey = `${layout}|${rack}|${bay}`;
          const existing = byBay.get(bayKey) ?? [];
          if (existing.length < 1) byBay.set(bayKey, fillBayLevels(bay, existing));
        });
      });
    });
    return {
      layoutZones: Array.from(byLayout.entries())
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

  const rackOptions: SheetOption[] = activeLayout
    ? (layoutZones.find((z) => z.layout === activeLayout)?.racks ?? []).map((r) => ({ value: r.rack, label: `Rack ${r.rack}` }))
    : [];
  const bayOptions: SheetOption[] = activeLayout && activeRack
    ? (layoutZones.find((z) => z.layout === activeLayout)?.racks.find((r) => r.rack === activeRack)?.bays ?? []).map((b) => ({ value: b.bay, label: `Bay ${b.bay}` }))
    : [];
  const locOptions: SheetOption[] = activeLayout && activeRack && activeBay
    ? (locationsByBay.get(`${activeLayout}|${activeRack}|${activeBay}`) ?? []).map((l) => ({ value: l.code, label: palletLabel(l) }))
    : [];
  const zoneOptions: SheetOption[] = FLOOR_AREAS.map((z) => ({ value: z.id, label: z.label }));

  // "Front View" — same buildBayDiagram grouping Rack View's own canvas
  // uses (src/features/rack-view/RackViewScreen.tsx), just fed from every
  // audit's locations instead of one. Only computed once a specific rack
  // is picked — before that the canvas is still the rack-card picker.
  const activeRackBays = activeLayout && activeRack ? (layoutZones.find((z) => z.layout === activeLayout)?.racks.find((r) => r.rack === activeRack)?.bays ?? []) : [];
  const bayDiagrams = activeRackBays.map((b) => ({
    bay: b.bay,
    rows: buildBayDiagram({ code: b.bay, locations: locationsByBay.get(`${activeLayout}|${activeRack}|${b.bay}`) ?? [] }),
  }));

  // One shared pinch-zoom transform — only one canvas is ever on screen at
  // a time (the current tab's), so there's no need for a separate scale/
  // pan state per mode.
  const scale = useSharedValue(0.8);
  const savedScale = useSharedValue(0.8);
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
  // Floor mode's pin step happens inline on this same canvas now, right
  // next to the Reconciliation Form overlay, instead of navigating to Pin
  // Exact Location's separate full page — a scan is "armed" for pinning
  // for as long as it's the pending item and still unresolved.
  const floorPinActive = mode === 'floor' && !!pendingItem && pendingItem.origin === 'floor' && !pendingItem.pinnedAt;
  const [floorTapPoint, setFloorTapPoint] = useState<{ x: number; y: number } | null>(null);

  const pinFloorToZoneArea = (zoneId: string) => {
    const area = FLOOR_AREAS.find((z) => z.id === zoneId);
    if (!area) return;
    setFloorTapPoint(null);
    setPendingItem((prev) => {
      if (!prev) return prev;
      const matched = prev.expectedZone ? prev.expectedZone === area.label : null;
      return { ...prev, pinnedZone: area.label, pinnedFloorAreaId: area.id, pinnedRack: undefined, pinnedBay: undefined, pinnedLoc: undefined, pinnedAisle: undefined, matched, issueRaised: matched === false, pinnedAt: Date.now() };
    });
  };
  const pinFloorToLayoutFloor = (layout: string) => {
    setFloorTapPoint(null);
    setPendingItem((prev) => {
      if (!prev) return prev;
      const matched = prev.expectedZone ? prev.expectedZone === layout : null;
      return { ...prev, pinnedZone: layout, pinnedFloorAreaId: undefined, pinnedRack: undefined, pinnedBay: undefined, pinnedLoc: undefined, pinnedAisle: undefined, matched, issueRaised: matched === false, pinnedAt: Date.now() };
    });
  };
  const pinFloorToRack = (layout: string, rack: string) => {
    setFloorTapPoint(null);
    setPendingItem((prev) => {
      if (!prev) return prev;
      const matched = prev.expectedZone ? prev.expectedZone === layout : null;
      return { ...prev, pinnedZone: layout, pinnedRack: rack, pinnedFloorAreaId: undefined, pinnedBay: undefined, pinnedLoc: undefined, pinnedAisle: undefined, matched, issueRaised: matched === false, pinnedAt: Date.now() };
    });
  };
  // Tapping the open floor itself — not a specific zone, rack, or floor
  // area — same Google Maps "drop a pin exactly where you tapped" as Pin
  // Exact Location's own freeform tap.
  const pinFloorFreeform = (x: number, y: number) => {
    setFloorTapPoint({ x, y });
    setPendingItem((prev) =>
      prev ? { ...prev, pinnedZone: 'Open Floor', pinnedFloorAreaId: undefined, pinnedRack: undefined, pinnedBay: undefined, pinnedLoc: undefined, pinnedAisle: undefined, matched: null, issueRaised: false, pinnedAt: Date.now() } : prev,
    );
  };
  const floorTapGesture = Gesture.Tap()
    .enabled(floorPinActive)
    .onEnd((e) => {
      const contentX = (e.x - translateX.value) / scale.value;
      const contentY = (e.y - translateY.value) / scale.value;
      runOnJS(pinFloorFreeform)(contentX, contentY);
    });

  const canvasGesture = Gesture.Simultaneous(panGesture, pinchGesture, floorTapGesture);
  const canvasAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }, { translateY: translateY.value }, { scale: scale.value }],
  }));

  const pickZone = (id: string) => {
    setActiveFloorAreaId(id);
    setOpenField(null);
  };
  const pickLayout = (layout: string) => {
    setActiveLayout(layout);
    setActiveRack(null);
    setActiveBay(null);
    setActiveLoc(null);
    setOpenField(null);
  };
  const pickRack = (layout: string, rack: string) => {
    setActiveLayout(layout);
    setActiveRack(rack);
    setActiveBay(null);
    setActiveLoc(null);
    setOpenField(null);
  };
  const pickBay = (bay: string) => {
    setActiveBay(bay);
    setActiveLoc(null);
    setOpenField(null);
  };
  const pickLoc = (loc: string) => {
    setActiveLoc(loc);
    setOpenField(null);
  };
  const pickMode = (key: string) => {
    setMode(key as Origin);
    setOpenField(null);
  };

  const activeZoneObj = activeFloorAreaId ? FLOOR_AREAS.find((z) => z.id === activeFloorAreaId) : null;
  const canScan = !pendingItem && (mode === 'floor' || (mode === 'zone' && !!activeZoneObj) || (mode === 'rack' && !!activeRack));

  const applySkuCode = (code: Partial<SkuScanCode>) => {
    setScannerOpen(false);
    if (!code.sku) return;
    const inv = INVENTORY_POOL.find((p) => p.sku === code.sku);
    const draft = { qty: 1, condition: 'Good' as Condition, palletConditionGood: null };
    setQtyText('1');

    if (mode === 'zone' && activeZoneObj) {
      const expectedZone = expectedZoneForSku(code.sku);
      const matched = expectedZone ? expectedZone === activeZoneObj.label : null;
      setPendingItem({
        id: nextId(),
        sku: code.sku!,
        name: inv?.name ?? code.sku!,
        origin: 'zone',
        expectedZone,
        matched,
        pinnedZone: activeZoneObj.label,
        pinnedFloorAreaId: activeZoneObj.id,
        issueRaised: matched === false,
        scannedAt: Date.now(),
        pinnedAt: Date.now(),
        ...draft,
      });
      return;
    }

    if (mode === 'rack' && activeLayout && activeRack) {
      const expectation = SKU_ZONE_EXPECTATIONS.find((e) => e.sku === code.sku);
      const expectedZone = expectation?.expectedZone ?? null;
      const matched = expectedZone ? expectedZone === activeLayout : null;
      setPendingItem({
        id: nextId(),
        sku: code.sku!,
        name: expectation?.name ?? inv?.name ?? code.sku!,
        origin: 'rack',
        expectedZone,
        matched,
        pinnedZone: activeLayout,
        pinnedRack: activeRack,
        pinnedBay: activeBay ?? undefined,
        pinnedLoc: activeLoc ?? undefined,
        issueRaised: matched === false,
        scannedAt: Date.now(),
        pinnedAt: Date.now(),
        ...draft,
      });
      return;
    }

    // Floor mode (or Zone/Rack scanned before a location was picked,
    // which canScan already prevents) — unresolved until pinned, but the
    // Reconciliation Form still opens right away for qty/damage/evidence.
    const expectation = SKU_ZONE_EXPECTATIONS.find((e) => e.sku === code.sku);
    const name = expectation?.name ?? inv?.name ?? code.sku!;
    setPendingItem({
      id: nextId(),
      sku: code.sku!,
      name,
      origin: 'floor',
      expectedZone: expectation?.expectedZone ?? null,
      matched: null,
      scannedAt: Date.now(),
      ...draft,
    });
  };

  const handleRealScanned = (data: string) => {
    const parsed = parseScanCode(data);
    if (parsed) applySkuCode(parsed);
  };
  const handleSimulated = () => {
    const pool = mode === 'rack' ? SKU_ZONE_EXPECTATIONS : INVENTORY_POOL;
    const pick = pool[skuCycleRef.current % pool.length];
    skuCycleRef.current += 1;
    applySkuCode({ sku: pick.sku });
  };

  const handleSaveAndScanNext = () => {
    if (!pendingItem) return;
    const n = parseInt(qtyText, 10);
    const qty = Number.isNaN(n) ? 1 : Math.max(1, n);
    setItems((prev) => [{ ...pendingItem, qty }, ...prev]);
    setPendingItem(null);
    setQtyText('1');
  };
  const handleCancelPending = () => {
    setPendingItem(null);
    setQtyText('1');
  };

  // "Pin Exact Location" (Floor mode only) opens a full screen (dropdowns +
  // a 3D-style warehouse map), not a popup — the picked location comes
  // back through useQuickScanPinStore rather than a callback, since
  // router.push() has no return-value mechanism of its own.
  const handlePin = (item: ScannedSku) => {
    const scannedZoneCounts: Record<string, number> = {};
    items.forEach((it) => {
      if (it.pinnedZone) scannedZoneCounts[it.pinnedZone] = (scannedZoneCounts[it.pinnedZone] ?? 0) + 1;
    });
    openPin({ itemId: item.id, skuLabel: `${item.sku} · ${item.name}`, expectedZone: item.expectedZone, scannedZoneCounts });
    router.push('/pin-location');
  };

  useEffect(() => {
    if (!pinResult) return;
    setItems((prev) =>
      prev.map((it) => {
        if (it.id !== pinResult.itemId) return it;
        const matched = it.expectedZone ? it.expectedZone === pinResult.zone : null;
        return {
          ...it,
          pinnedZone: pinResult.zone,
          pinnedRack: pinResult.rack,
          pinnedBay: pinResult.bay,
          pinnedLoc: pinResult.loc,
          pinnedAisle: pinResult.aisle,
          pinnedFloorAreaId: pinResult.floorAreaId,
          matched,
          issueRaised: matched === false,
          pinnedAt: Date.now(),
        };
      }),
    );
    clearPin();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pinResult]);

  // A full page, not a modal sheet — same reasoning as Zone Scan's own
  // Scanned Records page: this can genuinely rack up a long history.
  // Grouped by origin (how each SKU was found) rather than one flat list,
  // so a Zone-mode session's finds don't blur together with Floor-mode
  // pins still waiting on their location.
  if (listOpen) {
    const groups: { key: Origin; title: string; icon: keyof typeof Ionicons.glyphMap; rows: ScannedSku[] }[] = [
      { key: 'zone', title: 'Zone Finds', icon: 'apps-outline', rows: items.filter((i) => i.origin === 'zone') },
      { key: 'rack', title: 'Rack Finds', icon: 'grid-outline', rows: items.filter((i) => i.origin === 'rack') },
      { key: 'floor', title: 'Floor Finds', icon: 'cube-outline', rows: items.filter((i) => i.origin === 'floor') },
    ];
    return (
      <View style={{ flex: 1, backgroundColor: tokens.muted }}>
        <AppHeader title="Scanned SKUs" sub={`${items.length} scan${items.length === 1 ? '' : 's'} across all modes`} showBack onBack={() => setListOpen(false)} />
        <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.listPageBody}>
          {items.length ? (
            groups.map((group) =>
              group.rows.length ? (
                <View key={group.key} style={{ gap: 10 }}>
                  <View style={styles.groupHeadRow}>
                    <Ionicons name={group.icon} size={14} color={tokens.mutedForeground} />
                    <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.extrabold, fontSize: tokens.text.base }}>{group.title}</Text>
                    <View style={[styles.countBadge, { backgroundColor: tokens.rag.green.soft, borderRadius: tokens.radius.sm }]}>
                      <Text style={{ color: tokens.rag.green.strong, fontSize: tokens.text.xxs, fontWeight: tokens.fontWeight.bold }}>{group.rows.length}</Text>
                    </View>
                  </View>
                  {group.rows.map((item) => (
                    <ScannedSkuCard key={item.id} item={item} onPin={() => handlePin(item)} />
                  ))}
                </View>
              ) : null,
            )
          ) : (
            <View style={styles.emptyState}>
              <Ionicons name="scan-outline" size={26} color="#667085" />
              <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.sm, textAlign: 'center' }}>Scanned SKUs will appear here.</Text>
            </View>
          )}
        </ScrollView>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: tokens.muted }}>
      <AppHeader title="Quick Scan" sub="Check any SKU against its expected zone" showBack menuItems={[{ label: 'Sync Now', onPress: () => {} }]} />

      {/* Picking where you're scanning FIRST (not after) — Zone/Rack mode
          resolve match/mismatch the instant the SKU is scanned, since the
          location is already known; only Floor mode still needs a
          separate pin afterward. Mode and its sub-dropdown(s) all sit in
          one scrollable row — Mode first, so it's never lost — with the
          Scan/List entry points fixed at the right, outside the scroll. */}
      <View style={[styles.modeRow, { backgroundColor: tokens.card, borderBottomColor: tokens.border }]}>
        <View style={[styles.toolbar, { flex: 1 }]}>
          <Text style={{ color: tokens.mutedForeground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.xxs, textTransform: 'uppercase', letterSpacing: 0.4 }}>Mode</Text>
          <View>
            <ToolbarField label={MODE_LABEL[mode]} open={openField === 'mode'} onPress={() => setOpenField(openField === 'mode' ? null : 'mode')} />
            {openField === 'mode' ? (
              <>
                <Pressable style={StyleSheet.absoluteFill} onPress={() => setOpenField(null)} />
                <InlineDropdown options={MODE_OPTIONS} selectedValue={mode} onSelect={pickMode} />
              </>
            ) : null}
          </View>

          {/* Same toolbar-chip + inline-dropdown pattern as Pin Exact
              Location's Layout/Rack/Bay/Pallet row
              (src/features/quick-scan/PinLocationScreen.tsx), right next
              to Mode instead of a separate row. */}
          {mode === 'zone' ? (
            <View>
              <ToolbarField label={activeZoneObj ? activeZoneObj.label : 'Select Zone'} open={openField === 'zone'} onPress={() => setOpenField(openField === 'zone' ? null : 'zone')} />
              {openField === 'zone' ? (
                <>
                  <Pressable style={StyleSheet.absoluteFill} onPress={() => setOpenField(null)} />
                  <InlineDropdown options={zoneOptions} selectedValue={activeFloorAreaId ?? ''} onSelect={pickZone} />
                </>
              ) : null}
            </View>
          ) : null}

          {mode === 'rack' ? (
            <>
              <View>
                <ToolbarField label={activeLayout ? zoneLabel(activeLayout) : 'Select Layout'} open={openField === 'layout'} onPress={() => setOpenField(openField === 'layout' ? null : 'layout')} />
                {openField === 'layout' ? (
                  <>
                    <Pressable style={StyleSheet.absoluteFill} onPress={() => setOpenField(null)} />
                    <InlineDropdown options={layoutZones.map((z) => ({ value: z.layout, label: zoneLabel(z.layout) }))} selectedValue={activeLayout ?? ''} onSelect={pickLayout} />
                  </>
                ) : null}
              </View>
              <View>
                <ToolbarField label={activeRack ? `Rack ${activeRack}` : 'Any Rack'} open={openField === 'rack'} onPress={() => activeLayout && setOpenField(openField === 'rack' ? null : 'rack')} />
                {openField === 'rack' ? (
                  <>
                    <Pressable style={StyleSheet.absoluteFill} onPress={() => setOpenField(null)} />
                    <InlineDropdown options={rackOptions} selectedValue={activeRack ?? ''} onSelect={(v) => pickRack(activeLayout!, v)} />
                  </>
                ) : null}
              </View>
              <View>
                <ToolbarField label={activeBay ? `Bay ${activeBay}` : 'Any Bay'} open={openField === 'bay'} onPress={() => activeRack && setOpenField(openField === 'bay' ? null : 'bay')} />
                {openField === 'bay' ? (
                  <>
                    <Pressable style={StyleSheet.absoluteFill} onPress={() => setOpenField(null)} />
                    <InlineDropdown options={bayOptions} selectedValue={activeBay ?? ''} onSelect={pickBay} />
                  </>
                ) : null}
              </View>
              <View>
                <ToolbarField
                  label={activeLoc ? (locOptions.find((o) => o.value === activeLoc)?.label ?? activeLoc) : 'Any Pallet'}
                  open={openField === 'loc'}
                  onPress={() => activeBay && setOpenField(openField === 'loc' ? null : 'loc')}
                />
                {openField === 'loc' ? (
                  <>
                    <Pressable style={StyleSheet.absoluteFill} onPress={() => setOpenField(null)} />
                    <InlineDropdown options={locOptions} selectedValue={activeLoc ?? ''} onSelect={pickLoc} />
                  </>
                ) : null}
              </View>
            </>
          ) : null}
        </View>

        {/* Scan and Scanned-SKUs entry points — fixed at the right
            (Mode + a mode's sub-dropdowns comfortably fit one line on a
            tablet-width screen, no scrolling needed). */}
        <View style={{ flexDirection: 'row', gap: 8, marginLeft: 8 }}>
          <Pressable
            disabled={!canScan}
            onPress={() => setScannerOpen(true)}
            style={[styles.cornerIconBtn, { borderColor: tokens.border, borderRadius: 8, opacity: canScan ? 1 : 0.5 }]}
          >
            <Ionicons name="qr-code-outline" size={18} color={tokens.foreground} />
          </Pressable>
          <Pressable onPress={() => setListOpen(true)} hitSlop={8} style={[styles.cornerIconBtn, { borderColor: tokens.border, borderRadius: 8 }]}>
            <View style={{ position: 'relative' }}>
              <Ionicons name="list-outline" size={18} color={tokens.foreground} />
              {items.length ? (
                <View style={[styles.listCountDot, { backgroundColor: tokens.primary }]}>
                  <Text style={{ color: tokens.primaryForeground, fontSize: 9, fontWeight: tokens.fontWeight.bold }}>{items.length}</Text>
                </View>
              ) : null}
            </View>
          </Pressable>
        </View>
      </View>

      {/* Full-page canvas — this is the main thing on screen now, not a
          bounded preview box, so there's real room to pinch/zoom/pan a
          whole warehouse. Splits with the Reconciliation Form overlay the
          moment a scan resolves, same canvas/form split Rack View and
          Zone Scan both use. */}
      <View style={pendingItem ? styles.splitRow : styles.singleRow}>
      <View style={[styles.canvasWrap, { flex: pendingItem ? 1.4 : 1 }]}>
        <Card style={{ flex: 1, padding: 0, overflow: 'hidden', borderColor: tokens.border }}>
          <View style={[styles.canvasToolbarRow, { backgroundColor: floorPinActive ? tokens.rag.amber.soft : '#F7F8FA', borderBottomColor: tokens.border }]}>
            <Ionicons name={floorPinActive ? 'location' : 'location-outline'} size={13} color={floorPinActive ? tokens.rag.amber.strong : tokens.mutedForeground} />
            <Text style={{ color: floorPinActive ? tokens.rag.amber.strong : tokens.mutedForeground, fontWeight: floorPinActive ? tokens.fontWeight.bold : tokens.fontWeight.normal, fontSize: tokens.text.xxs, flex: 1 }}>
              {mode === 'zone'
                ? activeZoneObj
                  ? `Scanning into ${activeZoneObj.label}`
                  : 'Tap a zone to scan into it'
                : mode === 'rack'
                  ? activeRack
                    ? `Front View — ${zoneLabel(activeLayout!)} · Rack ${activeRack}`
                    : 'Tap a rack to open its Front View'
                  : floorPinActive
                    ? 'Pin Exact Location — tap a zone, rack, or the open floor'
                    : pendingItem?.origin === 'floor' && pendingItem.pinnedAt
                      ? `Pinned — ${zoneLabel(pendingItem.pinnedZone ?? 'Open Floor')}${pendingItem.pinnedRack ? ` · Rack ${pendingItem.pinnedRack}` : ''}`
                      : 'Reference only — scan a SKU to pin its location here'}
            </Text>
          </View>

          <View style={styles.stage}>
            <GestureDetector gesture={canvasGesture}>
              <View style={styles.stageCenter}>
                <Animated.View style={canvasAnimatedStyle}>
                  <View style={styles.planCanvas}>
                    {mode === 'rack' && activeRack ? (
                      // Same bay-columns-of-levels layout as Rack View's own
                      // canvas (src/features/rack-view/RackViewScreen.tsx)
                      // once a specific rack is picked — filled slots are
                      // real pallets, dashed ones are buildBayDiagram's own
                      // level padding. Tapping a cell sets the Pallet
                      // dropdown, same two-way sync as the dropdowns above.
                      <View style={styles.bayColumnsRow}>
                        {bayDiagrams.map(({ bay, rows }, bayIndex) => (
                          <View key={bay} style={styles.bayColumnWrap}>
                            {bayIndex > 0 ? <View style={[styles.bayUpright, { backgroundColor: tokens.border }]} /> : null}
                            <View style={styles.bayColumn}>
                              <View style={styles.diagram}>
                                {rows.map((row) => (
                                  <View key={row.level} style={styles.diagramRow}>
                                    {bayIndex === 0 ? <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xs, width: 22 }}>L{row.level}</Text> : null}
                                    <View style={styles.diagramCells}>
                                      {row.cells.map((cell, i) => {
                                        if (!cell) return <View key={i} style={[styles.diagramCellEmpty, { borderColor: tokens.border }]} />;
                                        const selected = cell.code === activeLoc;
                                        return (
                                          <FrontViewCell
                                            key={cell.code}
                                            selected={selected}
                                            bg={selected ? '#BFDBFE' : tokens.muted}
                                            border={selected ? '#1D4ED8' : tokens.border}
                                            onPress={() => pickLoc(cell.code)}
                                          />
                                        );
                                      })}
                                    </View>
                                  </View>
                                ))}
                              </View>
                              <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xs, textAlign: 'center', marginTop: 8 }}>Bay {bay}</Text>
                            </View>
                          </View>
                        ))}
                      </View>
                    ) : mode === 'rack' ? (
                      <View style={styles.layoutGroupRow}>
                        {layoutZones.map((ly) => (
                          <View key={ly.layout} style={styles.layoutBlock}>
                            <Text style={{ color: tokens.mutedForeground, fontWeight: tokens.fontWeight.semibold, fontSize: tokens.text.xxs, marginBottom: 4 }}>{zoneLabel(ly.layout)}</Text>
                            <View style={styles.rackRow}>
                              {ly.racks.map((rackGroup) => {
                                const selected = activeLayout === ly.layout && activeRack === rackGroup.rack;
                                return (
                                  <Pressable
                                    key={rackGroup.rack}
                                    onPress={() => pickRack(ly.layout, rackGroup.rack)}
                                    style={[
                                      styles.rackCard,
                                      { borderColor: selected ? tokens.primary : tokens.border, backgroundColor: selected ? '#BFDBFE' : tokens.card, borderWidth: selected ? 2 : 1 },
                                    ]}
                                  >
                                    <Text numberOfLines={1} style={{ color: selected ? '#1D4ED8' : tokens.slate400, fontWeight: tokens.fontWeight.medium, fontSize: 8 }}>
                                      Rack {rackGroup.rack}
                                    </Text>
                                    <View style={styles.bayRow}>
                                      {rackGroup.bays.map((bayCell) => (
                                        <View key={bayCell.bay} style={[styles.baySeg, { borderColor: selected ? '#1D4ED8' : tokens.border }]} />
                                      ))}
                                    </View>
                                  </Pressable>
                                );
                              })}
                            </View>
                          </View>
                        ))}
                      </View>
                    ) : (
                      <View style={floorPinActive ? [styles.warehouseFloor, { borderColor: tokens.rag.amber.strong }] : undefined}>
                        {floorPinActive ? (
                          <View style={[styles.warehouseFloorLabel, { backgroundColor: tokens.card }]}>
                            <Ionicons name="business-outline" size={11} color={tokens.rag.amber.strong} />
                            <Text style={{ color: tokens.rag.amber.strong, fontWeight: tokens.fontWeight.bold, fontSize: 9, textTransform: 'uppercase', letterSpacing: 0.4 }}>
                              Warehouse Floor
                            </Text>
                          </View>
                        ) : null}
                        <View style={styles.zoneRow}>
                          {FLOOR_AREAS.map((zone) => {
                            const selected = (mode === 'zone' && activeFloorAreaId === zone.id) || (floorPinActive && pendingItem?.pinnedFloorAreaId === zone.id);
                            return (
                              <Pressable
                                key={zone.id}
                                disabled={mode !== 'zone' && !floorPinActive}
                                onPress={() => (mode === 'zone' ? pickZone(zone.id) : pinFloorToZoneArea(zone.id))}
                                style={[
                                  styles.zoneCard,
                                  { borderColor: selected ? '#1D4ED8' : tokens.border, borderWidth: selected ? 2.5 : 1.5, backgroundColor: selected ? '#BFDBFE' : tokens.card },
                                ]}
                              >
                                <Text style={{ color: selected ? '#1D4ED8' : tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm }}>{zone.label}</Text>
                              </Pressable>
                            );
                          })}
                        </View>

                        {/* Racked part of the warehouse, for spatial context
                            only in Zone mode — grayed and non-interactive,
                            same treatment as Zone Audit's own canvas
                            (src/features/zone-audit/ZoneAuditMapScreen.tsx).
                            In Floor-pin mode this same reference becomes a
                            real tap target — a zone header pins the open
                            floor within that Layout, a rack card pins that
                            exact rack — same as Pin Exact Location's canvas
                            (src/features/quick-scan/PinLocationScreen.tsx). */}
                        <View style={[styles.layoutGroupRow, { marginTop: 20 }]}>
                          {layoutZones.map((ly) => {
                            const layoutSelected = floorPinActive && pendingItem?.pinnedZone === ly.layout && !pendingItem?.pinnedRack;
                            return (
                              <View key={ly.layout} style={styles.layoutBlock}>
                                {floorPinActive ? (
                                  <Pressable onPress={() => pinFloorToLayoutFloor(ly.layout)} hitSlop={4}>
                                    <Text style={{ color: layoutSelected ? '#1D4ED8' : tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.xxs, marginBottom: 4 }}>
                                      {zoneLabel(ly.layout)} {layoutSelected ? '· Pinned' : ''}
                                    </Text>
                                  </Pressable>
                                ) : (
                                  <Text style={{ color: tokens.slate400, fontWeight: tokens.fontWeight.semibold, fontSize: tokens.text.xxs, marginBottom: 4 }}>{zoneLabel(ly.layout)}</Text>
                                )}
                                <View style={styles.rackRow}>
                                  {ly.racks.map((rackGroup) => {
                                    const rackSelected = floorPinActive && pendingItem?.pinnedZone === ly.layout && pendingItem?.pinnedRack === rackGroup.rack;
                                    return floorPinActive ? (
                                      <Pressable
                                        key={rackGroup.rack}
                                        onPress={() => pinFloorToRack(ly.layout, rackGroup.rack)}
                                        style={[
                                          styles.rackCardDisabled,
                                          { borderColor: rackSelected ? '#1D4ED8' : tokens.border, backgroundColor: rackSelected ? '#BFDBFE' : tokens.card, borderWidth: rackSelected ? 2 : 1 },
                                        ]}
                                      >
                                        <Text numberOfLines={1} style={{ color: rackSelected ? '#1D4ED8' : tokens.foreground, fontWeight: tokens.fontWeight.medium, fontSize: 8 }}>
                                          Rack {rackGroup.rack}
                                        </Text>
                                        <View style={styles.bayRow}>
                                          {rackGroup.bays.map((bayCell) => (
                                            <View key={bayCell.bay} style={[styles.baySeg, { borderColor: rackSelected ? '#1D4ED8' : tokens.border }]} />
                                          ))}
                                        </View>
                                      </Pressable>
                                    ) : (
                                      <View key={rackGroup.rack} style={[styles.rackCardDisabled, { borderColor: tokens.border, backgroundColor: tokens.muted }]}>
                                        <Text numberOfLines={1} style={{ color: tokens.slate400, fontWeight: tokens.fontWeight.medium, fontSize: 8 }}>
                                          Rack {rackGroup.rack}
                                        </Text>
                                        <View style={styles.bayRow}>
                                          {rackGroup.bays.map((bayCell) => (
                                            <View key={bayCell.bay} style={[styles.baySeg, { borderColor: tokens.border }]} />
                                          ))}
                                        </View>
                                      </View>
                                    );
                                  })}
                                </View>
                              </View>
                            );
                          })}
                        </View>

                        {floorPinActive && floorTapPoint ? (
                          <View pointerEvents="none" style={[styles.freeformPinWrap, { left: floorTapPoint.x - 14, top: floorTapPoint.y - 28 }]}>
                            <Ionicons name="location" size={28} color={tokens.rag.red.strong} />
                          </View>
                        ) : null}
                      </View>
                    )}
                  </View>
                </Animated.View>
              </View>
            </GestureDetector>
          </View>
        </Card>
      </View>

      {pendingItem ? (
        <View style={styles.formWrap}>
          <Card style={styles.skuPanel}>
            <View
              style={[
                styles.skuPanelHead,
                { backgroundColor: '#F7F8FA', borderBottomColor: tokens.border, borderTopLeftRadius: tokens.radius.xxl, borderTopRightRadius: tokens.radius.xxl },
              ]}
            >
              <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm }}>Reconciliation Form</Text>
              <Pressable onPress={handleCancelPending} hitSlop={8}>
                <Ionicons name="close" size={20} color={tokens.mutedForeground} />
              </Pressable>
            </View>

            <ScrollView style={{ flex: 1 }} contentContainerStyle={{ flexGrow: 1, gap: 10, paddingBottom: 10 }}>
              {(() => {
                const mismatch = pendingItem.matched === false;
                const pinRequired = pendingItem.origin === 'floor' && !pendingItem.pinnedAt;
                return (
                  <>
                    <View style={styles.statusPillRow}>
                      <View
                        style={[
                          styles.editStatusPill,
                          {
                            backgroundColor: pinRequired ? tokens.rag.amber.soft : mismatch ? tokens.rag.red.soft : tokens.rag.green.soft,
                            borderColor: pinRequired ? tokens.rag.amber.border : mismatch ? tokens.rag.red.border : tokens.rag.green.border,
                            borderRadius: tokens.radius.lg,
                          },
                        ]}
                      >
                        <Text
                          style={{
                            color: pinRequired ? tokens.rag.amber.strong : mismatch ? tokens.rag.red.strong : tokens.rag.green.strong,
                            fontWeight: tokens.fontWeight.bold,
                            fontSize: tokens.text.xs,
                          }}
                        >
                          {pinRequired ? 'Pin Required' : mismatch ? 'Location Mismatch' : pendingItem.matched ? 'Matched' : 'No Expectation on Record'}
                        </Text>
                      </View>
                    </View>
                    <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm }}>{pendingItem.sku}</Text>
                    <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xs }}>{pendingItem.name}</Text>
                    {pendingItem.expectedZone ? (
                      <View style={styles.compareRow}>
                        <View style={[styles.compareCol, { backgroundColor: tokens.card, borderColor: tokens.border, borderRadius: tokens.radius.xl }]}>
                          <Text style={{ color: tokens.mutedForeground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.xxs, textTransform: 'uppercase' }}>Expected Zone</Text>
                          <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm, marginTop: 4 }}>{zoneLabel(pendingItem.expectedZone)}</Text>
                        </View>
                        <View style={[styles.compareCol, { backgroundColor: tokens.card, borderColor: tokens.border, borderRadius: tokens.radius.xl }]}>
                          <Text style={{ color: tokens.mutedForeground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.xxs, textTransform: 'uppercase' }}>Found In</Text>
                          <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm, marginTop: 4 }} numberOfLines={1}>
                            {pendingItem.pinnedZone ? zoneLabel(pendingItem.pinnedZone) : pinRequired ? 'Not pinned yet' : '—'}
                          </Text>
                        </View>
                      </View>
                    ) : null}

                    {mismatch ? (
                      <Pressable
                        disabled={!!pendingItem.issueRaised && pendingItem.qtyIssueRaised === true}
                        onPress={() => setPendingItem((prev) => (prev ? { ...prev, qtyIssueRaised: true } : prev))}
                        style={[
                          styles.raiseIssueBox,
                          {
                            backgroundColor: pendingItem.qtyIssueRaised ? tokens.rag.green.soft : tokens.rag.red.soft,
                            borderColor: pendingItem.qtyIssueRaised ? tokens.rag.green.border : tokens.rag.red.border,
                            borderRadius: tokens.radius.lg,
                          },
                        ]}
                      >
                        <Ionicons name={pendingItem.qtyIssueRaised ? 'checkmark-circle' : 'flag'} size={18} color={pendingItem.qtyIssueRaised ? tokens.rag.green.strong : tokens.rag.red.strong} />
                        <Text
                          style={{ color: pendingItem.qtyIssueRaised ? tokens.rag.green.strong : tokens.rag.red.strong, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm, flex: 1 }}
                        >
                          {pendingItem.qtyIssueRaised ? 'Issue raised for this SKU' : 'Raise Issue — wrong location'}
                        </Text>
                      </Pressable>
                    ) : (
                      <>
                        <View style={[styles.fieldCard, { backgroundColor: tokens.card, borderWidth: 0, borderRadius: tokens.radius.xl }]}>
                          <View style={[styles.fieldCardBody, { paddingHorizontal: 0, paddingVertical: 0 }]}>
                            <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm }}>Is the pallet condition good?</Text>
                            <View style={styles.condGrid}>
                              {(
                                [
                                  { label: 'Good', value: true },
                                  { label: 'Not Good', value: false },
                                ] as const
                              ).map((opt) => {
                                const selected = pendingItem.palletConditionGood === opt.value;
                                return (
                                  <Pressable
                                    key={opt.label}
                                    onPress={() => setPendingItem((prev) => (prev ? { ...prev, palletConditionGood: opt.value } : prev))}
                                    style={styles.condChip}
                                  >
                                    <View style={[styles.radioDot, { borderColor: selected ? tokens.primary : tokens.slate400 }]}>
                                      {selected ? <View style={[styles.radioDotFill, { backgroundColor: tokens.primary }]} /> : null}
                                    </View>
                                    <Text style={{ color: tokens.foreground, fontSize: tokens.text.xs }}>{opt.label}</Text>
                                  </Pressable>
                                );
                              })}
                            </View>
                          </View>
                        </View>

                        <View style={[styles.fieldCard, { backgroundColor: tokens.card, borderColor: tokens.border, borderRadius: tokens.radius.xl }]}>
                          <View style={[styles.fieldCardHead, { backgroundColor: '#F7F8FA', borderBottomColor: tokens.border }]}>
                            <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm }}>Issue For 1: Quantity</Text>
                          </View>
                          <View style={styles.fieldCardBody}>
                            <TextInput
                              value={qtyText}
                              onChangeText={setQtyText}
                              keyboardType="number-pad"
                              placeholderTextColor={tokens.slate400}
                              style={[styles.qtyInput, { color: tokens.foreground, borderColor: tokens.border, backgroundColor: tokens.inputBackground, borderRadius: tokens.radius.lg }]}
                            />
                            <Pressable
                              disabled={!!pendingItem.qtyIssueRaised}
                              onPress={() => raiseFieldIssue('qtyIssueRaised')}
                              style={[
                                styles.raiseIssueBox,
                                {
                                  marginTop: 10,
                                  backgroundColor: pendingItem.qtyIssueRaised ? tokens.rag.green.soft : tokens.rag.amber.soft,
                                  borderColor: pendingItem.qtyIssueRaised ? tokens.rag.green.border : tokens.rag.amber.border,
                                  borderRadius: tokens.radius.lg,
                                },
                              ]}
                            >
                              <Ionicons name={pendingItem.qtyIssueRaised ? 'checkmark-circle' : 'flag-outline'} size={16} color={pendingItem.qtyIssueRaised ? tokens.rag.green.strong : tokens.rag.amber.strong} />
                              <Text
                                style={{
                                  color: pendingItem.qtyIssueRaised ? tokens.rag.green.strong : tokens.rag.amber.strong,
                                  fontWeight: tokens.fontWeight.semibold,
                                  fontSize: tokens.text.xs,
                                  flex: 1,
                                }}
                              >
                                {pendingItem.qtyIssueRaised ? 'Issue raised for quantity' : 'Raise Issue — quantity'}
                              </Text>
                            </Pressable>
                            <Text style={{ color: tokens.mutedForeground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.xxs, textTransform: 'uppercase', marginTop: 10 }}>
                              Evidence
                            </Text>
                            <EvidenceBlock
                              evidence={ensureFieldEvidence('qtyEvidence')}
                              onOpenNote={() => updateFieldEvidence('qtyEvidence', { noteOpen: true })}
                              onChangeNote={(note) => updateFieldEvidence('qtyEvidence', { note })}
                              onRecordAudio={() => updateFieldEvidence('qtyEvidence', { audio: { durationSec: 20, playing: false, bars: generateWaveformBars() } })}
                              onToggleAudioPlay={() => {
                                const ev = ensureFieldEvidence('qtyEvidence');
                                if (!ev.audio) return;
                                updateFieldEvidence('qtyEvidence', { audio: { ...ev.audio, playing: !ev.audio.playing } });
                              }}
                              onRemoveAudio={() => updateFieldEvidence('qtyEvidence', { audio: null })}
                              onAddImage={() => setAttachmentTarget('qty')}
                              onRemoveImage={(i) => updateFieldEvidence('qtyEvidence', { images: ensureFieldEvidence('qtyEvidence').images.filter((_, ii) => ii !== i) })}
                              onAddVideo={() => updateFieldEvidence('qtyEvidence', { videos: [...ensureFieldEvidence('qtyEvidence').videos, { durationSec: 20 }] })}
                              onRemoveVideo={(i) => updateFieldEvidence('qtyEvidence', { videos: ensureFieldEvidence('qtyEvidence').videos.filter((_, ii) => ii !== i) })}
                            />
                          </View>
                        </View>

                        <View style={[styles.fieldCard, { backgroundColor: tokens.card, borderColor: tokens.border, borderRadius: tokens.radius.xl }]}>
                          <View style={[styles.fieldCardHead, { backgroundColor: '#F7F8FA', borderBottomColor: tokens.border }]}>
                            <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm }}>Issue For 2: Damage</Text>
                          </View>
                          <View style={styles.fieldCardBody}>
                            <View style={styles.condGrid}>
                              {CONDITIONS.map((c) => {
                                const sel = pendingItem.condition === c;
                                return (
                                  <Pressable key={c} onPress={() => setPendingItem((prev) => (prev ? { ...prev, condition: c } : prev))} style={styles.condChip}>
                                    <View style={[styles.radioDot, { borderColor: sel ? tokens.primary : tokens.slate400 }]}>
                                      {sel ? <View style={[styles.radioDotFill, { backgroundColor: tokens.primary }]} /> : null}
                                    </View>
                                    <Text style={{ color: tokens.foreground, fontSize: tokens.text.xs }}>{c}</Text>
                                  </Pressable>
                                );
                              })}
                            </View>
                            <Pressable
                              disabled={!!pendingItem.conditionIssueRaised}
                              onPress={() => raiseFieldIssue('conditionIssueRaised')}
                              style={[
                                styles.raiseIssueBox,
                                {
                                  marginTop: 10,
                                  backgroundColor: pendingItem.conditionIssueRaised ? tokens.rag.green.soft : tokens.rag.amber.soft,
                                  borderColor: pendingItem.conditionIssueRaised ? tokens.rag.green.border : tokens.rag.amber.border,
                                  borderRadius: tokens.radius.lg,
                                },
                              ]}
                            >
                              <Ionicons
                                name={pendingItem.conditionIssueRaised ? 'checkmark-circle' : 'flag-outline'}
                                size={16}
                                color={pendingItem.conditionIssueRaised ? tokens.rag.green.strong : tokens.rag.amber.strong}
                              />
                              <Text
                                style={{
                                  color: pendingItem.conditionIssueRaised ? tokens.rag.green.strong : tokens.rag.amber.strong,
                                  fontWeight: tokens.fontWeight.semibold,
                                  fontSize: tokens.text.xs,
                                  flex: 1,
                                }}
                              >
                                {pendingItem.conditionIssueRaised ? 'Issue raised for damage' : 'Raise Issue — damage'}
                              </Text>
                            </Pressable>
                            <Text style={{ color: tokens.mutedForeground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.xxs, textTransform: 'uppercase', marginTop: 10 }}>
                              Evidence
                            </Text>
                            <EvidenceBlock
                              evidence={ensureFieldEvidence('conditionEvidence')}
                              onOpenNote={() => updateFieldEvidence('conditionEvidence', { noteOpen: true })}
                              onChangeNote={(note) => updateFieldEvidence('conditionEvidence', { note })}
                              onRecordAudio={() => updateFieldEvidence('conditionEvidence', { audio: { durationSec: 20, playing: false, bars: generateWaveformBars() } })}
                              onToggleAudioPlay={() => {
                                const ev = ensureFieldEvidence('conditionEvidence');
                                if (!ev.audio) return;
                                updateFieldEvidence('conditionEvidence', { audio: { ...ev.audio, playing: !ev.audio.playing } });
                              }}
                              onRemoveAudio={() => updateFieldEvidence('conditionEvidence', { audio: null })}
                              onAddImage={() => setAttachmentTarget('condition')}
                              onRemoveImage={(i) => updateFieldEvidence('conditionEvidence', { images: ensureFieldEvidence('conditionEvidence').images.filter((_, ii) => ii !== i) })}
                              onAddVideo={() => updateFieldEvidence('conditionEvidence', { videos: [...ensureFieldEvidence('conditionEvidence').videos, { durationSec: 20 }] })}
                              onRemoveVideo={(i) => updateFieldEvidence('conditionEvidence', { videos: ensureFieldEvidence('conditionEvidence').videos.filter((_, ii) => ii !== i) })}
                            />
                          </View>
                        </View>
                      </>
                    )}
                  </>
                );
              })()}
            </ScrollView>

            <View style={[styles.skuPanelFooter, { borderTopColor: tokens.border }]}>
              <Pressable onPress={handleCancelPending} style={[styles.outlineBtn, { flex: 1, backgroundColor: tokens.muted, borderColor: tokens.border, borderRadius: tokens.radius.lg }]}>
                <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.semibold, fontSize: tokens.text.sm }}>Cancel</Text>
              </Pressable>
              <Pressable onPress={handleSaveAndScanNext} style={[styles.primaryBtn, { backgroundColor: tokens.primary, borderRadius: tokens.radius.lg }]}>
                <Text style={{ color: tokens.primaryForeground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm }}>Save & Scan Next</Text>
              </Pressable>
            </View>
          </Card>
        </View>
      ) : null}
      </View>

      <BarcodeScannerModal
        visible={scannerOpen}
        title="Scan SKU"
        hint="Point at a SKU's zone or rack-location QR code"
        onScanned={handleRealScanned}
        onUseSimulated={handleSimulated}
        onClose={() => setScannerOpen(false)}
      />

      <NewAttachmentModal
        visible={attachmentTarget !== null}
        onClose={() => setAttachmentTarget(null)}
        onSave={(image) => {
          if (attachmentTarget === null) return;
          const field = attachmentTarget === 'qty' ? 'qtyEvidence' : 'conditionEvidence';
          updateFieldEvidence(field, { images: [...ensureFieldEvidence(field).images, image] });
        }}
      />
    </View>
  );
}

function ScannedSkuCard({ item, onPin }: { item: ScannedSku; onPin: () => void }) {
  const { tokens } = useTheme();
  const hasExpectation = item.expectedZone !== null;
  const resolved = item.matched !== null;
  const tone = !resolved ? tokens.accentBlue : item.matched ? tokens.rag.green : tokens.rag.amber;
  const originLabel = item.origin === 'zone' ? 'Zone Find' : item.origin === 'rack' ? 'Rack Find' : 'Floor Find';
  const originIcon = item.origin === 'zone' ? 'apps-outline' : item.origin === 'rack' ? 'grid-outline' : 'cube-outline';

  return (
    <Card>
      <View style={styles.cardTitleRow}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Ionicons name={originIcon} size={16} color={tokens.mutedForeground} />
          <Text style={{ color: tokens.mutedForeground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.xs }}>{originLabel}</Text>
        </View>
        <View style={[styles.statusBadge, { backgroundColor: tone.soft, borderRadius: tokens.radius.xl }]}>
          <Text style={{ color: tone.strong, fontSize: tokens.text.xs, fontWeight: tokens.fontWeight.bold }}>
            {!item.pinnedAt ? 'Pin Required' : !resolved ? 'No Expectation on Record' : item.matched ? 'Zone Matched' : 'Location Mismatch'}
          </Text>
        </View>
      </View>
      <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.base }}>{item.sku}</Text>
      <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xs, marginBottom: 4 }}>{item.name}</Text>
      <View style={styles.fieldGrid}>
        <Field label="Scanned" value={formatScanTime(item.scannedAt)} />
        {item.pinnedAt ? <Field label="Pinned" value={formatScanTime(item.pinnedAt)} /> : null}
        {hasExpectation ? <Field label="Expected Zone" value={zoneLabel(item.expectedZone as string)} /> : null}
        {item.pinnedFloorAreaId ? <Field label="Pinned Zone" value={item.pinnedZone ?? item.pinnedFloorAreaId} /> : null}
        {!item.pinnedFloorAreaId && item.pinnedZone ? <Field label="Pinned Zone" value={zoneLabel(item.pinnedZone)} /> : null}
        {item.pinnedRack ? <Field label="Pinned Rack" value={item.pinnedRack} /> : null}
        {item.pinnedAisle ? <Field label="Pinned Aisle" value={`Near Rack ${item.pinnedRack}`} /> : null}
        {item.pinnedBay ? <Field label="Pinned Bay" value={item.pinnedBay} /> : null}
        {item.pinnedLoc ? <Field label="Pinned Pallet" value={item.pinnedLoc} /> : null}
      </View>

      {/* Only a Floor-mode find ever needs this — Zone/Rack finds already
          resolved their location the instant they were scanned. */}
      {!item.pinnedAt ? (
        <Pressable onPress={onPin} style={[styles.outlineBtn, { borderColor: tokens.border, borderRadius: tokens.radius.lg, marginTop: 10 }]}>
          <Ionicons name="location-outline" size={16} color={tokens.foreground} />
          <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.semibold, fontSize: tokens.text.sm }}>Pin Exact Location</Text>
        </Pressable>
      ) : null}
      {item.issueRaised && item.pinnedZone ? (
        <View style={[styles.pinnedBanner, { borderColor: tokens.border, marginTop: 10 }]}>
          <Ionicons name="alert-circle" size={16} color={tokens.rag.amber.strong} />
          <Text style={{ color: tokens.foreground, fontSize: tokens.text.xs, flex: 1 }}>
            Issue raised — found in{' '}
            <Text style={{ fontWeight: tokens.fontWeight.bold }}>
              {[zoneLabel(item.pinnedZone), item.pinnedRack ? `Rack ${item.pinnedRack}` : null, item.pinnedAisle ? 'Aisle' : item.pinnedBay ? `Bay ${item.pinnedBay}` : null]
                .filter(Boolean)
                .join(' · ')}
            </Text>
          </Text>
        </View>
      ) : null}
    </Card>
  );
}

function Field({ label, value, full }: { label: string; value: string; full?: boolean }) {
  const { tokens } = useTheme();
  return (
    <View style={full ? styles.fieldFull : styles.field}>
      <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xxs, marginBottom: 2 }}>{label}</Text>
      <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.semibold, fontSize: tokens.text.sm }} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  modeRow: { flexDirection: 'row', alignItems: 'center', paddingRight: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  toolbar: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 10 },
  // Canvas <-> Reconciliation Form split — same layout Rack View and Zone
  // Scan both use once a form is open (canvas keeps most of the width,
  // form takes the rest), single full-width canvas otherwise.
  singleRow: { flex: 1 },
  splitRow: { flex: 1, flexDirection: 'row' },
  formWrap: { flex: 1, paddingVertical: 16, paddingRight: 16 },
  skuPanel: { flex: 1 },
  skuPanelHead: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginHorizontal: -16,
    marginTop: -16,
    marginBottom: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: 1,
  },
  skuPanelFooter: { flexDirection: 'row', gap: 10, marginTop: 12, paddingTop: 12, borderTopWidth: StyleSheet.hairlineWidth },
  statusPillRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 4 },
  editStatusPill: { alignSelf: 'flex-start', borderWidth: 1, paddingHorizontal: 10, paddingVertical: 5 },
  compareRow: { flexDirection: 'row', gap: 10 },
  compareCol: { flex: 1, borderWidth: 1, padding: 12 },
  fieldCard: { borderWidth: 1, overflow: 'hidden' },
  fieldCardHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 14, paddingVertical: 10, borderBottomWidth: 1 },
  fieldCardBody: { padding: 14, gap: 10 },
  raiseIssueBox: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, padding: 12 },
  condGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  condChip: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 6 },
  radioDot: { width: 14, height: 14, borderRadius: 7, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  radioDotFill: { width: 7, height: 7, borderRadius: 3.5 },
  qtyInput: { height: 40, borderWidth: 1, paddingHorizontal: 12, fontSize: 14 },
  primaryBtn: { flex: 1, height: 44, alignItems: 'center', justifyContent: 'center' },
  canvasWrap: { flex: 1, padding: 16 },
  canvasToolbarRow: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, paddingVertical: 10, borderBottomWidth: 1 },
  stage: { flex: 1, overflow: 'hidden' },
  stageCenter: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  planCanvas: { padding: 10 },
  // Same "Warehouse Floor" bordered boundary + dropped-pin marker as Pin
  // Exact Location's own canvas (src/features/quick-scan/
  // PinLocationScreen.tsx) — shown here only while a Floor-mode scan is
  // actively being pinned.
  warehouseFloor: { position: 'relative', borderWidth: 2, borderStyle: 'dashed', borderRadius: 16, padding: 10, paddingTop: 28 },
  warehouseFloorLabel: { position: 'absolute', top: 8, left: 16, flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8 },
  freeformPinWrap: { position: 'absolute' },
  zoneRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  zoneCard: { minWidth: 90, alignItems: 'center', paddingVertical: 12, paddingHorizontal: 10, borderRadius: 12 },
  layoutGroupRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 16 },
  layoutBlock: { gap: 4 },
  rackRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  rackCard: { alignItems: 'center', width: 56, borderRadius: 5, paddingVertical: 5, paddingHorizontal: 4, gap: 3 },
  rackCardDisabled: { alignItems: 'center', width: 56, borderWidth: 1, borderRadius: 5, paddingVertical: 5, paddingHorizontal: 4, gap: 3 },
  bayRow: { flexDirection: 'row', gap: 1.5 },
  baySeg: { width: 7, height: 11, borderWidth: 1, borderRadius: 1.5 },
  // Front View — same bay-columns/levels/slots layout as Rack View's own
  // canvas (src/features/rack-view/RackViewScreen.tsx), scaled down since
  // Quick Scan's cells don't need per-pallet audit-status coloring.
  bayColumnsRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 16 },
  bayColumnWrap: { flexDirection: 'row', alignItems: 'flex-end', gap: 16 },
  bayUpright: { width: 2, alignSelf: 'stretch', marginBottom: 24 },
  bayColumn: { alignItems: 'center' },
  diagram: { gap: 6 },
  diagramRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  diagramCells: { flexDirection: 'row', gap: 8 },
  diagramCellEmpty: { width: 38, height: 26, borderRadius: 4, borderWidth: 1, borderStyle: 'dashed' },
  cornerIconBtn: { width: 34, height: 34, alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
  listCountDot: { position: 'absolute', top: -6, right: -8, minWidth: 16, height: 16, borderRadius: 8, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 3 },
  listPageBody: { padding: 16, gap: 22, paddingBottom: 40 },
  groupHeadRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  cardListContent: { padding: 16, paddingTop: 0, gap: 14, flexGrow: 1 },
  cardTitleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  sectionHeadRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingBottom: 12, marginBottom: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  countBadge: { paddingHorizontal: 8, paddingVertical: 2, minWidth: 22, alignItems: 'center' },
  fieldGrid: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 2 },
  field: { width: '50%', marginBottom: 8, paddingRight: 8 },
  fieldFull: { width: '100%', marginBottom: 8 },
  outlineBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, height: 44, borderWidth: 1 },
  banner: { borderWidth: 1, borderRadius: 10, padding: 12 },
  pinnedBanner: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderRadius: 10, padding: 10 },
  emptyState: { alignItems: 'center', justifyContent: 'center', gap: 10, paddingVertical: 40 },
  statusBadge: { paddingHorizontal: 10, paddingVertical: 4 },
});
