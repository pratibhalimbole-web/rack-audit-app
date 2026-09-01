import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
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
import { EXPECTED_SKUS, expectedZoneForSku, fillBayLevels, FLOOR_AREAS, generateWaveformBars, INVENTORY_POOL, SKU_ZONE_EXPECTATIONS, type ExpectedSkuLine } from '@/lib/mockData';
import { useQuickScanPinStore } from '@/store/useQuickScanPinStore';
import { ACTIVITY_PHASES, type ActivityPhase, type Condition, type Evidence, type LocationNode, OBSERVATIONS_BY_PHASE, type SkuScanCode } from '@/lib/types';
import { useTheme } from '@/theme/ThemeProvider';
import { useAudits } from '../dashboard/hooks';
import { buildBayDiagram, locLevelPosition } from '../rack-view/buildBayDiagram';

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

// A persistent pulsing badge on the scan icon button — same idea as the
// scan-ready popup, but this one doesn't auto-dismiss, so a user who
// closed or missed the popup still has a standing "ready to scan" cue.
function ReadyDot() {
  const { tokens } = useTheme();
  const opacity = useSharedValue(1);
  useEffect(() => {
    opacity.value = withRepeat(withSequence(withTiming(0.25, { duration: 500 }), withTiming(1, { duration: 500 })), -1, true);
    return () => cancelAnimation(opacity);
  }, []);
  const animatedStyle = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return <Animated.View style={[styles.readyDot, { backgroundColor: tokens.rag.green.strong }, animatedStyle]} />;
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
  matched: boolean | null; // null until resolved — either awaiting a Floor pin, or resolved with no WMS/pick-list expectation on record
  // Rack origin only — the matched EXPECTED_SKUS entry for the pinned
  // pallet (if any), used for the Expected/Scanned compare column and the
  // quantity mismatch check, same as Rack View's own expectedSkus[0].
  expectedLine: ExpectedSkuLine | null;
  pinnedZone?: string;
  pinnedRack?: string;
  pinnedBay?: string;
  pinnedLoc?: string;
  pinnedAisle?: boolean;
  pinnedFloorAreaId?: string;
  scannedAt: number; // device clock at the moment the camera scan fired
  pinnedAt?: number; // device clock at the moment the location was resolved
  // Reconciliation Form fields — same shape as Rack View's scanLines[0]
  // (Pallet Condition gate, independent Quantity/Damage field-cards each
  // with their own evidence and Raise Issue flag), so the form renders
  // identically wherever it's reached. Quantity and damage are unknown at
  // scan time — a scan only proves SKU identity — so both start unset
  // ("-" shown instead of a number) until the inspector deliberately
  // enters what they actually found.
  qty: number | null;
  condition: Condition | null;
  activityPhase: ActivityPhase | null;
  observation: string | null;
  palletConditionGood?: boolean | null;
  // Rack origin's "wrong item scanned" issue (the misplaced case) is its
  // own flag, independent of the two field-level ones below — mirrors
  // Rack View's Mismatch vs. Quantity/Damage issue split.
  skuIssueRaised?: boolean;
  qtyIssueRaised?: boolean;
  damageIssueRaised?: boolean;
  qtyEvidence?: Evidence;
  damageEvidence?: Evidence;
  // Only set for a freeform "tap the open floor" pin — the exact
  // content-space point the inspector tapped, so View Location can drop the
  // same marker back down later instead of only showing text fields.
  pinnedPoint?: { x: number; y: number };
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
  // Quantity/Damage inline edit-in-place state — same shape as Rack View's
  // own qtyEditing/qtyInputText/damageEditing/damagePhaseDraft/
  // damageObservationDraft, just living on this screen instead since Quick
  // Scan's form isn't a shared component (see file header note above).
  const [qtyEditing, setQtyEditing] = useState(false);
  const [qtyInputText, setQtyInputText] = useState('');
  const [damageEditing, setDamageEditing] = useState(false);
  const [damagePhaseDraft, setDamagePhaseDraft] = useState<ActivityPhase | null>(null);
  const [damageObservationDraft, setDamageObservationDraft] = useState<string | null>(null);
  const [attachmentTarget, setAttachmentTarget] = useState<'qty' | 'damage' | null>(null);
  // A Floor-mode item's own read-only recap of where it got pinned — same
  // floor-areas + layout/rack reference grid the live canvas shows, just
  // static, with that one item's pin highlighted/marked instead of the
  // in-progress pendingItem's.
  const [viewLocationItem, setViewLocationItem] = useState<ScannedSku | null>(null);

  const ensureFieldEvidence = (field: 'qtyEvidence' | 'damageEvidence'): Evidence =>
    pendingItem?.[field] ?? { note: '', noteOpen: false, audio: null, images: [], videos: [] };
  const updateFieldEvidence = (field: 'qtyEvidence' | 'damageEvidence', patch: Partial<Evidence>) => {
    setPendingItem((prev) => (prev ? { ...prev, [field]: { ...ensureFieldEvidence(field), ...patch } } : prev));
  };
  // Mirrors Rack View's raiseFieldIssue(kind) — the misplaced case (rack
  // origin, wrong SKU) raises its own skuIssueRaised flag instead.
  const raiseFieldIssue = (kind: 'qty' | 'damage') => {
    setPendingItem((prev) => (prev ? { ...prev, [kind === 'qty' ? 'qtyIssueRaised' : 'damageIssueRaised']: true } : prev));
  };
  const raiseSkuIssue = () => setPendingItem((prev) => (prev ? { ...prev, skuIssueRaised: true } : prev));
  const handleSelectPalletCondition = (good: boolean) => setPendingItem((prev) => (prev ? { ...prev, palletConditionGood: good } : prev));
  const handleOpenQtyEdit = () => {
    setQtyInputText(pendingItem?.qty != null ? String(pendingItem.qty) : '');
    setQtyEditing(true);
  };
  const handleConfirmQty = () => {
    const n = parseInt(qtyInputText, 10);
    const qty = Number.isNaN(n) ? 0 : Math.max(0, n);
    setPendingItem((prev) => (prev ? { ...prev, qty } : prev));
    setQtyEditing(false);
  };
  const handleOpenDamageEdit = () => {
    setDamagePhaseDraft(pendingItem?.activityPhase ?? null);
    setDamageObservationDraft(pendingItem?.observation ?? null);
    setDamageEditing(true);
  };
  const handleSelectDamagePhase = (phase: ActivityPhase) => {
    setDamagePhaseDraft(phase);
    setDamageObservationDraft(null);
  };
  // Same as Rack View — Damage's confirm flow always sets condition to
  // 'Damaged' plus the picked Activity Phase + Observation; there's no path
  // to explicitly mark "Good" via this field.
  const handleConfirmDamage = () => {
    if (!damagePhaseDraft || !damageObservationDraft) return;
    setPendingItem((prev) => (prev ? { ...prev, condition: 'Damaged', activityPhase: damagePhaseDraft, observation: damageObservationDraft } : prev));
    setDamageEditing(false);
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
  // floorPinContext covers the whole time this scan's form is open (so the
  // dropped-pin marker and the amber "Warehouse Floor" framing stay
  // visible as confirmation even after resolving, the way a real map pin
  // doesn't vanish the instant you drop it); floorPinActive is the
  // narrower "still needs a tap" state that gates interactivity/highlights.
  const floorPinContext = mode === 'floor' && !!pendingItem && pendingItem.origin === 'floor';
  const floorPinActive = floorPinContext && !pendingItem!.pinnedAt;
  const [floorTapPoint, setFloorTapPoint] = useState<{ x: number; y: number } | null>(null);

  const pinFloorToZoneArea = (zoneId: string) => {
    const area = FLOOR_AREAS.find((z) => z.id === zoneId);
    if (!area) return;
    setFloorTapPoint(null);
    setPendingItem((prev) => {
      if (!prev) return prev;
      const matched = prev.expectedZone ? prev.expectedZone === area.label : null;
      return { ...prev, pinnedZone: area.label, pinnedFloorAreaId: area.id, pinnedRack: undefined, pinnedBay: undefined, pinnedLoc: undefined, pinnedAisle: undefined, matched, pinnedAt: Date.now() };
    });
  };
  const pinFloorToLayoutFloor = (layout: string) => {
    setFloorTapPoint(null);
    setPendingItem((prev) => {
      if (!prev) return prev;
      const matched = prev.expectedZone ? prev.expectedZone === layout : null;
      return { ...prev, pinnedZone: layout, pinnedFloorAreaId: undefined, pinnedRack: undefined, pinnedBay: undefined, pinnedLoc: undefined, pinnedAisle: undefined, matched, pinnedAt: Date.now() };
    });
  };
  const pinFloorToRack = (layout: string, rack: string) => {
    setFloorTapPoint(null);
    setPendingItem((prev) => {
      if (!prev) return prev;
      const matched = prev.expectedZone ? prev.expectedZone === layout : null;
      return { ...prev, pinnedZone: layout, pinnedRack: rack, pinnedFloorAreaId: undefined, pinnedBay: undefined, pinnedLoc: undefined, pinnedAisle: undefined, matched, pinnedAt: Date.now() };
    });
  };
  // Tapping the open floor itself — not a specific zone, rack, or floor
  // area — same Google Maps "drop a pin exactly where you tapped" as Pin
  // Exact Location's own freeform tap.
  const pinFloorFreeform = (x: number, y: number) => {
    setFloorTapPoint({ x, y });
    setPendingItem((prev) =>
      prev
        ? { ...prev, pinnedZone: 'Open Floor', pinnedFloorAreaId: undefined, pinnedRack: undefined, pinnedBay: undefined, pinnedLoc: undefined, pinnedAisle: undefined, matched: null, pinnedAt: Date.now(), pinnedPoint: { x, y } }
        : prev,
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
  // Rack mode only counts as "ready" once the full Layout → Rack → Bay →
  // Pallet drill-down is done — picking just the rack isn't enough to scan
  // into a specific pallet slot.
  const rackSelectionComplete = !!activeLayout && !!activeRack && !!activeBay && !!activeLoc;
  const canScan = !pendingItem && (mode === 'floor' || (mode === 'zone' && !!activeZoneObj) || (mode === 'rack' && rackSelectionComplete));

  // Identifies the exact completed selection for each mode — Zone needs a
  // zone picked (dropdown or canvas tap, both funnel through pickZone),
  // Rack needs a rack picked (same, through pickRack), Floor is "complete"
  // the moment it's chosen since it has no location to pre-pick. Watching
  // THIS (not canScan) for the scan-ready popup means finishing a scan and
  // hitting Save & Scan Next — which also flips canScan back to true —
  // does NOT re-fire the popup, since the underlying selection didn't
  // change; only an actual new zone/rack/floor pick does.
  const selectionKey =
    mode === 'zone'
      ? activeFloorAreaId
        ? `zone:${activeFloorAreaId}`
        : null
      : mode === 'rack'
        ? rackSelectionComplete
          ? `rack:${activeLayout}:${activeRack}:${activeBay}:${activeLoc}`
          : null
        : 'floor';
  const [scanPrompt, setScanPrompt] = useState<string | null>(null);
  const prevSelectionKeyRef = useRef<string | null>(null);
  const promptTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (selectionKey && selectionKey !== prevSelectionKeyRef.current && !pendingItem) {
      const label = mode === 'zone' ? activeZoneObj?.label : mode === 'rack' ? `Rack ${activeRack} · Bay ${activeBay} · ${activeLoc}` : 'Floor mode';
      setScanPrompt(`${label} selected`);
      if (promptTimerRef.current) clearTimeout(promptTimerRef.current);
      promptTimerRef.current = setTimeout(() => setScanPrompt(null), 4000);
    }
    prevSelectionKeyRef.current = selectionKey;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectionKey]);
  useEffect(() => () => {
    if (promptTimerRef.current) clearTimeout(promptTimerRef.current);
  }, []);

  // Brief confirmation after every Save & Scan Next, timed with the reset
  // back to the default (nothing-selected) page.
  const [savedPrompt, setSavedPrompt] = useState<string | null>(null);
  const savedPromptTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (savedPromptTimerRef.current) clearTimeout(savedPromptTimerRef.current);
  }, []);

  const openScannerFromPrompt = () => {
    if (promptTimerRef.current) clearTimeout(promptTimerRef.current);
    setScanPrompt(null);
    setScannerOpen(true);
  };

  const applySkuCode = (code: Partial<SkuScanCode>) => {
    setScannerOpen(false);
    if (!code.sku) return;
    const inv = INVENTORY_POOL.find((p) => p.sku === code.sku);
    // Same base shape Rack View's scanLines[0] starts a fresh scan with —
    // qty/condition start unset (a scan only proves SKU identity), each
    // field's own evidence starts empty, no issue raised yet — so the
    // Reconciliation Form renders identically to Rack View's regardless of
    // which of the three Quick Scan modes it opened from.
    const base = {
      id: nextId(),
      sku: code.sku!,
      qty: null,
      condition: null,
      activityPhase: null,
      observation: null,
      palletConditionGood: null,
      qtyEvidence: { note: '', noteOpen: false, audio: null, images: [], videos: [] },
      damageEvidence: { note: '', noteOpen: false, audio: null, images: [], videos: [] },
      skuIssueRaised: false,
      qtyIssueRaised: false,
      damageIssueRaised: false,
      scannedAt: Date.now(),
    };
    setQtyEditing(false);
    setQtyInputText('');
    setDamageEditing(false);
    setDamagePhaseDraft(null);
    setDamageObservationDraft(null);

    if (mode === 'zone' && activeZoneObj) {
      const expectedZone = expectedZoneForSku(code.sku);
      const matched = expectedZone ? expectedZone === activeZoneObj.label : null;
      setPendingItem({
        ...base,
        name: inv?.name ?? code.sku!,
        origin: 'zone',
        expectedZone,
        expectedLine: null,
        matched,
        pinnedZone: activeZoneObj.label,
        pinnedFloorAreaId: activeZoneObj.id,
        pinnedAt: Date.now(),
      });
      return;
    }

    if (mode === 'rack' && activeLayout && activeRack && activeBay && activeLoc) {
      // Rack origin compares against the exact pallet's own pick list
      // (EXPECTED_SKUS, keyed by location) — same source Rack View's own
      // Reconciliation Form uses — not a layout-level zone expectation,
      // since a rack pallet has a real expected SKU/qty to reconcile
      // against, not just a zone match.
      const expected = EXPECTED_SKUS[activeLoc] ?? [];
      const matched = expected.length ? expected.some((l) => l.sku === code.sku) : null;
      setPendingItem({
        ...base,
        name: expected[0]?.name ?? inv?.name ?? code.sku!,
        origin: 'rack',
        expectedZone: null,
        expectedLine: expected[0] ?? null,
        matched,
        pinnedZone: activeLayout,
        pinnedRack: activeRack,
        pinnedBay: activeBay,
        pinnedLoc: activeLoc,
        pinnedAt: Date.now(),
      });
      return;
    }

    // Floor mode (or Zone/Rack scanned before a location was picked,
    // which canScan already prevents) — unresolved until pinned, but the
    // Reconciliation Form still opens right away for pallet condition/
    // qty/damage/evidence.
    const expectedZone = expectedZoneForSku(code.sku);
    setPendingItem({
      ...base,
      name: inv?.name ?? code.sku!,
      origin: 'floor',
      expectedZone,
      expectedLine: null,
      matched: null,
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
    if (pendingItem.origin === 'floor' && !pendingItem.pinnedAt) return;
    setItems((prev) => [pendingItem, ...prev]);
    setPendingItem(null);
    setQtyEditing(false);
    setQtyInputText('');
    setDamageEditing(false);
    setDamagePhaseDraft(null);
    setDamageObservationDraft(null);
    // Back to the untouched default page after every save — Mode reset to
    // Zone, nothing picked in any mode — instead of leaving the previous
    // selection standing, so the next scan is a deliberate fresh choice
    // rather than accidentally landing in whatever was last active.
    setMode('zone');
    setActiveFloorAreaId(null);
    setActiveLayout(null);
    setActiveRack(null);
    setActiveBay(null);
    setActiveLoc(null);
    setOpenField(null);
    setFloorTapPoint(null);
    setSavedPrompt('Record saved');
    if (savedPromptTimerRef.current) clearTimeout(savedPromptTimerRef.current);
    savedPromptTimerRef.current = setTimeout(() => setSavedPrompt(null), 1800);
  };
  const handleCancelPending = () => {
    setPendingItem(null);
    setQtyEditing(false);
    setQtyInputText('');
    setDamageEditing(false);
    setDamagePhaseDraft(null);
    setDamageObservationDraft(null);
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
                    <ScannedSkuCard key={item.id} item={item} onViewLocation={() => setViewLocationItem(item)} />
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

        {viewLocationItem ? (
          <LocationViewModal item={viewLocationItem} layoutZones={layoutZones} onClose={() => setViewLocationItem(null)} />
        ) : null}
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
            {canScan ? <ReadyDot /> : null}
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
                      <View
                        style={
                          mode === 'floor'
                            ? [styles.warehouseFloor, { borderColor: floorPinContext ? tokens.rag.amber.strong : tokens.border, backgroundColor: '#F1F2F4' }]
                            : undefined
                        }
                      >
                        {mode === 'floor' ? (
                          <View style={[styles.warehouseFloorLabel, { backgroundColor: tokens.card }]}>
                            <Ionicons name="business-outline" size={11} color={floorPinContext ? tokens.rag.amber.strong : tokens.mutedForeground} />
                            <Text
                              style={{
                                color: floorPinContext ? tokens.rag.amber.strong : tokens.mutedForeground,
                                fontWeight: tokens.fontWeight.bold,
                                fontSize: 9,
                                textTransform: 'uppercase',
                                letterSpacing: 0.4,
                              }}
                            >
                              Warehouse Floor
                            </Text>
                          </View>
                        ) : null}
                        <View style={styles.zoneRow}>
                          {FLOOR_AREAS.map((zone) => {
                            const selected = (mode === 'zone' && activeFloorAreaId === zone.id) || (floorPinActive && pendingItem?.pinnedFloorAreaId === zone.id);
                            // In Floor mode these are reference-only until a
                            // scan is actively being pinned — grayed out the
                            // same way Rack View's inactive rack cards are,
                            // instead of reading as equally "live" as Zone
                            // mode's own always-tappable cards.
                            const grayed = mode === 'floor' && !floorPinActive && !selected;
                            return (
                              <Pressable
                                key={zone.id}
                                disabled={mode !== 'zone' && !floorPinActive}
                                onPress={() => (mode === 'zone' ? pickZone(zone.id) : pinFloorToZoneArea(zone.id))}
                                style={[
                                  styles.zoneCard,
                                  {
                                    borderColor: selected ? '#1D4ED8' : tokens.border,
                                    borderWidth: selected ? 2.5 : 1.5,
                                    backgroundColor: selected ? '#BFDBFE' : grayed ? tokens.muted : tokens.card,
                                  },
                                ]}
                              >
                                <Text style={{ color: selected ? '#1D4ED8' : grayed ? tokens.slate400 : tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm }}>
                                  {zone.label}
                                </Text>
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

                        {floorPinContext && floorTapPoint ? (
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
              <View>
                <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm }}>Reconciliation Form</Text>
                <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xs, marginTop: 2 }}>
                  {pendingItem.sku} · {pendingItem.origin === 'zone' ? 'Zone Find' : pendingItem.origin === 'rack' ? 'Rack Find' : 'Floor Find'}
                </Text>
              </View>
              <Pressable onPress={handleCancelPending} hitSlop={8}>
                <Ionicons name="close" size={20} color={tokens.mutedForeground} />
              </Pressable>
            </View>

            {/* Selected Location Details — same rf-loc-box grid Rack View's
                own panel uses (DetailRow x6 for a real rack pallet); Zone
                and Floor origins only ever resolve to a Mode + Zone label,
                never a rack/bay/level/position, so they show a shorter
                two-row box instead. */}
            <Text style={{ color: tokens.mutedForeground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.xxs, textTransform: 'uppercase', marginBottom: 8 }}>
              Selected Location Details
            </Text>
            <View style={styles.locDetailsBox}>
              {pendingItem.origin === 'rack'
                ? (() => {
                    const bayObj = pendingItem.pinnedZone && pendingItem.pinnedRack && pendingItem.pinnedBay
                      ? { code: pendingItem.pinnedBay, locations: locationsByBay.get(`${pendingItem.pinnedZone}|${pendingItem.pinnedRack}|${pendingItem.pinnedBay}`) ?? [] }
                      : undefined;
                    const { level, position } = locLevelPosition(bayObj, pendingItem.pinnedLoc ?? null);
                    return (
                      <>
                        <QsDetailRow label="Layout" value={pendingItem.pinnedZone || '—'} />
                        <QsDetailRow label="Rack" value={pendingItem.pinnedRack || '—'} />
                        <QsDetailRow label="Bay" value={pendingItem.pinnedBay || '—'} />
                        <QsDetailRow label="Level" value={level ? `L${level}` : '—'} />
                        <QsDetailRow label="Position" value={position ? `P${String(position).padStart(2, '0')}` : '—'} />
                        <QsDetailRow label="Pallet" value={pendingItem.pinnedLoc || '—'} />
                      </>
                    );
                  })()
                : (
                  <>
                    <QsDetailRow label="Mode" value={pendingItem.origin === 'zone' ? 'Zone' : 'Floor'} />
                    <QsDetailRow label="Zone" value={pendingItem.pinnedZone ? zoneLabel(pendingItem.pinnedZone) : pendingItem.origin === 'floor' ? 'Not pinned yet' : '—'} />
                  </>
                )}
            </View>
            <View style={[styles.divider, { backgroundColor: tokens.border }]} />

            <ScrollView style={{ flex: 1 }} contentContainerStyle={{ flexGrow: 1, gap: 10, paddingBottom: 10 }}>
              {(() => {
                const rackOrigin = pendingItem.origin === 'rack';
                // "Misplaced" (a single "wrong item scanned" Raise Issue
                // button in place of the two field-cards) only applies to
                // rack origin, where matched===false means the wrong SKU
                // sits on a known pallet. Zone/Floor's matched===false is a
                // location mismatch, not a wrong-identity scan — there's no
                // "expected SKU" to have gotten wrong there, so those still
                // get the normal qty/damage field-cards.
                const misplaced = rackOrigin && pendingItem.matched === false;
                const pinRequired = pendingItem.origin === 'floor' && !pendingItem.pinnedAt;
                const qtyChecked = pendingItem.qty != null;
                const damageChecked = !!pendingItem.condition;
                const primary =
                  pendingItem.matched === false
                    ? { label: rackOrigin ? 'Mismatch' : 'Location Mismatch', rag: tokens.rag.red }
                    : pendingItem.matched === true
                      ? { label: 'Matched', rag: tokens.rag.green }
                      : { label: 'No Expectation on Record', rag: tokens.rag.amber };
                const qtyMismatch = rackOrigin && !misplaced && qtyChecked && !!pendingItem.expectedLine && pendingItem.qty !== pendingItem.expectedLine.qty;
                const conditionFlagged = !misplaced && damageChecked && pendingItem.condition !== 'Good';

                return (
                  <>
                    {/* Pallet Condition gate — asked for all 3 Quick Scan
                        modes, same as Rack View's own panel, independent of
                        whether the SKU/location resolved cleanly. */}
                    <View style={[styles.fieldCard, { backgroundColor: tokens.card, borderWidth: 0, borderRadius: tokens.radius.xl }]}>
                      <View style={[styles.fieldCardBody, { paddingHorizontal: 0, paddingVertical: 0 }]}>
                        <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm }}>Is the pallet condition at this location good?</Text>
                        <View style={styles.condGrid}>
                          {(
                            [
                              { label: 'Good', value: true },
                              { label: 'Not Good', value: false },
                            ] as const
                          ).map((opt) => {
                            const selected = pendingItem.palletConditionGood === opt.value;
                            return (
                              <Pressable key={opt.label} onPress={() => handleSelectPalletCondition(opt.value)} style={styles.condChip}>
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

                    {/* Floor mode's pin-then-resolve flow — unchanged
                        behavior, just also offered right here in the form
                        (not only on the canvas behind it) so pinning and
                        the rest of the form live in one place, same as the
                        web app's own renderQuickScanForm. */}
                    {pinRequired ? (
                      <>
                        <View style={[styles.banner, { backgroundColor: tokens.rag.amber.soft, borderColor: tokens.rag.amber.border }]}>
                          <Text style={{ color: tokens.rag.amber.strong, fontWeight: tokens.fontWeight.semibold, fontSize: tokens.text.xs }}>
                            Tap a zone below to pin this SKU’s exact location before saving.
                          </Text>
                        </View>
                        <View style={styles.zoneRow}>
                          {FLOOR_AREAS.map((z) => (
                            <Pressable
                              key={z.id}
                              onPress={() => pinFloorToZoneArea(z.id)}
                              style={[styles.zoneCard, { borderColor: tokens.border, borderWidth: 1.5, backgroundColor: tokens.card }]}
                            >
                              <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm }}>{z.label}</Text>
                            </Pressable>
                          ))}
                        </View>
                      </>
                    ) : null}

                    <View style={styles.statusPillRow}>
                      <View style={[styles.editStatusPill, { backgroundColor: primary.rag.soft, borderColor: primary.rag.border, borderRadius: tokens.radius.lg }]}>
                        <Text style={{ color: primary.rag.strong, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.xs }}>{primary.label}</Text>
                      </View>
                      {qtyMismatch ? (
                        <View style={[styles.editStatusPill, { backgroundColor: tokens.rag.amber.soft, borderColor: tokens.rag.amber.border, borderRadius: tokens.radius.lg }]}>
                          <Text style={{ color: tokens.rag.amber.strong, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.xs }}>Quantity Mismatch</Text>
                        </View>
                      ) : null}
                      {conditionFlagged ? (
                        <View style={[styles.editStatusPill, { backgroundColor: tokens.rag.amber.soft, borderColor: tokens.rag.amber.border, borderRadius: tokens.radius.lg }]}>
                          <Text style={{ color: tokens.rag.amber.strong, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.xs }}>Damage Mismatch</Text>
                        </View>
                      ) : null}
                    </View>

                    {/* Expected/Scanned compare — rack origin compares the
                        full expected SKU/name/qty pick-list line against
                        what was scanned, exactly like Rack View's own
                        compare row; Zone/Floor origins only ever resolve to
                        a zone label, so they compare Expected Zone vs.
                        Found In instead. */}
                    <View style={styles.compareRow}>
                      <View style={[styles.compareCol, { backgroundColor: tokens.card, borderColor: tokens.border, borderRadius: tokens.radius.xl }]}>
                        <Text style={{ color: tokens.mutedForeground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.xxs, textTransform: 'uppercase' }}>
                          {rackOrigin ? 'Expected' : 'Expected Zone'}
                        </Text>
                        {rackOrigin ? (
                          pendingItem.expectedLine ? (
                            <>
                              <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm, marginTop: 4 }}>{pendingItem.expectedLine.sku}</Text>
                              <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xs, marginTop: 1 }}>{pendingItem.expectedLine.name}</Text>
                              <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xs, marginTop: 5 }}>Qty {pendingItem.expectedLine.qty}</Text>
                            </>
                          ) : (
                            <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xs, marginTop: 4 }}>Nothing expected</Text>
                          )
                        ) : pendingItem.expectedZone ? (
                          <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm, marginTop: 4 }}>{zoneLabel(pendingItem.expectedZone)}</Text>
                        ) : (
                          <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xs, marginTop: 4 }}>No expectation on record</Text>
                        )}
                      </View>
                      <View style={[styles.compareCol, { backgroundColor: tokens.card, borderColor: tokens.border, borderRadius: tokens.radius.xl }]}>
                        <Text style={{ color: tokens.mutedForeground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.xxs, textTransform: 'uppercase' }}>
                          {rackOrigin ? 'Scanned' : 'Found In'}
                        </Text>
                        {rackOrigin ? (
                          <>
                            <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm, marginTop: 4 }}>{pendingItem.sku}</Text>
                            <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xs, marginTop: 1 }}>{pendingItem.name}</Text>
                            <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xs, marginTop: 5 }}>
                              Qty {qtyChecked ? pendingItem.qty : '-'} · {damageChecked ? pendingItem.condition : '-'}
                            </Text>
                          </>
                        ) : (
                          <>
                            <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm, marginTop: 4 }} numberOfLines={1}>
                              {pendingItem.pinnedZone ? zoneLabel(pendingItem.pinnedZone) : pinRequired ? 'Not pinned yet' : '—'}
                            </Text>
                            <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xs, marginTop: 1 }}>
                              {pendingItem.sku} · {pendingItem.name}
                            </Text>
                          </>
                        )}
                      </View>
                    </View>

                    {misplaced ? (
                      <QsRaiseIssueButton
                        raised={!!pendingItem.skuIssueRaised}
                        onPress={raiseSkuIssue}
                        activeLabel="Raise Issue — wrong item scanned"
                        raisedLabel="Issue raised for this SKU"
                        showHint
                      />
                    ) : (
                      // SKU (or zone) matched — quantity and damage are two
                      // independent findings, each with its own entry
                      // control, its own Matched/Mismatched status, and its
                      // own Raise Issue button, same as Rack View.
                      <>
                        <View style={[styles.fieldCard, { backgroundColor: tokens.card, borderColor: tokens.border, borderRadius: tokens.radius.xl }]}>
                          <View style={[styles.fieldCardHead, { backgroundColor: '#F7F8FA', borderBottomColor: tokens.border }]}>
                            <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm }}>Issue For 1: Quantity</Text>
                            {rackOrigin && qtyChecked && pendingItem.expectedLine ? (
                              <View
                                style={[
                                  styles.editStatusPill,
                                  {
                                    backgroundColor: pendingItem.qty === pendingItem.expectedLine.qty ? tokens.rag.green.soft : tokens.rag.amber.soft,
                                    borderColor: pendingItem.qty === pendingItem.expectedLine.qty ? tokens.rag.green.border : tokens.rag.amber.border,
                                    borderRadius: tokens.radius.lg,
                                  },
                                ]}
                              >
                                <Text
                                  style={{
                                    color: pendingItem.qty === pendingItem.expectedLine.qty ? tokens.rag.green.strong : tokens.rag.amber.strong,
                                    fontWeight: tokens.fontWeight.bold,
                                    fontSize: tokens.text.xs,
                                  }}
                                >
                                  {pendingItem.qty === pendingItem.expectedLine.qty ? 'Matched' : 'Mismatched'}
                                </Text>
                              </View>
                            ) : null}
                          </View>
                          <View style={styles.fieldCardBody}>
                            {qtyEditing ? (
                              <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
                                <TextInput
                                  value={qtyInputText}
                                  onChangeText={setQtyInputText}
                                  placeholder="Quantity you found"
                                  keyboardType="number-pad"
                                  placeholderTextColor={tokens.slate400}
                                  autoFocus
                                  style={[styles.qtyInput, { flex: 1, color: tokens.foreground, borderColor: tokens.border, backgroundColor: tokens.inputBackground, borderRadius: tokens.radius.lg }]}
                                />
                                <Pressable onPress={handleConfirmQty} style={[styles.smallPrimaryBtn, { backgroundColor: tokens.primary, borderRadius: tokens.radius.lg }]}>
                                  <Text style={{ color: tokens.primaryForeground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.xs }}>Confirm</Text>
                                </Pressable>
                              </View>
                            ) : (
                              <Pressable onPress={handleOpenQtyEdit} style={styles.fieldValueRow}>
                                <Text style={{ color: tokens.foreground, fontSize: tokens.text.sm }}>
                                  Qty found: <Text style={{ fontWeight: tokens.fontWeight.bold }}>{qtyChecked ? pendingItem.qty : '-'}</Text>
                                </Text>
                                <View style={[styles.editIconBtn, { backgroundColor: tokens.muted, borderRadius: tokens.radius.sm }]}>
                                  <Ionicons name={qtyChecked ? 'create-outline' : 'add'} size={14} color={tokens.primary} />
                                </View>
                              </Pressable>
                            )}
                            {qtyMismatch ? (
                              <QsRaiseIssueButton
                                raised={!!pendingItem.qtyIssueRaised}
                                onPress={() => raiseFieldIssue('qty')}
                                activeLabel="Raise Issue — quantity"
                                raisedLabel="Issue raised for quantity"
                              />
                            ) : null}
                            <Text style={{ color: tokens.mutedForeground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.xxs, textTransform: 'uppercase' }}>Evidence</Text>
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
                            {damageChecked ? (
                              <View
                                style={[
                                  styles.editStatusPill,
                                  {
                                    backgroundColor: pendingItem.condition === 'Good' ? tokens.rag.green.soft : tokens.rag.amber.soft,
                                    borderColor: pendingItem.condition === 'Good' ? tokens.rag.green.border : tokens.rag.amber.border,
                                    borderRadius: tokens.radius.lg,
                                  },
                                ]}
                              >
                                <Text
                                  style={{
                                    color: pendingItem.condition === 'Good' ? tokens.rag.green.strong : tokens.rag.amber.strong,
                                    fontWeight: tokens.fontWeight.bold,
                                    fontSize: tokens.text.xs,
                                  }}
                                >
                                  {pendingItem.condition === 'Good' ? 'Matched' : 'Mismatched'}
                                </Text>
                              </View>
                            ) : null}
                          </View>
                          <View style={styles.fieldCardBody}>
                            {damageEditing ? (
                              <>
                                <Text style={[styles.sectionLabel, { color: tokens.foreground }]}>
                                  Activity Phase <Text style={{ color: tokens.rag.red.strong }}>*</Text>
                                </Text>
                                <View style={styles.condGrid}>
                                  {ACTIVITY_PHASES.map((phase) => {
                                    const selected = damagePhaseDraft === phase;
                                    return (
                                      <Pressable key={phase} onPress={() => handleSelectDamagePhase(phase)} style={styles.condChip}>
                                        <View style={[styles.radioDot, { borderColor: selected ? tokens.primary : tokens.slate400 }]}>
                                          {selected ? <View style={[styles.radioDotFill, { backgroundColor: tokens.primary }]} /> : null}
                                        </View>
                                        <Text style={{ color: tokens.foreground, fontSize: tokens.text.xs }}>{phase}</Text>
                                      </Pressable>
                                    );
                                  })}
                                </View>

                                <Text style={[styles.sectionLabel, { color: tokens.foreground }]}>
                                  Observations <Text style={{ color: tokens.rag.red.strong }}>*</Text>
                                </Text>
                                {damagePhaseDraft ? (
                                  <View style={styles.condGrid}>
                                    {OBSERVATIONS_BY_PHASE[damagePhaseDraft].map((obs) => {
                                      const selected = damageObservationDraft === obs;
                                      return (
                                        <Pressable key={obs} onPress={() => setDamageObservationDraft(obs)} style={styles.condChip}>
                                          <View style={[styles.radioDot, { borderColor: selected ? tokens.primary : tokens.slate400 }]}>
                                            {selected ? <View style={[styles.radioDotFill, { backgroundColor: tokens.primary }]} /> : null}
                                          </View>
                                          <Text style={{ color: tokens.foreground, fontSize: tokens.text.xs }}>{obs}</Text>
                                        </Pressable>
                                      );
                                    })}
                                  </View>
                                ) : (
                                  <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xs }}>Pick an Activity Phase first.</Text>
                                )}

                                <Pressable
                                  disabled={!damagePhaseDraft || !damageObservationDraft}
                                  onPress={handleConfirmDamage}
                                  style={[
                                    styles.smallPrimaryBtn,
                                    { alignSelf: 'flex-start', backgroundColor: tokens.primary, borderRadius: tokens.radius.lg, opacity: damagePhaseDraft && damageObservationDraft ? 1 : 0.5 },
                                  ]}
                                >
                                  <Text style={{ color: tokens.primaryForeground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.xs }}>Confirm</Text>
                                </Pressable>
                              </>
                            ) : (
                              <Pressable onPress={handleOpenDamageEdit} style={styles.fieldValueRow}>
                                <View style={{ flex: 1 }}>
                                  <Text style={{ color: tokens.foreground, fontSize: tokens.text.sm }}>
                                    Damage found: <Text style={{ fontWeight: tokens.fontWeight.bold }}>{damageChecked ? (pendingItem.observation ?? pendingItem.condition) : '-'}</Text>
                                  </Text>
                                  {damageChecked && pendingItem.activityPhase ? (
                                    <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xs, marginTop: 2 }}>{pendingItem.activityPhase}</Text>
                                  ) : null}
                                </View>
                                <View style={[styles.editIconBtn, { backgroundColor: tokens.muted, borderRadius: tokens.radius.sm }]}>
                                  <Ionicons name={damageChecked ? 'create-outline' : 'add'} size={14} color={tokens.primary} />
                                </View>
                              </Pressable>
                            )}
                            {damageChecked && pendingItem.condition !== 'Good' ? (
                              <QsRaiseIssueButton
                                raised={!!pendingItem.damageIssueRaised}
                                onPress={() => raiseFieldIssue('damage')}
                                activeLabel="Raise Issue — damage"
                                raisedLabel="Issue raised for damage"
                              />
                            ) : null}
                            <Text style={{ color: tokens.mutedForeground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.xxs, textTransform: 'uppercase' }}>Evidence</Text>
                            <EvidenceBlock
                              evidence={ensureFieldEvidence('damageEvidence')}
                              onOpenNote={() => updateFieldEvidence('damageEvidence', { noteOpen: true })}
                              onChangeNote={(note) => updateFieldEvidence('damageEvidence', { note })}
                              onRecordAudio={() => updateFieldEvidence('damageEvidence', { audio: { durationSec: 20, playing: false, bars: generateWaveformBars() } })}
                              onToggleAudioPlay={() => {
                                const ev = ensureFieldEvidence('damageEvidence');
                                if (!ev.audio) return;
                                updateFieldEvidence('damageEvidence', { audio: { ...ev.audio, playing: !ev.audio.playing } });
                              }}
                              onRemoveAudio={() => updateFieldEvidence('damageEvidence', { audio: null })}
                              onAddImage={() => setAttachmentTarget('damage')}
                              onRemoveImage={(i) => updateFieldEvidence('damageEvidence', { images: ensureFieldEvidence('damageEvidence').images.filter((_, ii) => ii !== i) })}
                              onAddVideo={() => updateFieldEvidence('damageEvidence', { videos: [...ensureFieldEvidence('damageEvidence').videos, { durationSec: 20 }] })}
                              onRemoveVideo={(i) => updateFieldEvidence('damageEvidence', { videos: ensureFieldEvidence('damageEvidence').videos.filter((_, ii) => ii !== i) })}
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
              <Pressable
                disabled={pendingItem.origin === 'floor' && !pendingItem.pinnedAt}
                onPress={handleSaveAndScanNext}
                style={[styles.primaryBtn, { backgroundColor: tokens.primary, borderRadius: tokens.radius.lg, opacity: pendingItem.origin === 'floor' && !pendingItem.pinnedAt ? 0.5 : 1 }]}
              >
                <Text style={{ color: tokens.primaryForeground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm }}>Save & Scan Next</Text>
              </Pressable>
            </View>
          </Card>
        </View>
      ) : null}
      </View>

      {savedPrompt ? (
        <View style={styles.savedToastWrap} pointerEvents="none">
          <View style={[styles.savedToast, { backgroundColor: tokens.rag.green.strong }]}>
            <Ionicons name="checkmark-circle" size={16} color="#fff" />
            <Text style={{ color: '#fff', fontSize: tokens.text.sm, fontWeight: tokens.fontWeight.bold }}>{savedPrompt}</Text>
          </View>
        </View>
      ) : null}

      {scanPrompt ? (
        <Modal visible transparent animationType="fade" onRequestClose={() => setScanPrompt(null)}>
          <View style={styles.scanPromptBackdrop}>
            <View style={[styles.scanPromptCard, { backgroundColor: tokens.card, borderRadius: tokens.radius.xxl }]}>
              <View style={[styles.scanPromptIconWrap, { backgroundColor: tokens.rag.green.soft }]}>
                <Ionicons name="checkmark-circle" size={28} color={tokens.rag.green.strong} />
              </View>
              <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.extrabold, fontSize: tokens.text.base, textAlign: 'center' }}>{scanPrompt}</Text>
              <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xs, textAlign: 'center', marginTop: 4 }}>You can scan now</Text>
              <View style={styles.scanPromptActions}>
                <Pressable onPress={() => setScanPrompt(null)} style={[styles.outlineBtn, { flex: 1, borderColor: tokens.border, borderRadius: tokens.radius.lg }]}>
                  <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.semibold, fontSize: tokens.text.sm }}>Not Now</Text>
                </Pressable>
                <Pressable onPress={openScannerFromPrompt} style={[styles.primaryBtn, { flex: 1, backgroundColor: tokens.primary, borderRadius: tokens.radius.lg }]}>
                  <Text style={{ color: tokens.primaryForeground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm }}>Scan Now</Text>
                </Pressable>
              </View>
            </View>
          </View>
        </Modal>
      ) : null}

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
          const field = attachmentTarget === 'qty' ? 'qtyEvidence' : 'damageEvidence';
          updateFieldEvidence(field, { images: [...ensureFieldEvidence(field).images, image] });
        }}
      />
    </View>
  );
}

