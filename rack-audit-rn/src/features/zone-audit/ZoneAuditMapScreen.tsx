import { Ionicons } from '@expo/vector-icons';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, BackHandler, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { AppHeader } from '@/components/AppHeader';
import { BarcodeScannerModal } from '@/components/BarcodeScannerModal';
import { Card } from '@/components/Card';
import { EvidenceBlock } from '@/components/EvidenceBlock';
import { NewAttachmentModal } from '@/components/NewAttachmentModal';
import type { SheetOption } from '@/components/BottomSheetPicker';
import { InlineDropdown, ToolbarField } from '@/components/ToolbarDropdownField';
import { useConfirmDialog } from '@/hooks/useConfirmDialog';
import { useAuditProgressMap } from '@/hooks/useLocationsTree';
import { expectedZoneForSku, FLOOR_AREAS, generateWaveformBars, INVENTORY_POOL, ZONE_EXPECTED_SKUS } from '@/lib/mockData';
import type { Evidence } from '@/lib/types';
import { useTheme } from '@/theme/ThemeProvider';
import { useAudits } from '../dashboard/hooks';
import { useZoneAuditStore } from '@/store/useZoneAuditStore';

const EMPTY_EVIDENCE: Evidence = { note: '', noteOpen: false, audio: null, images: [], videos: [] };

// One row per distinct SKU scanned into this zone this session — same
// scanLines/CountLine shape Rack View's Reconciliation Form uses (src/
// features/rack-view/RackViewScreen.tsx), just grouped by zone instead of
// by pallet location. Every physical box's QR carries its own unique
// label (a real print job never puts the exact same code on two different
// boxes) even though many boxes share the same SKU/name, so unitIds is
// the real count of distinct boxes found — re-scanning the same physical
// QR is refused as a duplicate (see applyZoneScan), never double-counted.
// Matched/Mismatched is derived per unit ID (lineMatched + isDuplicateUnit
// below) rather than stored — there's nothing to persist beyond the scan
// itself and whichever units got flagged for Damage.
type ZoneUnitDamage = { flagged: boolean; evidence: Evidence };
type ZoneCountLine = {
  sku: string;
  name: string;
  unitIds: string[];
  unitDamage: Record<string, ZoneUnitDamage>;
};
type BayCell = { layout: string; rack: string; bay: string };
type RackGroup = { rack: string; bays: BayCell[] };
type LayoutGroup = { layout: string; racks: RackGroup[] };