function ScannedSkuCard({ item, onViewLocation }: { item: ScannedSku; onViewLocation?: () => void }) {
  const { tokens } = useTheme();
  const hasExpectation = item.expectedZone !== null;
  const resolved = item.matched !== null;
  const tone = !resolved ? tokens.accentBlue : item.matched ? tokens.rag.green : tokens.rag.amber;
  const originLabel = item.origin === 'zone' ? 'Zone Find' : item.origin === 'rack' ? 'Rack Find' : 'Floor Find';
  const originIcon = item.origin === 'zone' ? 'apps-outline' : item.origin === 'rack' ? 'grid-outline' : 'cube-outline';
  // Quantity/damage start unset until the inspector deliberately enters
  // what they found (see the ScannedSku type above), so any saved record
  // may legitimately have neither — same null-guard the web app's
  // quickScanItemCard added.
  const anyIssueRaised = !!item.skuIssueRaised || !!item.qtyIssueRaised || !!item.damageIssueRaised;

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
        <Field label="Qty" value={item.qty != null ? String(item.qty) : '—'} />
        <Field label="Condition" value={item.condition ?? '—'} />
      </View>

      {/* Only a Floor-mode find ever has a manually-dropped pin worth
          recapping visually — Zone/Rack finds' location was already the
          canvas selection at scan time. */}
      {item.origin === 'floor' && item.pinnedAt && onViewLocation ? (
        <Pressable onPress={onViewLocation} style={[styles.outlineBtn, { borderColor: tokens.border, borderRadius: tokens.radius.lg, marginTop: 10 }]}>
          <Ionicons name="location-outline" size={16} color={tokens.foreground} />
          <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.semibold, fontSize: tokens.text.sm }}>View Location</Text>
        </Pressable>
      ) : null}

      {anyIssueRaised && item.pinnedZone ? (
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

// Read-only recap of exactly where a Floor-mode item's pin landed — the
// same floor-areas + layout/rack reference grid the live canvas shows
// (non-interactive here), with that one item's pin either highlighted (a
// named zone/rack) or marked (a freeform open-floor tap), instead of only
// the text fields already on the card.
function LocationViewModal({ item, layoutZones, onClose }: { item: ScannedSku; layoutZones: LayoutGroup[]; onClose: () => void }) {
  const { tokens } = useTheme();
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.locModalBackdrop}>
        <View style={[styles.locModalCard, { backgroundColor: tokens.card, borderRadius: tokens.radius.xxl }]}>
          <View style={[styles.locModalHead, { borderBottomColor: tokens.border }]}>
            <View style={{ flex: 1 }}>
              <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.extrabold, fontSize: tokens.text.base }}>Pinned Location</Text>
              <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xs }} numberOfLines={1}>
                {item.sku} · {item.name}
              </Text>
            </View>
            <Pressable onPress={onClose} hitSlop={8}>
              <Ionicons name="close" size={22} color={tokens.mutedForeground} />
            </Pressable>
          </View>
          <ScrollView style={{ maxHeight: 420 }} contentContainerStyle={{ padding: 14 }}>
            <View style={[styles.warehouseFloor, { borderColor: tokens.rag.amber.strong }]}>
              <View style={[styles.warehouseFloorLabel, { backgroundColor: tokens.card }]}>
                <Ionicons name="business-outline" size={11} color={tokens.rag.amber.strong} />
                <Text style={{ color: tokens.rag.amber.strong, fontWeight: tokens.fontWeight.bold, fontSize: 9, textTransform: 'uppercase', letterSpacing: 0.4 }}>
                  Warehouse Floor
                </Text>
              </View>

              <View style={styles.zoneRow}>
                {FLOOR_AREAS.map((zone) => {
                  const selected = item.pinnedFloorAreaId === zone.id;
                  return (
                    <View
                      key={zone.id}
                      style={[
                        styles.zoneCard,
                        { borderColor: selected ? '#1D4ED8' : tokens.border, borderWidth: selected ? 2.5 : 1.5, backgroundColor: selected ? '#BFDBFE' : tokens.card },
                      ]}
                    >
                      <Text style={{ color: selected ? '#1D4ED8' : tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm }}>{zone.label}</Text>
                    </View>
                  );
                })}
              </View>

              <View style={[styles.layoutGroupRow, { marginTop: 20 }]}>
                {layoutZones.map((ly) => {
                  const layoutSelected = !item.pinnedFloorAreaId && !item.pinnedPoint && item.pinnedZone === ly.layout && !item.pinnedRack;
                  return (
                    <View key={ly.layout} style={styles.layoutBlock}>
                      <Text style={{ color: layoutSelected ? '#1D4ED8' : tokens.slate400, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.xxs, marginBottom: 4 }}>
                        {zoneLabel(ly.layout)} {layoutSelected ? '· Pinned' : ''}
                      </Text>
                      <View style={styles.rackRow}>
                        {ly.racks.map((rackGroup) => {
                          const rackSelected = item.pinnedZone === ly.layout && item.pinnedRack === rackGroup.rack;
                          return (
                            <View
                              key={rackGroup.rack}
                              style={[
                                styles.rackCardDisabled,
                                { borderColor: rackSelected ? '#1D4ED8' : tokens.border, backgroundColor: rackSelected ? '#BFDBFE' : tokens.muted, borderWidth: rackSelected ? 2 : 1 },
                              ]}
                            >
                              <Text numberOfLines={1} style={{ color: rackSelected ? '#1D4ED8' : tokens.slate400, fontWeight: tokens.fontWeight.medium, fontSize: 8 }}>
                                Rack {rackGroup.rack}
                              </Text>
                              <View style={styles.bayRow}>
                                {rackGroup.bays.map((bayCell) => (
                                  <View key={bayCell.bay} style={[styles.baySeg, { borderColor: rackSelected ? '#1D4ED8' : tokens.border }]} />
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

              {item.pinnedPoint ? (
                <View pointerEvents="none" style={[styles.freeformPinWrap, { left: item.pinnedPoint.x - 14, top: item.pinnedPoint.y - 28 }]}>
                  <Ionicons name="location" size={28} color={tokens.rag.red.strong} />
                </View>
              ) : null}
            </View>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

// Selected Location Details row — same look as Rack View's own DetailRow
// (src/features/rack-view/RackViewScreen.tsx), duplicated rather than
// imported since this screen's Reconciliation Form is deliberately its own
// independently-maintainable set of pieces (only genuinely shared bits —
// EvidenceBlock, locLevelPosition, ACTIVITY_PHASES/OBSERVATIONS_BY_PHASE —
// are actually imported).
function QsDetailRow({ label, value }: { label: string; value: string }) {
  const { tokens } = useTheme();
  return (
    <View style={styles.detailRow}>
      <Text style={{ color: tokens.mutedForeground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.xxs, textTransform: 'uppercase', letterSpacing: 0.4 }}>{label}</Text>
      <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm, marginTop: 3 }}>{value}</Text>
    </View>
  );
}

// Raise Issue button — same red/green soft-fill pattern as Rack View's own
// (inlined 3x there rather than factored out, to match this codebase's
// "duplicated markup, shared where genuinely reusable" convention); this
// screen factors it out locally since it's reused 3x here too (misplaced,
// quantity, damage) and isn't shared across files either way.
function QsRaiseIssueButton({
  raised,
  disabled,
  onPress,
  activeLabel,
  raisedLabel,
  showHint,
}: {
  raised: boolean;
  disabled?: boolean;
  onPress: () => void;
  activeLabel: string;
  raisedLabel: string;
  showHint?: boolean;
}) {
  const { tokens } = useTheme();
  return (
    <Pressable
      disabled={disabled ?? raised}
      onPress={onPress}
      style={[
        styles.raiseIssueBox,
        {
          backgroundColor: raised ? tokens.rag.green.soft : tokens.rag.red.soft,
          borderColor: raised ? tokens.rag.green.border : tokens.rag.red.border,
          borderRadius: tokens.radius.lg,
        },
      ]}
    >
      <Ionicons name={raised ? 'checkmark-circle' : 'flag'} size={16} color={raised ? tokens.rag.green.strong : tokens.rag.red.strong} />
      <Text style={{ color: raised ? tokens.rag.green.strong : tokens.rag.red.strong, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.xs, flex: 1 }}>
        {raised ? raisedLabel : activeLabel}
      </Text>
      {showHint && !raised ? <Text style={{ color: tokens.rag.red.strong, fontWeight: tokens.fontWeight.semibold, fontSize: tokens.text.xs }}>Tap to raise</Text> : null}
    </Pressable>
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
  savedToastWrap: { position: 'absolute', top: 10, left: 0, right: 0, zIndex: 50, elevation: 50, alignItems: 'center' },
  savedToast: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, paddingVertical: 9, borderRadius: 20 },
  scanPromptBackdrop: { flex: 1, backgroundColor: 'rgba(15,23,42,0.5)', alignItems: 'center', justifyContent: 'center', padding: 20 },
  scanPromptCard: { width: '100%', maxWidth: 340, alignItems: 'center', padding: 22, gap: 4 },
  scanPromptIconWrap: { width: 52, height: 52, borderRadius: 26, alignItems: 'center', justifyContent: 'center', marginBottom: 6 },
  scanPromptActions: { flexDirection: 'row', gap: 10, marginTop: 16, width: '100%' },
  locModalBackdrop: { flex: 1, backgroundColor: 'rgba(15,23,42,0.5)', alignItems: 'center', justifyContent: 'center', padding: 20 },
  locModalCard: { width: '100%', maxWidth: 520, overflow: 'hidden' },
  locModalHead: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth },
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
  // Selected Location Details grid + divider, and the field-card's own
  // inline edit-in-place row/button — same styling as Rack View's
  // equivalents (src/features/rack-view/RackViewScreen.tsx), duplicated
  // here rather than shared (see QsDetailRow's own comment above).
  locDetailsBox: { flexDirection: 'row', flexWrap: 'wrap', rowGap: 12, columnGap: 16, marginBottom: 16 },
  divider: { height: StyleSheet.hairlineWidth, marginBottom: 16 },
  detailRow: { flexBasis: '28%', flexGrow: 1 },
  fieldValueRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  editIconBtn: { width: 26, height: 26, alignItems: 'center', justifyContent: 'center' },
  sectionLabel: { fontSize: 12, fontWeight: '700' },
  smallPrimaryBtn: { height: 40, paddingHorizontal: 14, alignItems: 'center', justifyContent: 'center' },
  canvasWrap: { flex: 1, padding: 16, position: 'relative' },
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
  cornerIconBtn: { width: 34, height: 34, alignItems: 'center', justifyContent: 'center', borderWidth: 1, position: 'relative' },
  readyDot: { position: 'absolute', top: -3, right: -3, width: 10, height: 10, borderRadius: 5, borderWidth: 1.5, borderColor: '#fff' },
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