// A Zone-scoped audit (Audit.scope_type === 'Zone') works against the
// rack-less FLOOR_AREAS zones — no racks, no bays, no specific pallet to
// scan against an expected SKU. Same canvas+form split as Rack View, but
// the canvas is the whole warehouse's zone grid (this audit's scope_values
// highlighted, everything else grayed out and inert) instead of a bay
// diagram, and the form is an open-ended "log whatever SKUs turn up here"
// list instead of a per-pallet reconciliation against one expected SKU.
export function ZoneAuditMapScreen() {
  const { tokens } = useTheme();
  // zoneId: set when arriving from a specific zone pill (e.g. a SKU Wise
  // audit's Zone chip in Audit Details' SKU accordion), so the canvas lands
  // with that exact zone already highlighted instead of nothing selected.
  const { auditId, zoneId: zoneIdParam } = useLocalSearchParams<{ auditId: string; zoneId?: string }>();
  const { data: audits = [] } = useAudits();
  const audit = audits.find((a) => a.audit_id === auditId);
  const { map } = useAuditProgressMap(audits.map((a) => a.audit_id));

  const [selectedZoneId, setSelectedZoneId] = useState<string | null>(null);
  useEffect(() => {
    if (!zoneIdParam || !audit) return;
    const zone = FLOOR_AREAS.find((z) => z.id === zoneIdParam);
    if (!zone) return;
    const eligible =
      audit.scope_values.includes(zone.label) ||
      (audit.event_scope_type === 'SKU Wise' && (audit.sku_types ?? []).some((sku) => (ZONE_EXPECTED_SKUS[zone.label] ?? []).some((z2) => z2.sku === sku)));
    if (eligible) {
      setSelectedZoneId(zoneIdParam);
      // Same as tapping the zone on the canvas grid (pickZone) — opens the
      // Reconciliation Form straight away rather than landing on a bare
      // selected zone the inspector still has to tap into.
      setSkuPanelOpen(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-seed when the param or audit itself changes, not on every audit re-render
  }, [zoneIdParam, audit?.audit_id]);
  const [skuPanelOpen, setSkuPanelOpen] = useState(false);
  const [zoneField, setZoneField] = useState(false);
  const [scannedByZone, setScannedByZone] = useState<Record<string, ZoneCountLine[]>>({});
  // Whichever SKU line's accordion is expanded in the Reconciliation
  // Form — same activeLineIndex/openUnitIds split as Rack View: the SKU
  // row itself collapses/expands, and each unit's own Damage/Evidence
  // section opens independently within it.
  const [activeLineIndex, setActiveLineIndex] = useState(0);
  const [openUnitIds, setOpenUnitIds] = useState<Set<string>>(new Set());
  // Every box label already scanned in THIS zone this session, keyed by
  // zone id — a real pallet QR is "<sku>::<label>", so two different boxes
  // of the same SKU carry different labels and both count, while a repeat
  // of the same label is refused as a duplicate (see applyZoneScan).
  const [scannedLabelsByZone, setScannedLabelsByZone] = useState<Record<string, Set<string>>>({});
  // Skus to be scanned at selected zone — collapsible, starts open so the
  // pick list is the first thing an inspector sees on opening a zone.
  const [checklistOpen, setChecklistOpen] = useState(true);
  const setZoneScans = useZoneAuditStore((s) => s.setZoneScans);
  // Mirrors scan lines into the shared store on every change, flattened to
  // one record per physical box (unitId) — same grain Audit Details' zone
  // pick-list chips and Reported Audits' zone-issue cards already expect
  // (ZoneScanRecord), reached BEFORE this screen ever opens, or after
  // backing out of it (evidence objects stay screen-local, not mirrored).
  useEffect(() => {
    if (!auditId) return;
    Object.entries(scannedByZone).forEach(([zoneId, lines]) => {
      const scannedZoneLabel = FLOOR_AREAS.find((f) => f.id === zoneId)?.label ?? zoneId;
      setZoneScans(
        auditId,
        zoneId,
        lines.flatMap((line) =>
          line.unitIds.map((unitId) => ({
            sku: line.sku,
            name: line.name,
            label: unitId,
            qty: 1,
            condition: line.unitDamage[unitId]?.flagged ? 'Damaged' : 'Good',
            damageIssueRaised: !!line.unitDamage[unitId]?.flagged,
            expectedZone: expectedZoneForSku(line.sku),
            scannedZone: scannedZoneLabel,
          })),
        ),
      );
    });
  }, [auditId, scannedByZone, setZoneScans]);
  const [scannerOpen, setScannerOpen] = useState(false);
  // 'all' = the tabbed Scanned Records page (every zone, opened from the
  // top toolbar); 'zone' = the Reconciliation Form's own list, locked to
  // whichever zone is currently selected — no tab switching there, since
  // it's meant to answer "what have I found here", not "everywhere".
  const [listView, setListView] = useState<'all' | 'zone' | null>(null);
  const [skuScanCount, setSkuScanCount] = useState(0);
  const [duplicateLabel, setDuplicateLabel] = useState<string | null>(null);
  const [attachmentTarget, setAttachmentTarget] = useState<`unit:${string}` | null>(null);

  // Same confirm-before-leaving pattern as Rack View's Reconciliation Form
  // (src/features/rack-view/RackViewScreen.tsx) — every scan already lands
  // live in scannedByZone/the shared store the moment it's made (no
  // separate "Save" step the way a Rack View pallet record has one), so
  // this is just a single leave confirmation, not a two-branch pending/
  // not-pending ask.
  const confirm = useConfirmDialog();
  const skuPanelOpenRef = useRef(false);

  // Intercepts every way this screen can be left — the header's own back
  // arrow AND Android hardware/gesture back — not React Navigation's
  // `beforeRemove` (this screen is a hidden Tabs.Screen, which never fires
  // it — see PhoneTabsLayout.tsx), so router.back() + a direct BackHandler
  // listener is used instead, same as Rack View.
  const confirmBack = () => {
    if (skuPanelOpenRef.current) setSkuPanelOpen(false);
    confirm.ask('Save the SKUs you’ve scanned in this audit before going back?', () => {
      router.back();
    });
  };

  useFocusEffect(
    useCallback(() => {
      const sub = BackHandler.addEventListener('hardwareBackPress', () => {
        confirmBack();
        return true;
      });
      return () => sub.remove();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []),
  );

  // Same pinch-zoom-pan floor plan as Quick Scan's Pin Exact Location
  // (src/features/quick-scan/PinLocationScreen.tsx) — this canvas is that
  // same warehouse map, just showing every zone as a tappable card instead
  // of the rack/bay grid, since a Zone-scoped audit never drills below the
  // zone itself.
  const scale = useSharedValue(0.9);
  const savedScale = useSharedValue(0.9);
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

  // Same Layout/Rack/Bay grouping (+ filler padding) as Pin Exact Location
  // — shown here purely for spatial context, entirely disabled/grayed, so
  // an inspector can see how the racked part of the warehouse sits
  // relative to the zones without being tempted to tap into it (this
  // audit never drills below the zone itself).
  const layoutZones = useMemo(() => {
    const byLayout = new Map<string, Map<string, Map<string, BayCell>>>();
    audits.forEach((a) => {
      (map[a.audit_id]?.allLocations ?? []).forEach(({ layout, rack, bay }) => {
        if (!byLayout.has(layout)) byLayout.set(layout, new Map());
        const racks = byLayout.get(layout)!;
        if (!racks.has(rack)) racks.set(rack, new Map());
        const bays = racks.get(rack)!;
        if (!bays.has(bay)) bays.set(bay, { layout, rack, bay });
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

    return Array.from(byLayout.entries())
      .map(([layout, racks]): LayoutGroup => ({
        layout,
        racks: Array.from(racks.entries())
          .map(([rack, bays]) => ({ rack, bays: Array.from(bays.values()).sort((a, b) => a.bay.localeCompare(b.bay)) }))
          .sort((a, b) => a.rack.localeCompare(b.rack)),
      }))
      .sort((a, b) => a.layout.localeCompare(b.layout));
  }, [audits, map]);

  if (!audit) {
    return (
      <View style={[styles.loading, { backgroundColor: tokens.muted }]}>
        <ActivityIndicator color={tokens.primary} />
      </View>
    );
  }

  // A SKU Wise audit (e.g. AUD-0234) has no scope_values naming these
  // floor zones at all — its real zone coverage comes from wherever its own
  // sku_types are on a zone's expected pick list (ZONE_EXPECTED_SKUS).
  const inScope = (label: string) =>
    audit.scope_values.includes(label) ||
    (audit.event_scope_type === 'SKU Wise' && (audit.sku_types ?? []).some((sku) => (ZONE_EXPECTED_SKUS[label] ?? []).some((z) => z.sku === sku)));
  const selectedZone = selectedZoneId ? FLOOR_AREAS.find((z) => z.id === selectedZoneId) : null;
  const zoneOptions: SheetOption[] = FLOOR_AREAS.filter((z) => inScope(z.label)).map((z) => ({ value: z.id, label: z.label }));
  // Combined total across every zone this audit covers (e.g. Zone A +
  // Staging Area) — every physical box scanned, not just distinct SKU
  // rows — badges the toolbar's "all zones" list icon and drives the
  // Scanned Records page's own combined line.
  const allZonesTotal = zoneOptions.reduce(
    (sum, opt) => sum + (scannedByZone[opt.value] ?? []).reduce((s, l) => s + l.unitIds.length, 0),
    0,
  );
  const allZonesLabel = zoneOptions.map((opt) => opt.label).join(' + ');
  // Total distinct boxes scanned in one zone (not SKU rows) — used for the
  // "Scanned SKUS: NN" counter, the zone tab dots, and the list headers.
  const zoneUnitCount = (id: string) => (scannedByZone[id] ?? []).reduce((s, l) => s + l.unitIds.length, 0);

  const pickZone = (id: string) => {
    const zone = FLOOR_AREAS.find((z) => z.id === id);
    if (!zone || !inScope(zone.label)) return;
    setSelectedZoneId(id);
    setSkuPanelOpen(true);
    setActiveLineIndex(0);
    setOpenUnitIds(new Set());
    setZoneField(false);
  };

  // Switching the list page's zone tab shouldn't reopen the scan panel or
  // clear an in-progress draft the way picking a zone on the canvas does —
  // it's just changing which zone's already-saved records are on screen.
  const pickListZone = (id: string) => {
    const zone = FLOOR_AREAS.find((z) => z.id === id);
    if (!zone || !inScope(zone.label)) return;
    setSelectedZoneId(id);
  };

  const zoneScans = selectedZoneId ? (scannedByZone[selectedZoneId] ?? []) : [];
  const activeLine = zoneScans[activeLineIndex] ?? null;

  // Same scanLines-driven multi-SKU flow as Rack View's Reconciliation Form
  // (applyMultiSkuScan) — a scan only ever proves identity: a new SKU adds
  // a new accordion row, a SKU already open in this zone just gets another
  // unit ID appended to its existing row. A real pallet QR is
  // "<sku>::<unique label>"; a code with no "::" (an older single-sku
  // code) falls back to the raw scanned text as its own label.
  const applyZoneScan = (raw: string) => {
    if (!selectedZoneId) return;
    const trimmed = raw.trim();
    const [skuCode, labelPart] = trimmed.includes('::') ? trimmed.split('::') : [trimmed, trimmed];
    // Catch the re-scan at intake, before it ever reaches the zone's list —
    // a duplicate never gets a chance to inflate a count, it's just
    // refused with a way to retry.
    const labelsHere = scannedLabelsByZone[selectedZoneId] ?? new Set<string>();
    if (labelsHere.has(labelPart)) {
      setDuplicateLabel(labelPart);
      return;
    }
    const pick = INVENTORY_POOL.find((p) => p.sku === skuCode) ?? { sku: skuCode, name: 'Unlisted SKU' };
    setScannedLabelsByZone((prev) => ({ ...prev, [selectedZoneId]: new Set(labelsHere).add(labelPart) }));
    setScannedByZone((prev) => {
      const lines = prev[selectedZoneId] ?? [];
      const idx = lines.findIndex((l) => l.sku === pick.sku);
      let nextLines: ZoneCountLine[];
      let landedIndex: number;
      if (idx !== -1) {
        nextLines = lines.slice();
        nextLines[idx] = { ...nextLines[idx], unitIds: [...nextLines[idx].unitIds, labelPart] };
        landedIndex = idx;
      } else {
        nextLines = [...lines, { sku: pick.sku, name: pick.name, unitIds: [labelPart], unitDamage: {} }];
        landedIndex = nextLines.length - 1;
      }
      setActiveLineIndex(landedIndex);
      setOpenUnitIds(new Set());
      return { ...prev, [selectedZoneId]: nextLines };
    });
  };
  const handleScanned = (data: string) => {
    setScannerOpen(false);
    applyZoneScan(data);
  };
  const handleSimulated = () => {
    setScannerOpen(false);
    // Mostly scans one of this zone's own expected SKUs (so the demo
    // mostly comes back Matched) instead of the whole inventory pool.
    const zoneSkus = selectedZone ? (ZONE_EXPECTED_SKUS[selectedZone.label] ?? []) : [];
    const pick = zoneSkus.length ? zoneSkus[skuScanCount % zoneSkus.length] : INVENTORY_POOL[skuScanCount % INVENTORY_POOL.length];
    applyZoneScan(`${pick.sku}::SIM-${skuScanCount}`);
    setSkuScanCount((c) => c + 1);
  };

  // Per-Inventory-Unit-ID damage — same replacement for the old Activity
  // Phase/Observation flow Rack View's Reconciliation Form uses
  // (toggleUnitDamage). Flagging any one unit auto-opens that unit's own
  // Evidence section; switching it back off collapses it again.
  const toggleUnitDamage = (unitId: string) => {
    if (!selectedZoneId || !activeLine) return;
    const current = activeLine.unitDamage[unitId];
    const nextFlagged = !current?.flagged;
    setScannedByZone((prev) => {
      const lines = prev[selectedZoneId] ?? [];
      const nextLines = lines.slice();
      nextLines[activeLineIndex] = {
        ...activeLine,
        unitDamage: { ...activeLine.unitDamage, [unitId]: { flagged: nextFlagged, evidence: current?.evidence ?? EMPTY_EVIDENCE } },
      };
      return { ...prev, [selectedZoneId]: nextLines };
    });
    setOpenUnitIds((prev) => {
      const next = new Set(prev);
      if (nextFlagged) next.add(unitId);
      else next.delete(unitId);
      return next;
    });
  };

  const toggleUnitOpen = (unitId: string) => {
    setOpenUnitIds((prev) => {
      const next = new Set(prev);
      if (next.has(unitId)) next.delete(unitId);
      else next.add(unitId);
      return next;
    });
  };

  const updateUnitEvidence = (unitId: string, patch: Partial<Evidence>) => {
    if (!selectedZoneId || !activeLine) return;
    const current = activeLine.unitDamage[unitId] ?? { flagged: true, evidence: EMPTY_EVIDENCE };
    setScannedByZone((prev) => {
      const lines = prev[selectedZoneId] ?? [];
      const nextLines = lines.slice();
      nextLines[activeLineIndex] = {
        ...activeLine,
        unitDamage: { ...activeLine.unitDamage, [unitId]: { ...current, evidence: { ...current.evidence, ...patch } } },
      };
      return { ...prev, [selectedZoneId]: nextLines };
    });
  };

  // A unit reads Mismatched either because its SKU isn't on THIS zone's
  // own expected pick list (lineMatched), or — even for the right SKU —
  // because this exact physical Inventory Unit ID already turned up in a
  // DIFFERENT zone earlier in the audit: the same real-world box can't
  // legitimately be in two zones, so finding its label again elsewhere is
  // itself a mismatch, not just a re-scan of the same box.
  const isDuplicateUnit = (unitId: string): boolean =>
    Object.entries(scannedByZone).some(([zid, lines]) => zid !== selectedZoneId && lines.some((l) => l.unitIds.includes(unitId)));

  // A full page, not a modal sheet — a zone can genuinely rack up a long
  // scan history, and a cramped sheet doesn't give that room to breathe.
  // Back arrow just returns to the canvas+form, same list state intact.
  if (listView && selectedZone) {
    // The scanner doesn't need to know a pick list exists — they just scan
    // whatever's sitting in the open zone. So the list page leads with
    // "what did we actually find here", one card per physical box (i.e.
    // per unique label) rather than rolled up by SKU — 3 boxes of the same
    // SKU is 3 cards, not one card saying "Found: 3". Match/mismatch is
    // worked out automatically per SKU from expectedZoneForSku, not
    // something the user has to know going in. Re-scans are refused at
    // intake (see handleScanned's "Already Scanned" prompt), so every
    // label here is a genuinely distinct box.
    const foundBoxes = zoneScans.flatMap((line) =>
      line.unitIds.map((unitId) => {
        const homeZone = expectedZoneForSku(line.sku);
        const isUnlisted = !INVENTORY_POOL.some((p) => p.sku === line.sku);
        const group: 'Matched' | 'Mismatched' | 'Unlisted' | 'No Record' =
          homeZone === selectedZone.label ? 'Matched' : homeZone ? 'Mismatched' : isUnlisted ? 'Unlisted' : 'No Record';
        const badge =
          group === 'Matched'
            ? { label: 'Matched', ragKey: 'green' as const }
            : group === 'Mismatched'
              ? { label: 'Mismatch', ragKey: 'red' as const }
              : group === 'Unlisted'
                ? { label: 'Unlisted', ragKey: 'amber' as const }
                : { label: 'No Record', ragKey: 'amber' as const };
        const tag = group === 'Matched' ? 'Belongs Here' : homeZone ? `Belongs in ${homeZone}` : isUnlisted ? 'Unlisted SKU' : 'No Expectation on Record';
        const condition = line.unitDamage[unitId]?.flagged ? 'Damaged' : 'Good';
        return { sku: line.sku, name: line.name, label: unitId, condition, homeZone, group, badge, tag, damageEntered: !!line.unitDamage[unitId] };
      }),
    );
    const skuGroups: { title: string; ragKey: 'green' | 'amber' | 'red'; rows: typeof foundBoxes }[] = [
      { title: 'Matched SKUs', ragKey: 'green', rows: foundBoxes.filter((s) => s.group === 'Matched') },
      { title: 'Mismatched SKUs', ragKey: 'red', rows: foundBoxes.filter((s) => s.group === 'Mismatched') },
      { title: 'Unlisted SKUs', ragKey: 'amber', rows: foundBoxes.filter((s) => s.group === 'Unlisted') },
      { title: 'No Record SKUs', ragKey: 'amber', rows: foundBoxes.filter((s) => s.group === 'No Record') },
    ];

    return (
      <View style={{ flex: 1, backgroundColor: tokens.muted }}>
        {listView === 'all' ? (
          <AppHeader
            title="Scanned Records"
            sub={`${allZonesTotal} total scan${allZonesTotal === 1 ? '' : 's'} across ${allZonesLabel}`}
            showBack
            onBack={() => setListView(null)}
          />
        ) : (
          <AppHeader
            title={`Scanned in ${selectedZone.label}`}
            sub={`${zoneUnitCount(selectedZoneId ?? '')} scan${zoneUnitCount(selectedZoneId ?? '') === 1 ? '' : 's'} in this zone`}
            showBack
            onBack={() => setListView(null)}
          />
        )}

        {listView === 'all' ? (
          <>
            {/* One tab per zone this audit actually covers — each zone's
                scans are kept and shown fully separately, never merged
                together. Only reachable from the toolbar's list icon —
                the Reconciliation Form's own list has no tabs, since it's
                locked to whichever zone is currently selected. */}
            <View style={[styles.zoneTabRow, { backgroundColor: tokens.card, borderBottomColor: tokens.border }]}>
              {zoneOptions.map((opt) => {
                const active = opt.value === selectedZoneId;
                const zoneCount = zoneUnitCount(opt.value);
                return (
                  <Pressable
                    key={opt.value}
                    onPress={() => pickListZone(opt.value)}
                    style={[styles.zoneTab, active ? { borderBottomColor: tokens.primary } : { borderBottomColor: 'transparent' }]}
                  >
                    <Text style={{ color: active ? tokens.primary : tokens.mutedForeground, fontWeight: active ? tokens.fontWeight.bold : tokens.fontWeight.semibold, fontSize: tokens.text.sm }}>
                      {opt.label}
                    </Text>
                    {zoneCount ? (
                      <View style={[styles.zoneTabDot, { backgroundColor: active ? tokens.primary : tokens.mutedForeground }]}>
                        <Text style={{ color: tokens.primaryForeground, fontSize: 9, fontWeight: tokens.fontWeight.bold }}>{zoneCount}</Text>
                      </View>
                    ) : null}
                  </Pressable>
                );
              })}
            </View>

            {/* This line is the combined figure across every zone — per-zone
                detail belongs on the Reconciliation Form (its Scanned List
                badge is always the selected zone's own count only), so the
                two screens never show numbers that look like they disagree. */}
            <View style={[styles.zoneSummaryBanner, { backgroundColor: tokens.card, borderBottomColor: tokens.border }]}>
              <Text style={{ color: tokens.foreground, fontSize: tokens.text.sm }}>
                Combined:{' '}
                <Text style={{ fontWeight: tokens.fontWeight.extrabold, color: tokens.primary }}>{allZonesTotal}</Text>
                {' '}scan{allZonesTotal === 1 ? '' : 's'} across <Text style={{ fontWeight: tokens.fontWeight.bold }}>{allZonesLabel}</Text>
              </Text>
            </View>
          </>
        ) : null}

        <ScrollView contentContainerStyle={styles.listPageBody}>
          {foundBoxes.length ? (
            <View style={{ gap: 20 }}>
              {skuGroups.map((group) =>
                group.rows.length ? (
                  <View key={group.title} style={{ gap: 8 }}>
                    <View style={styles.groupHeadRow}>
                      <Text style={[styles.groupLabel, { color: tokens.mutedForeground }]}>{group.title}</Text>
                      <StatusBadge label={String(group.rows.length)} ragKey={group.ragKey} compact />
                    </View>
                    <View style={styles.cardGrid}>
                      {group.rows.map((s) => (
                        <View key={`${s.sku}-${s.label}`} style={[styles.miniCard, { backgroundColor: tokens.card, borderColor: tokens.border, borderRadius: tokens.radius.lg }]}>
                          <View style={[styles.miniHeadRow, { backgroundColor: '#EEF3FF', borderTopLeftRadius: tokens.radius.lg, borderTopRightRadius: tokens.radius.lg }]}>
                            <View style={styles.miniHeadLeft}>
                              <Ionicons name={s.group === 'Matched' ? 'checkmark-circle-outline' : s.group === 'Mismatched' ? 'swap-horizontal-outline' : 'help-circle-outline'} size={12} color={tokens.primary} />
                              <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.xs }} numberOfLines={1}>{s.sku}</Text>
                            </View>
                            <StatusBadge label={s.badge.label} ragKey={s.badge.ragKey} compact />
                          </View>
                          {/* No Record means the catalog has nothing to say about
                              this SKU beyond its number — so the card doesn't
                              pretend otherwise with a name line. Damage only
                              appears if the inspector actually flagged it. */}
                          {s.group === 'No Record' ? (
                            s.damageEntered ? (
                              <View style={styles.miniBody}>
                                <View style={styles.miniGrid}>
                                  <MiniField label="Damage" value={s.condition} tone={tokens.rag.amber.strong} />
                                </View>
                              </View>
                            ) : null
                          ) : (
                            <View style={styles.miniBody}>
                              <Text style={{ color: tokens.accentBlue.strong, fontWeight: tokens.fontWeight.semibold, fontSize: tokens.text.xxs, marginBottom: 6 }} numberOfLines={1}>
                                {s.name}
                              </Text>
                              <View style={styles.miniGrid}>
                                <MiniField label="Box" value={s.label} />
                                <MiniField label="Condition" value={s.condition} />
                              </View>
                              {s.group === 'Mismatched' ? (
                                <View style={[styles.miniLocationRow, { borderTopColor: tokens.border }]}>
                                  <MiniField label="Location" value={`Belongs in ${s.homeZone}`} tone={tokens.rag.red.strong} />
                                </View>
                              ) : null}
                            </View>
                          )}
                        </View>
                      ))}
                    </View>
                  </View>
                ) : null
              )}
            </View>
          ) : null}

          {!foundBoxes.length ? (
            <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.sm, textAlign: 'center', paddingVertical: 20 }}>Nothing scanned here yet.</Text>
          ) : null}
        </ScrollView>
      </View>
    );
  }

  // Kept in sync every render so leaving this screen any way (header back
  // arrow, hardware/gesture back) closes the split view back down to
  // canvas-only before asking to confirm.
  skuPanelOpenRef.current = skuPanelOpen;

  return (
    <View style={{ flex: 1, backgroundColor: tokens.muted }}>
      <AppHeader title="Zone Scan" sub={`${audit.audit_id} · ${audit.audit_name}`} showBack onBack={confirmBack} />

      <View style={[styles.toolbar, { backgroundColor: tokens.card, borderBottomColor: tokens.border, justifyContent: 'space-between' }]}>
        <View>
          <ToolbarField label={selectedZone ? selectedZone.label : 'Select Zone'} open={zoneField} onPress={() => setZoneField((v) => !v)} />
          {zoneField ? (
            <>
              <Pressable style={StyleSheet.absoluteFill} onPress={() => setZoneField(false)} />
              <InlineDropdown options={zoneOptions} selectedValue={selectedZoneId ?? ''} onSelect={pickZone} />
            </>
          ) : null}
        </View>

        {/* Entry point for the tabbed, all-zones Scanned Records page —
            lives up here next to the zone picker rather than inside the
            Reconciliation Form, since it's about the whole audit, not
            just whichever zone the form currently has open. */}
        <Pressable
          onPress={() => {
            if (!selectedZoneId && zoneOptions[0]) setSelectedZoneId(zoneOptions[0].value);
            setListView('all');
          }}
          hitSlop={8}
          style={[styles.listIconBtn, { backgroundColor: tokens.card, borderColor: tokens.border, borderRadius: tokens.radius.lg }]}
        >
          <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.semibold, fontSize: tokens.text.xs }}>Scanned Records</Text>
          <View style={{ position: 'relative' }}>
            <Ionicons name="list-outline" size={16} color={tokens.foreground} />
            {allZonesTotal ? (
              <View style={[styles.listCountDot, { backgroundColor: tokens.primary }]}>
                <Text style={{ color: tokens.primaryForeground, fontSize: 9, fontWeight: tokens.fontWeight.bold }}>{allZonesTotal}</Text>
              </View>
            ) : null}
          </View>
        </Pressable>
      </View>

      <View style={styles.body}>
        <View style={skuPanelOpen ? styles.splitRow : styles.singleRow}>
          <Card style={{ padding: 0, overflow: 'hidden', flex: skuPanelOpen ? 1 : 1 }}>
            <View style={[styles.canvasHead, { backgroundColor: '#F7F8FA', borderBottomColor: tokens.border }]}>
              <Ionicons name="location-outline" size={13} color={tokens.mutedForeground} />
              <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xxs }}>
                Whole warehouse — {audit.scope_values.length} of {FLOOR_AREAS.length} zones in scope for this audit
              </Text>
            </View>
            <View style={styles.stage}>
              <GestureDetector gesture={floorGesture}>
                <View style={styles.stageCenter}>
                  <Animated.View style={floorAnimatedStyle}>
                    <View style={styles.planCanvas}>
                      <View style={styles.zoneHeadRow}>
                        <Text
                          style={{
                            color: tokens.mutedForeground,
                            fontWeight: tokens.fontWeight.bold,
                            fontSize: tokens.text.xxs,
                            textTransform: 'uppercase',
                            letterSpacing: 0.4,
                          }}
                        >
                          Zones
                        </Text>
                      </View>
                      <View style={styles.zoneRow}>
                        {FLOOR_AREAS.map((zone) => {
                          const active = inScope(zone.label);
                          const selected = selectedZoneId === zone.id;
                          const count = zoneUnitCount(zone.id);
                          return (
                            <Pressable
                              key={zone.id}
                              disabled={!active}
                              onPress={() => pickZone(zone.id)}
                              style={[
                                styles.zoneCard,
                                {
                                  borderColor: selected ? '#1D4ED8' : tokens.border,
                                  borderWidth: selected ? 2.5 : 1.5,
                                  backgroundColor: selected ? '#BFDBFE' : active ? tokens.card : tokens.muted,
                                  opacity: active ? 1 : 0.4,
                                },
                              ]}
                            >
                              <Text
                                style={{
                                  color: selected ? '#1D4ED8' : active ? tokens.foreground : tokens.mutedForeground,
                                  fontWeight: tokens.fontWeight.bold,
                                  fontSize: tokens.text.sm,
                                }}
                              >
                                {zone.label}
                              </Text>
                              {active ? (
                                <View style={[styles.scanCountBadge, { backgroundColor: count ? tokens.rag.green.soft : tokens.muted }]}>
                                  <Ionicons name="scan-outline" size={11} color={count ? tokens.rag.green.strong : tokens.mutedForeground} />
                                  <Text style={{ color: count ? tokens.rag.green.strong : tokens.mutedForeground, fontSize: tokens.text.xxs, fontWeight: tokens.fontWeight.bold }}>
                                    {count} scanned
                                  </Text>
                                </View>
                              ) : null}
                            </Pressable>
                          );
                        })}
                      </View>

                      {/* Racked part of the warehouse, for spatial context
                          only — every rack shown fully grayed out and
                          non-interactive, since this audit never drills
                          below a zone. */}
                      <View style={[styles.zoneHeadRow, { marginTop: 24 }]}>
                        <Ionicons name="grid-outline" size={12} color={tokens.mutedForeground} />
                        <Text
                          style={{
                            color: tokens.mutedForeground,
                            fontWeight: tokens.fontWeight.bold,
                            fontSize: tokens.text.xxs,
                            textTransform: 'uppercase',
                            letterSpacing: 0.4,
                          }}
                        >
                          Racks (reference only)
                        </Text>
                      </View>
                      <View style={styles.layoutGroupRow}>
                        {layoutZones.map((ly) => (
                          <View key={ly.layout} style={styles.layoutBlock}>
                            <Text style={{ color: tokens.mutedForeground, fontWeight: tokens.fontWeight.semibold, fontSize: tokens.text.xxs, marginBottom: 4 }}>
                              {ly.layout}
                            </Text>
                            <View style={styles.rackRow}>
                              {ly.racks.map((rackGroup) => (
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
                              ))}
                            </View>
                          </View>
                        ))}
                      </View>
                    </View>
                  </Animated.View>
                </View>
              </GestureDetector>
            </View>
          </Card>

          {skuPanelOpen && selectedZone ? (
            // Same skuPanel structure as Rack View's Reconciliation Form —
            // Card keeps its default padding, the header bleeds out to the
            // edges via negative margins instead of the Card being
            // overflow-hidden with its own padding stripped out.
            <Card style={styles.skuPanel}>
              <View
                style={[
                  styles.skuPanelHead,
                  { backgroundColor: '#F7F8FA', borderBottomColor: tokens.border, borderTopLeftRadius: tokens.radius.xxl, borderTopRightRadius: tokens.radius.xxl },
                ]}
              >
                <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm }}>Reconciliation Form</Text>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <Pressable onPress={() => setListView('zone')} hitSlop={8} style={[styles.listIconBtn, { backgroundColor: tokens.card, borderColor: tokens.border, borderRadius: tokens.radius.lg }]}>
                    <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.semibold, fontSize: tokens.text.xs }}>Scanned List</Text>
                    <View style={{ position: 'relative' }}>
                      <Ionicons name="list-outline" size={16} color={tokens.foreground} />
                      {zoneUnitCount(selectedZoneId ?? '') ? (
                        <View style={[styles.listCountDot, { backgroundColor: tokens.primary }]}>
                          <Text style={{ color: tokens.primaryForeground, fontSize: 9, fontWeight: tokens.fontWeight.bold }}>{zoneUnitCount(selectedZoneId ?? '')}</Text>
                        </View>
                      ) : null}
                    </View>
                  </Pressable>
                  {/* The one way to scan — the dashed box further down is
                      just an instructional note pointing at this icon,
                      same as Rack View's Reconciliation Form. */}
                  <Pressable
                    onPress={() => setScannerOpen(true)}
                    hitSlop={8}
                    style={({ pressed }) => [
                      styles.headerScanBtn,
                      { backgroundColor: pressed ? tokens.primary : tokens.muted, borderColor: pressed ? tokens.primary : tokens.border, borderRadius: tokens.radius.lg },
                    ]}
                  >
                    {({ pressed }) => <Ionicons name="qr-code-outline" size={16} color={pressed ? tokens.primaryForeground : tokens.foreground} />}
                  </Pressable>
                </View>
              </View>

              {/* Same "Selected Location Details" block as Rack View —
                  inline Label: Value rows, just one field here since a
                  zone (unlike a rack pallet) has no bay/pallet identity of
                  its own. Lives outside the ScrollView, same as Rack View,
                  so it stays visible whether or not a box is being scanned. */}
              <Text style={{ color: tokens.mutedForeground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.xxs, textTransform: 'uppercase', marginBottom: 8 }}>
                Selected Location Details
              </Text>
              <View style={styles.locDetailsBox}>
                <DetailRow label="Zone" value={selectedZone.label} tokens={tokens} />
              </View>
              <View style={[styles.divider, { backgroundColor: tokens.border }]} />

              {/* Skus to be scanned at selected zone — the zone's own pick
                  list (ZONE_EXPECTED_SKUS), collapsible, Total badge in the
                  header. Not present anywhere before this — Rack View's own
                  Reconciliation Form only uses its expected list internally
                  for Matched/Mismatched, it never renders it as a
                  checklist. */}
              <Pressable onPress={() => setChecklistOpen((v) => !v)} style={[styles.checklistCard, { backgroundColor: tokens.card, borderColor: tokens.border, borderRadius: tokens.radius.xl }]}>
                <View style={styles.checklistHead}>
                  <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm, flex: 1 }}>
                    Skus to be scanned at selected zone
                  </Text>
                  <View style={[styles.scanCountBadge, { backgroundColor: tokens.muted, marginTop: 0 }]}>
                    <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.xxs }}>
                      Total: {(ZONE_EXPECTED_SKUS[selectedZone.label] ?? []).length}
                    </Text>
                  </View>
                  <Ionicons name={checklistOpen ? 'chevron-up' : 'chevron-down'} size={16} color={tokens.mutedForeground} />
                </View>
                {checklistOpen ? (
                  <View style={styles.checklistBody}>
                    {(ZONE_EXPECTED_SKUS[selectedZone.label] ?? []).map((exp) => {
                      const foundUnits = zoneScans.find((l) => l.sku === exp.sku)?.unitIds.length ?? 0;
                      const done = foundUnits >= exp.expectedCount;
                      return (
                        <View key={exp.sku} style={styles.checklistRow}>
                          <Ionicons name={done ? 'checkmark-circle' : 'ellipse-outline'} size={16} color={done ? tokens.rag.green.strong : tokens.mutedForeground} />
                          <View style={{ flex: 1 }}>
                            <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.semibold, fontSize: tokens.text.xs }}>{exp.sku}</Text>
                            <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xxs }} numberOfLines={1}>{exp.name}</Text>
                          </View>
                          <Text style={{ color: done ? tokens.rag.green.strong : tokens.mutedForeground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.xs }}>
                            {foundUnits}/{exp.expectedCount}
                          </Text>
                        </View>
                      );
                    })}
                    {!(ZONE_EXPECTED_SKUS[selectedZone.label] ?? []).length ? (
                      <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xs }}>No SKUs on record for this zone.</Text>
                    ) : null}
                  </View>
                ) : null}
              </Pressable>

              <ScrollView style={{ flex: 1 }} contentContainerStyle={{ flexGrow: 1, gap: 10, paddingTop: 10, paddingBottom: 10 }}>
                {!zoneScans.length ? (
                  // Instructional note pointing at the header's scan icon —
                  // same copy/box as Rack View's Reconciliation Form.
                  <View style={[styles.scanNoteBox, { backgroundColor: tokens.accentBlue.soft, borderColor: tokens.accentBlue.border, borderRadius: tokens.radius.xl }]}>
                    <View style={[styles.scanNoteIconWrap, { backgroundColor: tokens.card, borderColor: tokens.accentBlue.border }]}>
                      <Ionicons name="qr-code-outline" size={20} color={tokens.accentBlue.strong} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={{ color: tokens.accentBlue.strong, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm }}>Scan to Continue</Text>
                      <Text style={{ color: tokens.accentBlue.strong, fontSize: tokens.text.xs, lineHeight: 17, marginTop: 3, opacity: 0.9 }}>
                        Tap the scan icon above to scan the SKU.
                      </Text>
                    </View>
                  </View>
                ) : null}

                {zoneScans.length ? (
                  <View style={styles.scanCountRow}>
                    <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm }}>Scanned SKUS:</Text>
                    <View style={[styles.scanCountBadge, { backgroundColor: tokens.muted }]}>
                      <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm }}>
                        {String(zoneUnitCount(selectedZoneId ?? '')).padStart(2, '0')}
                      </Text>
                    </View>
                  </View>
                ) : null}

                {zoneScans.length ? (
                  // Every distinct SKU scanned into this zone so far — a
                  // true accordion, one open at a time — same pattern as
                  // Rack View's own Scanned SKUs list.
                  <View style={styles.scannedListWrap}>
                    {zoneScans.map((line, i) => {
                      const isActive = i === activeLineIndex;
                      const lineMatched = (ZONE_EXPECTED_SKUS[selectedZone.label] ?? []).some((e) => e.sku === line.sku);
                      return (
                        <View key={`${line.sku}-${i}`}>
                          <Pressable
                            onPress={() => {
                              setActiveLineIndex((prev) => (prev === i ? -1 : i));
                              setOpenUnitIds(new Set());
                            }}
                            style={[
                              styles.scannedRow,
                              {
                                backgroundColor: tokens.card,
                                borderColor: tokens.border,
                                borderRadius: isActive ? 0 : tokens.radius.lg,
                                borderTopLeftRadius: tokens.radius.lg,
                                borderTopRightRadius: tokens.radius.lg,
                                borderBottomWidth: isActive ? 0 : 1,
                              },
                            ]}
                          >
                            <View style={{ flex: 1 }}>
                              <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm }}>{line.sku}</Text>
                              <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xs, marginTop: 1 }}>{line.name}</Text>
                            </View>
                            <View
                              style={[
                                styles.editStatusPill,
                                { backgroundColor: lineMatched ? tokens.rag.green.soft : tokens.rag.amber.soft, borderColor: lineMatched ? tokens.rag.green.border : tokens.rag.amber.border, borderRadius: tokens.radius.lg },
                              ]}
                            >
                              <Text style={{ color: lineMatched ? tokens.rag.green.strong : tokens.rag.amber.strong, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.xs }}>
                                {lineMatched ? 'Matched' : 'Mismatched'}
                              </Text>
                            </View>
                            <View style={[styles.scanCountBadge, { backgroundColor: tokens.accentBlue.soft, marginTop: 0, minWidth: 0, paddingHorizontal: 10 }]}>
                              <Text style={{ color: tokens.accentBlue.strong, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm }}>
                                {String(line.unitIds.length).padStart(2, '0')}
                              </Text>
                            </View>
                            <Ionicons name={isActive ? 'chevron-up' : 'chevron-down'} size={16} color={tokens.mutedForeground} />
                          </Pressable>

                          {isActive ? (
                            <View style={[styles.accordionBody, { backgroundColor: tokens.card, borderColor: tokens.border, borderRadius: tokens.radius.lg }]}>
                              <View style={[styles.fieldCard, { backgroundColor: tokens.card, borderColor: tokens.border, borderRadius: tokens.radius.xl }]}>
                                <View style={[styles.fieldCardHead, { backgroundColor: '#F7F8FA', borderBottomColor: tokens.border, borderBottomWidth: 1 }]}>
                                  <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm }}>Inventory Unit IDs</Text>
                                </View>
                                <View style={styles.fieldCardBody}>
                                  {/* One row per physical box scanned onto this SKU (unitIds), not one
                                      section for the whole line. Matched requires both the right SKU
                                      (lineMatched) AND this exact physical unit ID not already sitting
                                      in a DIFFERENT zone this audit — a duplicate label showing up
                                      elsewhere is itself a mismatch. Damage is tracked per unit too. */}
                                  {line.unitIds.map((unitId, ui) => {
                                    const unitFlagged = !!line.unitDamage[unitId]?.flagged;
                                    const unitOpen = openUnitIds.has(unitId);
                                    const unitEvidence = line.unitDamage[unitId]?.evidence ?? EMPTY_EVIDENCE;
                                    const unitMatched = lineMatched && !isDuplicateUnit(unitId);
                                    return (
                                      <View key={unitId} style={ui > 0 ? [styles.unitDivider, { borderTopColor: tokens.border }] : null}>
                                        <View style={styles.unitRow}>
                                          <Text style={{ color: tokens.foreground, fontSize: tokens.text.sm, flex: 1 }}>
                                            <Text style={{ fontWeight: tokens.fontWeight.bold }}>{ui + 1}.</Text> Inventory unit ID : <Text style={{ fontWeight: tokens.fontWeight.bold }}>{unitId}</Text>
                                          </Text>
                                          <View
                                            style={[
                                              styles.editStatusPill,
                                              { backgroundColor: unitMatched ? tokens.rag.green.soft : tokens.rag.amber.soft, borderColor: unitMatched ? tokens.rag.green.border : tokens.rag.amber.border, borderRadius: tokens.radius.lg },
                                            ]}
                                          >
                                            <Text style={{ color: unitMatched ? tokens.rag.green.strong : tokens.rag.amber.strong, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.xs }}>
                                              {unitMatched ? 'Matched' : 'Mismatched'}
                                            </Text>
                                          </View>
                                          <View style={styles.unitDamageWrap}>
                                            <Text style={{ color: tokens.foreground, fontSize: tokens.text.xs, fontWeight: tokens.fontWeight.semibold }}>Damage:</Text>
                                            <SimpleToggle value={unitFlagged} onToggle={() => toggleUnitDamage(unitId)} />
                                            {unitFlagged ? (
                                              <Pressable onPress={() => toggleUnitOpen(unitId)} hitSlop={8}>
                                                <Ionicons name={unitOpen ? 'chevron-up' : 'chevron-down'} size={16} color={tokens.mutedForeground} />
                                              </Pressable>
                                            ) : (
                                              <View style={{ width: 16, height: 16 }} />
                                            )}
                                          </View>
                                        </View>
                                        {unitFlagged && unitOpen ? (
                                          <EvidenceBlock
                                            evidence={unitEvidence}
                                            onOpenNote={() => updateUnitEvidence(unitId, { noteOpen: true })}
                                            onChangeNote={(note) => updateUnitEvidence(unitId, { note })}
                                            onRecordAudio={() => updateUnitEvidence(unitId, { audio: { durationSec: 20, playing: false, bars: generateWaveformBars() } })}
                                            onToggleAudioPlay={() => {
                                              if (!unitEvidence.audio) return;
                                              updateUnitEvidence(unitId, { audio: { ...unitEvidence.audio, playing: !unitEvidence.audio.playing } });
                                            }}
                                            onRemoveAudio={() => updateUnitEvidence(unitId, { audio: null })}
                                            onAddImage={() => setAttachmentTarget(`unit:${unitId}`)}
                                            onRemoveImage={(idx) => updateUnitEvidence(unitId, { images: unitEvidence.images.filter((_, ii) => ii !== idx) })}
                                            onAddVideo={() => updateUnitEvidence(unitId, { videos: [...unitEvidence.videos, { durationSec: 20 }] })}
                                            onRemoveVideo={(idx) => updateUnitEvidence(unitId, { videos: unitEvidence.videos.filter((_, ii) => ii !== idx) })}
                                          />
                                        ) : null}
                                      </View>
                                    );
                                  })}
                                </View>
                              </View>
                            </View>
                          ) : null}
                        </View>
                      );
                    })}
                  </View>
                ) : null}
              </ScrollView>

              <View style={[styles.skuPanelFooter, { borderTopColor: tokens.border }]}>
                <Pressable onPress={() => setSkuPanelOpen(false)} style={[styles.outlineBtn, { backgroundColor: tokens.muted, borderColor: tokens.border, borderRadius: tokens.radius.lg }]}>
                  <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.semibold, fontSize: tokens.text.sm }}>Cancel</Text>
                </Pressable>
                <Pressable onPress={() => setSkuPanelOpen(false)} style={[styles.primaryBtn, { backgroundColor: tokens.primary, borderRadius: tokens.radius.lg }]}>
                  <Text style={{ color: tokens.primaryForeground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm }}>Save & Scan Next</Text>
                </Pressable>
              </View>
            </Card>
          ) : null}
        </View>
      </View>

      <BarcodeScannerModal
        visible={scannerOpen}
        title="Scan SKUs"
        hint="Scan a box's code. Scan again (from the header icon) to add another SKU or another unit."
        onScanned={handleScanned}
        onUseSimulated={handleSimulated}
        onClose={() => setScannerOpen(false)}
      />

      <NewAttachmentModal
        visible={attachmentTarget !== null}
        onClose={() => setAttachmentTarget(null)}
        onSave={(image) => {
          if (attachmentTarget === null) return;
          const unitId = attachmentTarget.slice('unit:'.length);
          updateUnitEvidence(unitId, { images: [...(activeLine?.unitDamage[unitId]?.evidence.images ?? []), image] });
        }}
      />

      {/* Same Modal/backdrop/card language as ConfirmModal — refuses the
          re-scan at intake instead of quietly counting it again, with a
          way to retry with a different box right from the prompt. */}
      <Modal visible={!!duplicateLabel} transparent animationType="fade" onRequestClose={() => setDuplicateLabel(null)}>
        <Pressable style={[styles.dupBackdrop, { backgroundColor: 'rgba(0,0,0,0.5)' }]} onPress={() => setDuplicateLabel(null)}>
          <Pressable style={[styles.dupCard, { backgroundColor: tokens.popover, borderRadius: tokens.radius.xl }]} onPress={(e) => e.stopPropagation()}>
            <View style={[styles.dupIconWrap, { backgroundColor: tokens.rag.amber.soft }]}>
              <Ionicons name="alert-outline" size={22} color={tokens.rag.amber.strong} />
            </View>
            <Text style={{ color: tokens.popoverForeground, fontWeight: tokens.fontWeight.extrabold, fontSize: tokens.text.base, marginTop: 12 }}>
              Already Scanned
            </Text>
            <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.sm, lineHeight: 19, marginTop: 6, textAlign: 'center' }}>
              &ldquo;{duplicateLabel}&rdquo; has already been scanned in this zone.
            </Text>
            <View style={styles.dupActions}>
              <Pressable onPress={() => setDuplicateLabel(null)} style={[styles.dupBtn, styles.dupOutlineBtn, { borderColor: tokens.border, borderRadius: tokens.radius.lg }]}>
                <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.semibold, fontSize: tokens.text.sm }}>Cancel</Text>
              </Pressable>
              <Pressable
                onPress={() => {
                  setDuplicateLabel(null);
                  setScannerOpen(true);
                }}
                style={[styles.dupBtn, { backgroundColor: tokens.rag.amber.strong, borderRadius: tokens.radius.lg }]}
              >
                <Text style={{ color: '#fff', fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm }}>Scan Another</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      {confirm.element}
    </View>
  );
}

// Same card language as Reported Audits' issue cards (src/features/
// progress/ReportedAuditsBoard.tsx) — a banded head with a rounded
// Green/Amber/Red status chip, not the progress-bar style tried earlier.
function StatusBadge({ label, ragKey, compact }: { label: string; ragKey: 'green' | 'amber' | 'red'; compact?: boolean }) {
  const { tokens } = useTheme();
  return (
    <View style={[styles.statusBadge, compact && styles.statusBadgeCompact, { backgroundColor: tokens.rag[ragKey].soft, borderRadius: tokens.radius.xl }]}>
      <Text style={{ color: tokens.rag[ragKey].strong, fontSize: compact ? tokens.text.xxs : tokens.text.xs, fontWeight: tokens.fontWeight.bold }} numberOfLines={1}>{label}</Text>
    </View>
  );
}

function IssueField({ label, value }: { label: string; value: string }) {
  const { tokens } = useTheme();
  return (
    <View style={styles.issueField}>
      <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xxs }}>{label}</Text>
      <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.semibold, fontSize: tokens.text.sm }}>{value}</Text>
    </View>
  );
}

function MiniField({ label, value, tone }: { label: string; value: string; tone?: string }) {
  const { tokens } = useTheme();
  return (
    <View style={styles.miniField}>
      <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xxs }} numberOfLines={1}>{label}</Text>
      <Text style={{ color: tone ?? tokens.foreground, fontWeight: tokens.fontWeight.semibold, fontSize: tokens.text.xs }} numberOfLines={1}>{value}</Text>
    </View>
  );
}

// Same inline "Label: Value" row as Rack View's DetailRow (src/features/
// rack-view/RackViewScreen.tsx) — kept identical for visual consistency
// between the two screens' Reconciliation Forms.
function DetailRow({ label, value, tokens }: { label: string; value: string; tokens: ReturnType<typeof useTheme>['tokens'] }) {
  return (
    <View style={styles.detailRow}>
      <Text style={{ fontSize: tokens.text.sm }}>
        <Text style={{ color: tokens.mutedForeground }}>{label}: </Text>
        <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.semibold }}>{value}</Text>
      </Text>
    </View>
  );
}

// Same custom track+thumb toggle as Rack View's Reconciliation Form
// (src/features/rack-view/RackViewScreen.tsx) — kept identical for visual
// consistency between the two screens' Damage fields.
function SimpleToggle({ value, onToggle }: { value: boolean; onToggle: () => void }) {
  const { tokens } = useTheme();
  const thumbX = useSharedValue(value ? 16 : 2);

  useEffect(() => {
    thumbX.value = withTiming(value ? 16 : 2, { duration: 180 });
  }, [value]);

  const thumbStyle = useAnimatedStyle(() => ({ transform: [{ translateX: thumbX.value }] }));

  return (
    <Pressable onPress={onToggle} hitSlop={8}>
      <View style={[styles.switchTrack, { backgroundColor: value ? tokens.rag.amber.strong : tokens.slate300 }]}>
        <Animated.View style={[styles.switchThumb, thumbStyle]} />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  dupBackdrop: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  dupCard: { width: '100%', maxWidth: 340, padding: 20, alignItems: 'center' },
  dupIconWrap: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  dupActions: { flexDirection: 'row', gap: 10, marginTop: 20, width: '100%' },
  dupBtn: { flex: 1, height: 44, alignItems: 'center', justifyContent: 'center' },
  dupOutlineBtn: { borderWidth: 1 },
  toolbar: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  body: { flex: 1, padding: 16 },
  singleRow: { flex: 1 },
  splitRow: { flex: 1, flexDirection: 'row', gap: 16 },
  canvasHead: { minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, paddingVertical: 12, borderBottomWidth: 1 },
  stage: { flex: 1, overflow: 'hidden' },
  stageCenter: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  planCanvas: { padding: 20, gap: 8 },
  zoneHeadRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  zoneRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 14 },
  zoneCard: { width: 120, borderWidth: 1.5, borderRadius: 12, alignItems: 'center', paddingVertical: 14, paddingHorizontal: 8 },
  layoutGroupRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 20, opacity: 0.45 },
  layoutBlock: { gap: 4 },
  rackRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 4 },
  rackCardDisabled: { alignItems: 'center', width: 60, borderWidth: 1, borderRadius: 5, paddingVertical: 5, paddingHorizontal: 4, gap: 3 },
  bayRow: { flexDirection: 'row', gap: 1.5 },
  baySeg: { width: 8, height: 12, borderWidth: 1, borderRadius: 1.5 },
  scanCountBadge: { flexDirection: 'row', alignItems: 'center', gap: 3, marginTop: 8, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10 },
  // Same skuPanel/skuPanelHead/locDetailsBox/divider/skuPanelFooter
  // structure as Rack View's Reconciliation Form (src/features/rack-view/
  // RackViewScreen.tsx) — Card keeps its default 16px padding, the header
  // bleeds to the edges via negative margins.
  skuPanel: { flex: 1 },
  skuPanelHead: { minHeight: 60, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginHorizontal: -16, marginTop: -16, marginBottom: 14, paddingHorizontal: 14, paddingVertical: 12, borderBottomWidth: 1 },
  listIconBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, height: 34, paddingHorizontal: 10, borderWidth: 1 },
  listCountDot: { position: 'absolute', top: -4, right: -4, minWidth: 16, height: 16, borderRadius: 8, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 3 },
  locDetailsBox: { flexDirection: 'row', flexWrap: 'wrap', rowGap: 12, columnGap: 16, marginBottom: 16 },
  detailRow: { minWidth: '40%' },
  divider: { height: StyleSheet.hairlineWidth, marginBottom: 16 },
  fieldCard: { borderWidth: 1, overflow: 'hidden' },
  fieldCardHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 14, paddingVertical: 10, borderBottomWidth: 1 },
  fieldCardBody: { padding: 14, gap: 10 },
  editStatusPill: { alignSelf: 'flex-start', borderWidth: 1, paddingHorizontal: 10, paddingVertical: 5 },
  skuPanelFooter: { flexDirection: 'row', gap: 10, marginTop: 12, paddingTop: 12, borderTopWidth: StyleSheet.hairlineWidth },
  outlineBtn: { flex: 1, height: 44, alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
  primaryBtn: { flex: 1, height: 44, alignItems: 'center', justifyContent: 'center' },
  listPageBody: { padding: 16, gap: 20, paddingBottom: 40 },
  zoneTabRow: { flexDirection: 'row', borderBottomWidth: 1 },
  zoneTab: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 2 },
  zoneTabDot: { minWidth: 16, height: 16, borderRadius: 8, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 3 },
  zoneSummaryBanner: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1 },
  sheetSectionLabel: { fontSize: 11, fontWeight: '700', color: '#8A94A3', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 6 },
  summaryHeadRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  statusBadge: { paddingHorizontal: 10, paddingVertical: 5 },
  statusBadgeCompact: { paddingHorizontal: 6, paddingVertical: 3 },
  issueCard: { borderWidth: 1, overflow: 'hidden' },
  issueHeadRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 6, paddingHorizontal: 14, paddingVertical: 12 },
  issueHeadLeft: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1 },
  cardBody: { padding: 14 },
  issueGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 16 },
  issueField: { gap: 2 },
  locationRow: { borderTopWidth: 1, paddingTop: 10, marginTop: 10 },
  // Compact multi-per-row grid — the earlier issueCard was full-width and
  // single-column stacked, which read as "too big" against a reference
  // maintenance-app design of small cards packed several to a row.
  cardGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  groupHeadRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  groupLabel: { fontSize: 12, fontWeight: '700' },
  miniCard: { flexGrow: 1, flexBasis: 150, maxWidth: '48%', borderWidth: 1, overflow: 'hidden' },
  miniHeadRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 4, paddingHorizontal: 8, paddingVertical: 6 },
  miniHeadLeft: { flexDirection: 'row', alignItems: 'center', gap: 4, flexShrink: 1 },
  miniBody: { padding: 8 },
  miniGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  miniField: { gap: 1, flexShrink: 1, minWidth: 60 },
  miniLocationRow: { borderTopWidth: 1, borderTopColor: 'transparent', paddingTop: 6, marginTop: 6 },
  headerScanBtn: { width: 34, height: 34, alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
  // "Skus to be scanned at selected zone" checklist — collapsible pick
  // list, same card language as fieldCard elsewhere in this form.
  checklistCard: { borderWidth: 1, overflow: 'hidden' },
  checklistHead: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 12 },
  checklistBody: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#E5E7EB', paddingHorizontal: 12, paddingVertical: 6, gap: 8 },
  checklistRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 6 },
  // Same scanNoteBox/scanCountRow/scannedListWrap/scannedRow/accordionBody/
  // unitRow/unitDamageWrap/unitDivider/switchTrack/switchThumb as Rack
  // View's Reconciliation Form (src/features/rack-view/RackViewScreen.tsx)
  // — kept identical for visual consistency between the two screens.
  scanNoteBox: { flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: 1, padding: 14 },
  scanNoteIconWrap: { width: 40, height: 40, borderRadius: 20, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  scanCountRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  scannedListWrap: { gap: 8, marginBottom: 10 },
  scannedRow: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, padding: 10 },
  accordionBody: { borderWidth: 1, borderTopWidth: 0, borderTopLeftRadius: 0, borderTopRightRadius: 0, padding: 12, gap: 10 },
  unitRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  unitDamageWrap: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  unitDivider: { marginTop: 14, paddingTop: 14, borderTopWidth: StyleSheet.hairlineWidth },
  switchTrack: { width: 34, height: 20, borderRadius: 10 },
  switchThumb: { position: 'absolute', top: 2, left: 0, width: 16, height: 16, borderRadius: 8, backgroundColor: '#fff' },
});
