import { Ionicons } from '@expo/vector-icons';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, BackHandler, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { cancelAnimation, useAnimatedStyle, useSharedValue, withRepeat, withSequence, withTiming } from 'react-native-reanimated';
import { AppHeader } from '@/components/AppHeader';
import { BarcodeScannerModal } from '@/components/BarcodeScannerModal';
import { Card } from '@/components/Card';
import { EvidenceBlock } from '@/components/EvidenceBlock';
import { NewAttachmentModal } from '@/components/NewAttachmentModal';
import { Pill } from '@/components/Pill';
import { InlineDropdown, ToolbarField } from '@/components/ToolbarDropdownField';
import type { SheetOption } from '@/components/BottomSheetPicker';
import { useConfirmDialog } from '@/hooks/useConfirmDialog';
import { useLocationsTree } from '@/hooks/useLocationsTree';
import { findLayoutIn, findRackIn } from '@/lib/locationsRepo';
import { EXPECTED_SKUS, generateWaveformBars, INVENTORY_POOL, RACK_DIAGRAM_SLOTS_PER_LEVEL, type ExpectedSkuLine } from '@/lib/mockData';
import { ACTIVITY_PHASES, CONDITIONS, OBSERVATIONS_BY_PHASE, type ActivityPhase, type CountLine, type Evidence, type LocationNode } from '@/lib/types';
import { useTheme } from '@/theme/ThemeProvider';
import { useAudits } from '../dashboard/hooks';
import { useCountSheetMutations } from '../count-sheet/mutations';
import { buildBayDiagram, buildScanOrder, type ScanDirection, type ScanScope } from './buildBayDiagram';

// `source: 'bay-chip'` marks arriving from an Audit Details bay chip
// specifically — the one entry point where the bay lock is meant to stay
// absolute (other bays' pending SKUs only reachable via the Bay dropdown).
// Every other entry point (Resume Audit, opening the rack generally, etc.)
// leaves `source` unset and keeps pending locations directly tappable
// across bays regardless of the lock — see isLocSelectable below.
type Params = { auditId: string; layout: string; rackId: string; bay: string; loc?: string; source?: 'bay-chip' };

// Matches styles.cell's width and styles.diagramCells' gap below — a full
// (3-slot) row's total width, used to stretch a shorter level's real cells
// (see the diagram row render) so they occupy the same span instead of
// leaving room for a slot that beam was never built with.
const DIAGRAM_CELL_WIDTH = 38;
const DIAGRAM_CELL_GAP = 8;
const FULL_DIAGRAM_ROW_WIDTH = RACK_DIAGRAM_SLOTS_PER_LEVEL * DIAGRAM_CELL_WIDTH + (RACK_DIAGRAM_SLOTS_PER_LEVEL - 1) * DIAGRAM_CELL_GAP;

// Pallet ID shown to the inspector — level + pallet number on that level,
// e.g. level 5 / pallet 1 -> "P-0501" — distinct from the location's
// internal `code` (rack/bay-scoped) used for lookups and saving records.
// Prefixed with the bay code (e.g. "B-01 · P-0501") whenever it's known —
// the whole rack's bays render together on canvas, and level/slot numbers
// repeat across bays, so the bare pallet ID alone is ambiguous once more
// than one bay is in view.
// Feeds the canvas header's Scan Direction badge — the currently active
// pattern at a glance, without opening the popover.
function scanDirectionArrowIcon(direction: ScanDirection): keyof typeof Ionicons.glyphMap {
  switch (direction) {
    case 'right':
      return 'arrow-forward';
    case 'left':
      return 'arrow-back';
    case 'up':
      return 'arrow-up';
    case 'down':
      return 'arrow-down';
  }
}

function palletIdFor(loc: { level?: number; slot?: number; code: string }, bayCode?: string): string {
  const base = loc.level != null && loc.slot != null ? `P-${String(loc.level).padStart(2, '0')}${String(loc.slot).padStart(2, '0')}` : loc.code;
  return bayCode ? `${bayCode} · ${base}` : base;
}

// variation-3: a selection-driven flow instead of variation-2's free-scan-
// in-any-order Live Scan session. Every in-scope pallet is directly
// selectable — tap it on the canvas, or pick it from the toolbar dropdown,
// both stay in sync either direction. Selecting one and tapping Start Audit
// opens a right-side Reconciliation Form with that exact pallet's expected
// SKU already known (from EXPECTED_SKUS) and a scan icon right at the top
// of the form — scanning here only ever needs to answer "does the SKU
// actually on this known pallet match what's expected," not "which pallet
// is this." Scan Next SKU saves the current pallet and auto-advances
// selection (and the canvas highlight) to the next one in the rack.
export function RackViewScreen() {
  const { tokens } = useTheme();
  const params = useLocalSearchParams<Params>();
  const { auditId } = params;
  const { data: audits } = useAudits();
  const audit = audits?.find((a) => a.audit_id === auditId);
  const { data: tree, isLoading } = useLocationsTree(auditId);
  const { saveRecord, completeLocation } = useCountSheetMutations(auditId);

  // Whether leaving right now would discard something worth keeping, and
  // how to save it — refs updated fresh every render further down (after
  // selectedLocObj/handleSaveSkuPanel/handleSaveManualIssue exist), so
  // confirmBack (below) and the hardware-back handler always read the
  // latest state without needing those not-yet-declared values in their
  // own dependency arrays (which would violate the hooks-before-any-
  // early-return rule).
  const hasPendingRecordRef = useRef(false);
  const saveThenLeaveRef = useRef<() => Promise<void>>(async () => {});
  const skuPanelOpenRef = useRef(false);

  // Intercepts EVERY way this screen can be left — the header's own back
  // arrow AND Android hardware/gesture back — always confirming first,
  // not just when a pallet record is unsaved (message and follow-up
  // action differ based on that). If the canvas+form split view is still
  // open, this closes it back down to canvas-only FIRST (revealing the
  // rack behind the popup) before showing the confirmation.
  //
  // Deliberately NOT React Navigation's `beforeRemove` event: Rack View is
  // mounted as a hidden Tabs.Screen (see (app)/_layout.tsx's PhoneTabsLayout
  // — "every pushed screen... is registered here as a hidden Tabs.Screen,
  // not a real Stack push"), and a Tabs navigator never actually removes an
  // unfocused screen from its state, only unfocuses it — so `beforeRemove`
  // never fires here at all. router.back() + a direct BackHandler listener
  // works regardless of navigator type.
  const confirmBack = () => {
    const wasPending = hasPendingRecordRef.current;
    if (skuPanelOpenRef.current) setSkuPanelOpen(false);
    if (wasPending) {
      confirm.ask('You have an open pallet record for this audit. Save it before going back?', async () => {
        await saveThenLeaveRef.current();
        router.back();
      });
      return;
    }
    confirm.ask('Save the locations you’ve scanned in this audit before going back?', () => {
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

  const [layoutName, setLayoutName] = useState(params.layout);
  const [rackCode, setRackCode] = useState(params.rackId);
  // Arriving with a specific bay in the params (a bay chip tap, Resume
  // Audit, etc.) locks selectability to that one bay — every other bay's
  // pallets are disabled on the canvas and absent from the Pallet picker —
  // without forcing a trip back to Audit Details to work a different bay:
  // picking one from the Bay dropdown re-scopes selectability to it instead.
  // No `bay` param (e.g. opening the rack generally) leaves everything
  // selectable, same as before. `||` (not `??`) deliberately treats an
  // empty string the same as absent — the 3D warehouse map's "Start Task"
  // passes `bay: ''` (only a rack was tapped, not a specific bay), which
  // `??` would let through as bayFilter='', silently failing every
  // inBayFilter() check since no real bay code ever equals ''.
  const [bayFilter, setBayFilter] = useState<string>(params.bay || 'all');
  const [pendingModalOpen, setPendingModalOpen] = useState(false);
  const [pendingTab, setPendingTab] = useState<'pending' | 'empty'>('pending');
  const [pendingSearch, setPendingSearch] = useState('');
  // Bay-wise accordion in the Pending SKU modal — same "default open, mark
  // closed" pattern as Audit Details' bay accordion, keyed by bay code.
  const [closedPendingBays, setClosedPendingBays] = useState<Record<string, boolean>>({});
  const [pickerField, setPickerField] = useState<'layout' | 'rack' | 'bay' | 'pallet' | null>(null);
  // How "Scan Next SKU" walks the rack — matches how the audit is actually
  // being physically worked (see buildScanOrder). Right/Down are the
  // near-end starting defaults.
  const [scanDirection, setScanDirection] = useState<ScanDirection>('right');
  // 'rack' = today's MHE-vs-no-MHE rack-wide pattern (bays alternate);
  // 'bay' = the same direction applied independently, unalternated, inside
  // each bay on its own — see buildScanOrder's ScanScope param.
  const [scanScope, setScanScope] = useState<ScanScope>('rack');
  const [directionMenuOpen, setDirectionMenuOpen] = useState(false);
  const [selectedLoc, setSelectedLoc] = useState<string | null>(params.loc ?? null);
  const [skuPanelOpen, setSkuPanelOpen] = useState(false);
  const [scanLines, setScanLines] = useState<CountLine[]>([]);
  const [scanPallet, setScanPallet] = useState<string | null>(null);
  const [expectedSkus, setExpectedSkus] = useState<ExpectedSkuLine[]>([]);
  const [skuScanCount, setSkuScanCount] = useState(0);
  const [scannerOpen, setScannerOpen] = useState<'sku' | null>(null);
  // Quantity and damage are unknown at scan time — a scan only proves SKU
  // identity — so each starts unchecked ("-" shown instead of a number)
  // until the inspector deliberately enters what they actually found.
  // *Editing is the input row being open right now; *Checked is "a real
  // value has been entered this session" (or this pallet already had a
  // saved record when selected), which is what unlocks the Matched/
  // Mismatch badge and the Raise Issue button for that field.
  const [qtyChecked, setQtyChecked] = useState(false);
  const [qtyEditing, setQtyEditing] = useState(false);
  const [qtyInputText, setQtyInputText] = useState('');
  const [damageChecked, setDamageChecked] = useState(false);
  const [damageEditing, setDamageEditing] = useState(false);
  // Draft selections while the Damage editor is open — Observations is a
  // second cascading radio group whose options depend on Activity Phase, so
  // both need to be picked before Confirm can commit either.
  const [damagePhaseDraft, setDamagePhaseDraft] = useState<ActivityPhase | null>(null);
  const [damageObservationDraft, setDamageObservationDraft] = useState<string | null>(null);
  // Session-only flags (not persisted) — "Raise Issue" in the detail view
  // just gives the inspector visible confirmation; the underlying condition
  // already makes the line show up in Reported Audits once saved.
  const [issuesRaised, setIssuesRaised] = useState<Set<string>>(new Set());
  // Location codes with a raised issue — drives the red dot on that
  // pallet's canvas cell, so a flagged location stays visible even after
  // the panel closes or a different pallet gets selected.
  const [flaggedLocs, setFlaggedLocs] = useState<Set<string>>(new Set());
  const [attachmentTarget, setAttachmentTarget] = useState<'qty' | 'damage' | null>(null);
  // Manual Mode: for reporting a real-world issue (e.g. a damaged pallet)
  // found anywhere in the physical rack, not just the audit's assigned
  // scope — every pallet becomes selectable and the panel skips scanning
  // entirely, going straight to a location + qty/damage + evidence report.
  const [manualMode, setManualMode] = useState(false);
  const [manualLine, setManualLine] = useState<CountLine>({ sku: '', name: '', lot: '—', qty: 1, condition: 'Good' });
  // Once a pallet's already been reported, its form starts collapsed
  // (a "tap to see details" summary) — this flips it back open for review.
  const [manualReviewExpanded, setManualReviewExpanded] = useState(false);
  // Manual Mode still requires an actual scan before showing the report
  // form — the inspector picks the location, but what SKU is physically
  // on that pallet is only known once they scan it, same as normal mode.
  const [manualScanned, setManualScanned] = useState(false);
  const confirm = useConfirmDialog();

  // Exactly one SKU is expected per pallet, and exactly one scan is on
  // record for it (a new scan replaces the previous one rather than
  // accumulating a checklist). The SKU identity check happens first — if
  // the wrong item was scanned, that's "Misplaced" and there's nothing to
  // reconcile at this location for it. Only once the right SKU is
  // confirmed does the qty/condition form appear; Matched vs. Mismatch is
  // then decided by what the inspector records there.
  // Writes into whichever line is actually "live" right now — manualLine
  // in Manual Mode, scanLines[0] otherwise — so the shared qty/damage/
  // evidence handlers below don't need their own mode branch each.
  const updateCurrentLine = (patch: Partial<CountLine> | ((line: CountLine) => Partial<CountLine>)) => {
    if (formIsManual) {
      setManualLine((prev) => ({ ...prev, ...(typeof patch === 'function' ? patch(prev) : patch) }));
      return;
    }
    setScanLines((prev) => {
      if (!prev[0]) return prev;
      const next = prev.slice();
      next[0] = { ...next[0], ...(typeof patch === 'function' ? patch(next[0]) : patch) };
      return next;
    });
  };

  // Drives the bay canvas cell colors: green once a pallet's scan resolves
  // to a clean match, amber when the right SKU was found but qty/condition
  // is off ("matched but has an issue"), red when the wrong SKU was
  // scanned entirely, gray for anything not yet scanned this session.
  const [locationStatus, setLocationStatus] = useState<Record<string, 'matched' | 'issue' | 'mismatch' | 'missing'>>({});
  // Checked when the inspector physically found no scanner code at all at
  // the selected location — lets them resolve and move past it without a
  // scan, instead of getting stuck waiting for a code that doesn't exist.
  const [noScannerFound, setNoScannerFound] = useState(false);
  // Asked right after Selected Location Details, independent of whether the
  // pallet's been scanned yet — a quick overall read on the physical pallet
  // at this location, separate from the SKU-level Quantity/Damage findings
  // below. Answered per-location; carries into whichever line ends up saved.
  const [palletConditionGood, setPalletConditionGood] = useState<boolean | null>(null);

  // Figma-style canvas: pinch to zoom, drag to pan, the toolbar/footer stay
  // put since only this transformed layer moves — not the whole screen.
  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1);
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const savedTranslateX = useSharedValue(0);
  const savedTranslateY = useSharedValue(0);

  const panGesture = Gesture.Pan().onUpdate((e) => {
    translateX.value = savedTranslateX.value + e.translationX;
    translateY.value = savedTranslateY.value + e.translationY;
  }).onEnd(() => {
    savedTranslateX.value = translateX.value;
    savedTranslateY.value = translateY.value;
  });

  const pinchGesture = Gesture.Pinch().onUpdate((e) => {
    scale.value = Math.min(4, Math.max(1, savedScale.value * e.scale));
  }).onEnd(() => {
    savedScale.value = scale.value;
  });

  const canvasGesture = Gesture.Simultaneous(panGesture, pinchGesture);

  const canvasAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }, { translateY: translateY.value }, { scale: scale.value }],
  }));

  // Re-syncs layoutName/rackCode/bayFilter/selectedLoc to the INCOMING
  // ROUTE PARAMS, not just on first mount. Tapping a second bay chip within
  // the same rack resolves to the exact same path
  // (/audit/[auditId]/rack/[rackId]) — only `bay`, a non-path param,
  // differs — so Expo Router reuses this exact screen instance instead of
  // remounting it. Every piece of state above was seeded via
  // useState(params...), which only ever runs on the very first mount, so
  // without this effect a second bay-chip tap (or Resume Audit landing on
  // a different location after a previous Rack View visit) would silently
  // keep showing whichever rack/bay/location was open before, not the one
  // just navigated to.
  const paramsKey = `${auditId}|${params.layout}|${params.rackId}|${params.bay}|${params.loc ?? ''}|${params.source ?? ''}`;
  const paramsKeyRef = useRef<string>(paramsKey);
  useEffect(() => {
    if (paramsKeyRef.current === paramsKey) return;
    paramsKeyRef.current = paramsKey;
    setLayoutName(params.layout);
    setRackCode(params.rackId);
    setBayFilter(params.bay || 'all');
    setSelectedLoc(params.loc ?? null);
    scale.value = 1;
    savedScale.value = 1;
    translateX.value = 0;
    translateY.value = 0;
    savedTranslateX.value = 0;
    savedTranslateY.value = 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paramsKey]);

  // The requested layout/rack (from route params or a stale picker
  // selection) may not exist in this audit's tree — rather than dead-ending
  // on an error, fall back to the first rack so Rack View for this task
  // always renders something the inspector can act on.
  const fallbackLayoutObj = tree ? (findLayoutIn(tree, layoutName) ?? tree.layouts[0]) : undefined;
  const fallbackRackObj = tree && fallbackLayoutObj ? (findRackIn(tree, fallbackLayoutObj.name, rackCode) ?? fallbackLayoutObj.racks[0]) : undefined;

  useEffect(() => {
    if (fallbackLayoutObj && fallbackLayoutObj.name !== layoutName) setLayoutName(fallbackLayoutObj.name);
  }, [fallbackLayoutObj?.name]);

  useEffect(() => {
    if (fallbackRackObj && fallbackRackObj.code !== rackCode) setRackCode(fallbackRackObj.code);
  }, [fallbackRackObj?.code]);

  if (!audit || isLoading || !tree) {
    return (
      <View style={[styles.loading, { backgroundColor: tokens.muted }]}>
        <ActivityIndicator color={tokens.primary} />
      </View>
    );
  }

  const layoutObj = fallbackLayoutObj;
  const rackObj = fallbackRackObj;

  if (!layoutObj || !rackObj || !rackObj.bays.length) {
    return (
      <View style={[styles.loading, { backgroundColor: tokens.muted }]}>
        <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.sm }}>No bays are in scope for this task yet.</Text>
        <Pressable onPress={() => router.back()} style={{ marginTop: 12 }}>
          <Text style={{ color: tokens.primary, fontWeight: tokens.fontWeight.semibold }}>Go back</Text>
        </Pressable>
      </View>
    );
  }

  // The whole rack's locations, flattened across every one of its bays —
  // used for selection lookup, the Pallet picker, and scan progression,
  // since a rack can now be worked end to end without switching bays.
  const rackLocations = rackObj.bays.flatMap((b) => b.locations);
  const selectedLocObj = selectedLoc ? rackLocations.find((l) => l.code === selectedLoc) ?? null : null;
  // Whether the currently selected pallet already has a saved Manual Mode
  // report — drives showing the collapsed "tap to see details" summary
  // instead of the full report form by default.
  const manualRaised = !!selectedLocObj && flaggedLocs.has(selectedLocObj.code);
  const bayDiagrams = rackObj.bays.map((b) => ({ bay: b, rows: buildBayDiagram(b) }));
  // Which bay a location actually belongs to — needed when saving, since
  // the repo looks the location up by its real bay code, not just its own.
  const bayCodeForLoc = (locCode: string) => rackObj.bays.find((b) => b.locations.some((l) => l.code === locCode))?.code ?? rackObj.bays[0].code;

  // Selecting a pallet — from the canvas, the Pallet dropdown, or an
  // auto-advance — always syncs the Bay field to that pallet's actual bay
  // too, so the toolbar reflects exactly where the current selection is
  // instead of whatever bay filter happened to be set beforehand.
  const selectLocation = (code: string) => {
    setSelectedLoc(code);
    setBayFilter(bayCodeForLoc(code));
  };

  // When this audit has a target_sku (the admin's "SKU Type" field), only
  // pallets actually carrying that SKU are in scope to select/scan at all —
  // every other pallet is disabled on the canvas, absent from the Pallet
  // picker, and ignored by both real and simulated pallet scans. Without a
  // target_sku every pallet in the rack stays selectable, same as before.
  // Manual Mode overrides all of this: the inspector found a real-world
  // problem (e.g. a damaged pallet) outside the audit's assigned scope, so
  // every pallet in the physical rack becomes selectable/reportable, not
  // just the ones this audit was scoped to.
  const matchesTargetSku = (locCode: string) => !!audit.target_sku && (EXPECTED_SKUS[locCode] ?? []).some((l) => l.sku === audit.target_sku);

  // The Reconciliation Form only actually behaves like Manual Mode's report
  // (no expected SKU, Manual Issue Report header, etc.) for a pallet that's
  // genuinely out-of-scope and only reportable because Manual Mode opened
  // it up — same rule isManualOnly (below) uses for canvas styling. Flipping
  // the Manual Mode toggle while an in-scope, expected-SKU pallet is still
  // selected must NOT switch that pallet's form into manual behavior.
  const formIsManual = manualMode && !!selectedLocObj && !!audit.target_sku && !matchesTargetSku(selectedLocObj.code);
  // Manual Mode shares this same qty/damage form (see the shared JSX
  // block below), but there's genuinely no expected SKU/qty/condition for
  // an out-of-scope pallet, so expectedSku always stays null there —
  // skuMatched/misplaced fall out false automatically as a result, and the
  // form itself skips rendering anything that depends on a comparison.
  const expectedSku = formIsManual ? null : (expectedSkus[0] ?? null);
  const scannedLine = formIsManual ? (manualScanned ? manualLine : null) : (scanLines[0] ?? null);
  const skuMatched = !!scannedLine && !!expectedSku && scannedLine.sku === expectedSku.sku;
  const misplaced = !!scannedLine && !skuMatched && !formIsManual;

  const inBayFilter = (locCode: string) => bayFilter === 'all' || bayCodeForLoc(locCode) === bayFilter;
  // Still waiting on a clean, confirmed match at this location — either
  // never scanned, or scanned and found to mismatch on qty/damage. Shared
  // by isLocSelectable (below) and pendingLocations.
  const isLocPending = (locCode: string) => {
    if (audit.target_sku && !matchesTargetSku(locCode)) return false;
    if (locationStatus[locCode] === 'missing') return false;
    const loc = rackLocations.find((l) => l.code === locCode);
    const expected = EXPECTED_SKUS[locCode]?.[0];
    if (!expected || !loc) return false;
    const saved = loc.pallets.find((p) => p.saved);
    const line = saved?.lines[0];
    if (!line) return true;
    if (line.sku !== expected.sku) return false;
    return line.qty !== expected.qty || line.condition !== 'Good';
  };
  // A pending location in another bay stays directly tappable on the
  // canvas despite the lock — except when arriving from an Audit Details
  // bay chip specifically, where the lock is meant to stay absolute: only
  // the chip's own bay is highlighted/selectable, and reaching any other
  // bay's SKUs requires picking it from the Bay dropdown first (which
  // re-scopes bayFilter, same as ever).
  const isLocSelectable = (locCode: string) =>
    manualMode ||
    (inBayFilter(locCode) && (!audit.target_sku || matchesTargetSku(locCode))) ||
    (params.source !== 'bay-chip' && isLocPending(locCode));
  // Canvas highlight color: with a target_sku, only the matching pallets are
  // highlighted dark; without one, any pallet that has an assigned SKU is
  // (as before). Unaffected by Manual Mode — the expected-SKU pallets keep
  // exactly the same plain gray look they always had, so Manual Mode reads
  // as "extra pallets opened up", not "the whole canvas repainted".
  // From an Audit Details bay chip specifically, only the chip's own bay
  // highlights — every other bay's expected SKUs stay plain, matching the
  // absolute lock on selectability there. Every other entry point (Resume
  // Audit, opening the rack from Audit Details generally, the 3D warehouse
  // map) highlights every bay's expected SKUs at once.
  const isLocHighlighted = (locCode: string) => {
    if (params.source === 'bay-chip' && !inBayFilter(locCode)) return false;
    return audit.target_sku ? matchesTargetSku(locCode) : (EXPECTED_SKUS[locCode]?.length ?? 0) > 0;
  };
  // Manual Mode-only pallets — outside the audit's assigned scope, only
  // selectable/reportable because Manual Mode opened them up. Dashed border
  // marks them as "not originally in scope" without needing a fill color.
  const isManualOnly = (locCode: string) => manualMode && !!audit.target_sku && !matchesTargetSku(locCode);
  // "Scan Next SKU" (and the Pallet dropdown's order) walks the rack in
  // whichever direction the canvas header's direction control has set —
  // not just array order — so it always matches how the rack is actually
  // being worked physically. Always keeps the currently open location in
  // the list even if it just stopped being selectable on its own (e.g.
  // marking it Empty flips it to 'missing', which isLocPending excludes) —
  // otherwise handleScanNext's index lookup for "this location" comes up
  // -1 and it closes back to the canvas instead of advancing.
  const scannableLocations = buildScanOrder(scanDirection, bayDiagrams, scanScope).filter((l) => isLocSelectable(l.code) || l.code === selectedLoc);

  // In-scope locations still waiting on a clean, confirmed match — either
  // never scanned at all, or scanned and found to mismatch (wrong SKU, or
  // the right SKU with a quantity/damage issue). Independent of Manual
  // Mode's toggle: this always reflects the audit's real assigned scope
  // (target_sku), not whatever Manual Mode has temporarily opened up.
  const pendingLocations = rackLocations.filter((loc) => isLocPending(loc.code));
  // In-scope locations the inspector already flagged "no scanner code
  // found" this session — its own list rather than mixed into Pending, so
  // "Pending Locations" only ever means "still needs a scan".
  const emptyLocations = rackLocations.filter((loc) => {
    if (audit.target_sku && !matchesTargetSku(loc.code)) return false;
    return locationStatus[loc.code] === 'missing';
  });

  const layoutOptions: SheetOption[] = tree.layouts.map((l) => ({ value: l.name, label: l.name }));
  const rackOptions: SheetOption[] = layoutObj.racks.map((r) => ({ value: r.code, label: `Rack ${r.code}` }));
  const bayOptions: SheetOption[] = [
    { value: 'all', label: 'All Bays' },
    ...rackObj.bays.map((b) => ({ value: b.code, label: `Bay ${b.code}` })),
  ];
  const palletOptions: SheetOption[] = scannableLocations
    .filter((l) => bayFilter === 'all' || bayCodeForLoc(l.code) === bayFilter)
    .map((l) => ({
      value: l.code,
      label: palletIdFor(l, bayCodeForLoc(l.code)),
    }));

  // Switching layout also resets the rack to that layout's first one — the
  // previously-picked rack code almost certainly doesn't exist there.
  const handlePickLayout = (name: string) => {
    setLayoutName(name);
    const nextLayout = tree.layouts.find((l) => l.name === name);
    if (nextLayout?.racks[0]) setRackCode(nextLayout.racks[0].code);
    setPickerField(null);
  };

  const handlePickRack = (code: string) => {
    setRackCode(code);
    setPickerField(null);
  };
  // Dropdown -> canvas: picking a pallet here also becomes the canvas'
  // selection (the cell gets the blue "selected" outline), same object of
  // truth (`selectedLoc`) as tapping the cell directly does.
  const handlePickPallet = (code: string) => {
    selectLocation(code);
    setPickerField(null);
  };

  // Drives the bay canvas cell colors: green once a pallet's scan resolves
  // to a clean match, amber when the right SKU was found but qty/condition
  // is off, red when the wrong SKU was scanned (misplaced), gray (the
  // default, just omitted from the map) for anything not yet scanned.
  // Called from every place the scan/edit state for the open pallet can
  // change, so the canvas behind the panel always reflects what's on
  // screen right now.
  // `qtyChecked`/`damageChecked` are whether the inspector has actually
  // entered a real value for that field yet — an unchecked field can never
  // read as "off" (its placeholder value isn't real), only a checked field
  // that disagrees with what's expected counts toward the amber "issue"
  // status. Both default true for a prior saved record, which is already
  // real data the moment it's loaded.
  const applyLocationStatus = (
    locCode: string,
    line: CountLine | null,
    expected: ExpectedSkuLine | null,
    qtyChecked = true,
    damageChecked = true,
  ) => {
    setLocationStatus((prev) => {
      if (!line) {
        if (!(locCode in prev)) return prev;
        const next = { ...prev };
        delete next[locCode];
        return next;
      }
      const skuMatches = !!expected && line.sku === expected.sku;
      const qtyOff = qtyChecked && line.qty !== expected?.qty;
      const damageOff = damageChecked && line.condition !== 'Good';
      const status: 'matched' | 'issue' | 'mismatch' = !skuMatches ? 'mismatch' : qtyOff || damageOff ? 'issue' : 'matched';
      return prev[locCode] === status ? prev : { ...prev, [locCode]: status };
    });
  };

  // "No Scanner Found" checkbox — the inspector is telling us the physical
  // code just isn't there, so there's nothing left to scan at this pallet.
  // Wipes any in-progress scan and marks the location 'missing' (dark gray,
  // dashed on canvas) instead of leaving it stuck gray/unresolved forever.
  // Pallet Condition is answered independently of the scan itself (it's
  // about the location, not the pallet's SKU/qty/damage), so it's never
  // reset here — an inspector who answers it before realizing the location
  // is empty shouldn't have to answer it again.
  const handleToggleNoScannerFound = (checked: boolean) => {
    setNoScannerFound(checked);
    if (!selectedLocObj) return;
    if (checked) {
      setScanLines([]);
      setQtyChecked(false);
      setDamageChecked(false);
      setQtyEditing(false);
      setDamageEditing(false);
      setLocationStatus((prev) => ({ ...prev, [selectedLocObj.code]: 'missing' }));
    } else {
      applyLocationStatus(selectedLocObj.code, scanLines[0] ?? null, expectedSkus[0] ?? null, qtyChecked, damageChecked);
    }
  };

  // Answerable the moment a location is selected, independent of whether
  // it's been scanned yet — writes straight into the live line (manualLine
  // always exists; scanLines[0] only once an actual scan is on record), so
  // the two stay in sync no matter which happens first.
  const handleSelectPalletCondition = (good: boolean) => {
    setPalletConditionGood(good);
    if (formIsManual) {
      setManualLine((prev) => ({ ...prev, palletConditionGood: good }));
      return;
    }
    if (!scanLines[0]) return;
    const next = scanLines.slice();
    next[0] = { ...next[0], palletConditionGood: good };
    setScanLines(next);
  };

  // Shared by "Start Audit" (from the canvas) and "Scan Next SKU" (from
  // inside an already-open panel) — resets the scan state for a location.
  // Only a pallet the inspector genuinely already scanned and saved this
  // audit (saved: true, written by saveRecord) counts as "existing" — the
  // demo-seeded pallet every location starts with (saved: false/undefined)
  // is the warehouse's actual contents, not a completed scan, so it must
  // never pre-fill the form. Otherwise Start Audit would open straight into
  // a resolved Matched/Mismatch state instead of the empty "Scan SKU" UI
  // the inspector is meant to see first.
  const startAuditFor = (loc: LocationNode) => {
    if (formIsManual) {
      // No expected-vs-scanned check, but a real scan is still required —
      // this pallet's SKU isn't known ahead of time the way an in-scope
      // one is. Only a pallet already reported this audit (saved: true)
      // counts as "already scanned"; otherwise the scan target shows first.
      const existing = loc.pallets.find((p) => p.saved) ?? null;
      const line: CountLine = existing?.lines[0] ? { ...existing.lines[0] } : { sku: '', name: '', lot: '—', qty: 1, condition: 'Good' };
      setManualLine(line);
      setManualScanned(!!existing?.lines[0]);
      setManualReviewExpanded(false);
      // Shares normal mode's qty/damage form — an already-saved report has
      // real qty/condition values to show right away, same as normal
      // mode's `!!base.length`; a fresh one starts unchecked ("-") until
      // the inspector enters what they actually found.
      setQtyChecked(!!existing?.lines[0]);
      setDamageChecked(!!existing?.lines[0]);
      setQtyEditing(false);
      setDamageEditing(false);
      setPalletConditionGood(line.palletConditionGood ?? null);
      // A previously-saved issue (this session or an earlier one) should
      // still read as raised, not reset back to a fresh unflagged state.
      if (existing?.lines[0]?.issueRaised) {
        setIssuesRaised((prev) => new Set(prev).add(existing.lines[0].sku));
        setFlaggedLocs((prev) => new Set(prev).add(loc.code));
      }
      return;
    }
    const existing = loc.pallets.find((p) => p.saved) ?? null;
    // Single-SKU pallet: only the first line of any prior saved scan applies.
    const base = existing ? existing.lines.slice(0, 1).map((l) => ({ ...l })) : [];
    const expected = (EXPECTED_SKUS[loc.code] ?? []).slice(0, 1);
    setScanPallet(existing ? existing.pallet : null);
    setScanLines(base);
    if (base[0]?.issueRaised) {
      setIssuesRaised((prev) => new Set(prev).add(base[0].sku));
      setFlaggedLocs((prev) => new Set(prev).add(loc.code));
    }
    // A pallet already saved this audit shows its real qty/damage right
    // away; a fresh one starts unchecked ("-") until the inspector enters
    // what they actually found.
    setQtyChecked(!!base.length);
    setDamageChecked(!!base.length);
    setQtyEditing(false);
    setDamageEditing(false);
    setExpectedSkus(expected);
    setNoScannerFound(false);
    setPalletConditionGood(base[0]?.palletConditionGood ?? null);
    applyLocationStatus(loc.code, base[0] ?? null, expected[0] ?? null, !!base.length, !!base.length);
  };

  // Loads whichever pallet is currently selected into the panel — covers
  // opening the panel fresh (Start Audit), advancing (Scan Next), AND
  // simply re-tapping a different — including already-resolved — pallet on
  // the canvas while the panel is already open, so its saved details always
  // reload instead of the panel staying stuck showing the previous pallet.
  // Deliberately does NOT depend on manualMode: flipping that toggle while
  // the same pallet stays selected must never reload/reset it — selecting
  // an actually different (e.g. newly-opened out-of-scope) pallet already
  // changes selectedLoc on its own, and handleToggleManualMode already
  // moves the selection itself when turning the toggle off requires it.
  useEffect(() => {
    if (skuPanelOpen && selectedLocObj) {
      startAuditFor(selectedLocObj);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedLoc, skuPanelOpen]);

  const handleStartAudit = () => {
    if (!selectedLocObj) return;
    setSkuPanelOpen(true);
  };

  // Flipping the toggle switches what's showing in the already-open split
  // view (scan/compare <-> manual report) for whatever's currently
  // selected — it never collapses back to the full canvas by itself. The
  // one exception: turning manual mode OFF while an out-of-scope pallet is
  // selected, since that pallet isn't selectable under normal audit scope
  // at all, so there's nothing valid left to keep showing.
  const handleToggleManualMode = () => {
    const turningOff = manualMode;
    if (turningOff && selectedLoc && audit.target_sku && !matchesTargetSku(selectedLoc)) {
      // Currently on a pallet that's only valid in Manual Mode (e.g. one an
      // issue was just raised for) — rather than leaving the inspector on
      // nothing, pick up the normal audit where it would've continued: the
      // next expected pallet after this one's position in the rack.
      const idx = rackLocations.findIndex((l) => l.code === selectedLoc);
      const next = rackLocations.slice(idx + 1).find((l) => matchesTargetSku(l.code));
      if (next) {
        selectLocation(next.code);
      } else {
        setSelectedLoc(null);
        setSkuPanelOpen(false);
      }
    }
    setManualMode(!manualMode);
  };

  // Persists the pallet just finished, then jumps straight to the next
  // location on this rack — selecting it (which highlights it on the
  // canvas behind the panel) reloads it via the effect above, so the
  // inspector never has to close the panel and tap the canvas by hand.
  // Progresses across all of the rack's bays in sequence, not just the one
  // the current location happens to be in.
  const handleScanNext = async () => {
    // Misplaced/Mismatch pallets are saved too, not just Matched ones —
    // otherwise a raised Mismatch issue (and the scan itself) would vanish
    // the moment the inspector moves on, never reaching Reported Audits.
    if (selectedLocObj && scanLines.length) {
      const ref = { auditId, layout: layoutName, rack: rackCode, bay: bayCodeForLoc(selectedLocObj.code), loc: selectedLocObj.code };
      await saveRecord(tree, ref, scanLines);
      // Its expected SKU has now been scanned (Matched, Mismatch, or
      // Issue — any resolved outcome) — completing it here, rather than
      // requiring a separate action, is what lets a bay's chip turn green
      // on Audit Details once every one of its locations is resolved.
      await completeLocation(tree, ref);
    } else if (selectedLocObj && noScannerFound) {
      // "Empty" is also a resolved outcome — nothing to scan, but the
      // location has been checked, so it counts toward the bay same as one.
      await completeLocation(tree, { auditId, layout: layoutName, rack: rackCode, bay: bayCodeForLoc(selectedLocObj.code), loc: selectedLocObj.code });
    }
    const locs = scannableLocations;
    const idx = selectedLocObj ? locs.findIndex((l) => l.code === selectedLocObj.code) : -1;
    const next = idx !== -1 ? locs[idx + 1] : undefined;
    if (!next) {
      setSkuPanelOpen(false);
      return;
    }
    selectLocation(next.code);
  };

  // One scan per pallet — a new scan replaces whatever was scanned before,
  // it doesn't accumulate into a list. The SKU identity check decides what
  // happens next: right SKU opens the qty/condition form, wrong SKU is
  // "Misplaced" with nothing further to fill in.
  const applySkuScan = (pick: { sku: string; name: string; lot: string }) => {
    // Scanning only ever confirms SKU identity — quantity and damage are
    // NOT known from the scan itself. These placeholder values never reach
    // the screen: the compare view shows "-" and the two field cards stay
    // unchecked until the inspector deliberately enters what they actually
    // found for each.
    const line: CountLine = {
      sku: pick.sku,
      name: pick.name,
      lot: pick.lot,
      qty: 0,
      condition: 'Good',
      source: 'scan',
      // Carries forward whatever was already answered before this scan —
      // the pallet condition question doesn't depend on the SKU scan at all.
      palletConditionGood: palletConditionGood ?? undefined,
    };
    setScanLines([line]);
    setNoScannerFound(false);
    setQtyChecked(false);
    setDamageChecked(false);
    setQtyEditing(false);
    setDamageEditing(false);
    if (selectedLocObj) applyLocationStatus(selectedLocObj.code, line, expectedSkus[0] ?? null, false, false);
  };

  // Manual Mode's scan just identifies what's on the pallet — there's no
  // expected SKU to compare against, so it only fills in the report form's
  // SKU/name/lot and reveals it (qty/damage/evidence are still up to the
  // inspector to fill in afterward).
  const applyManualSkuScan = (pick: { sku: string; name: string; lot: string }) => {
    setManualLine((prev) => ({ ...prev, sku: pick.sku, name: pick.name, lot: pick.lot }));
    setManualScanned(true);
    // A fresh identity means a fresh report — qty/damage aren't known from
    // the scan itself here either, same as normal mode's applySkuScan.
    setQtyChecked(false);
    setDamageChecked(false);
    setQtyEditing(false);
    setDamageEditing(false);
  };

  const handleSkuScanned = (data: string) => {
    const code = data.trim();
    const pick = INVENTORY_POOL.find((p) => p.sku === code) ?? { sku: code, name: 'Unlisted SKU', lot: '—' };
    if (formIsManual) {
      applyManualSkuScan(pick);
      return;
    }
    applySkuScan(pick);
  };

  const handleSkuSimulated = () => {
    if (formIsManual) {
      applyManualSkuScan(INVENTORY_POOL[skuScanCount % INVENTORY_POOL.length]);
      setSkuScanCount((c) => c + 1);
      return;
    }
    // Mostly scan the expected SKU (the common case), occasionally
    // simulate a misplaced item to demo that path too.
    const expected = expectedSkus[0];
    const useExpected = expected && skuScanCount % 3 !== 0;
    applySkuScan(useExpected ? expected : INVENTORY_POOL[skuScanCount % INVENTORY_POOL.length]);
    setSkuScanCount((c) => c + 1);
  };

  const handleRaiseIssue = (sku: string) => {
    setIssuesRaised((prev) => new Set(prev).add(sku));
    if (selectedLocObj) setFlaggedLocs((prev) => new Set(prev).add(selectedLocObj.code));
  };

  // Quantity and damage are independent findings on a pallet — each gets
  // its own evidence, kept on whichever line is live right now (manualLine
  // in Manual Mode, scanLines[0] otherwise — this screen's flow never has
  // more than one line open at a time in either mode).
  const ensureFieldEvidence = (field: 'qtyEvidence' | 'damageEvidence'): Evidence =>
    scannedLine?.[field] ?? { note: '', noteOpen: false, audio: null, images: [], videos: [] };

  const updateFieldEvidence = (field: 'qtyEvidence' | 'damageEvidence', patch: Partial<Evidence>) => {
    if (!scannedLine) return;
    updateCurrentLine({ [field]: { ...ensureFieldEvidence(field), ...patch } });
  };

  // Manual Mode always offers this once a field's checked — reporting a
  // problem is the whole point there, and there's no expected value to
  // gate a mismatch on the way normal mode's version of this button is.
  const raiseFieldIssue = (kind: 'qty' | 'damage') => {
    if (!selectedLocObj || !scannedLine) return;
    updateCurrentLine({
      issueRaised: true,
      qtyIssueRaised: kind === 'qty' ? true : scannedLine.qtyIssueRaised,
      damageIssueRaised: kind === 'damage' ? true : scannedLine.damageIssueRaised,
    });
    handleRaiseIssue(scannedLine.sku);
  };

  // Commits the quantity the inspector says they actually found — parses the
  // input, updates the line, marks Quantity as checked (unlocking its
  // Matched/Mismatched badge in normal mode), and refreshes the canvas cell
  // color (normal mode only — Manual Mode pallets don't drive that color).
  const handleConfirmQty = () => {
    if (!scannedLine || !selectedLocObj) return;
    const n = parseInt(qtyInputText, 10);
    const qty = Number.isNaN(n) ? 0 : Math.max(0, n);
    updateCurrentLine({ qty });
    setQtyChecked(true);
    setQtyEditing(false);
    if (!formIsManual) applyLocationStatus(selectedLocObj.code, { ...scannedLine, qty }, expectedSkus[0] ?? null, true, damageChecked);
  };

  // Same as quantity, but damage is chosen from the chip picker rather than
  // typed — selecting a chip both records the value and confirms it in one
  // tap, so there's no separate "Confirm" step.
  // Picking an Activity Phase resets whatever Observation was drafted for
  // the previous phase — the two options lists don't overlap in general, so
  // an old selection could otherwise silently carry over as invalid.
  const handleSelectActivityPhase = (phase: ActivityPhase) => {
    setDamagePhaseDraft(phase);
    setDamageObservationDraft(null);
  };

  // Commits both Activity Phase and Observation together — selecting either
  // one alone doesn't describe the damage found, so Damage only becomes
  // "checked" once both are picked and confirmed.
  const handleConfirmDamage = () => {
    if (!scannedLine || !selectedLocObj || !damagePhaseDraft || !damageObservationDraft) return;
    updateCurrentLine({ condition: 'Damaged', activityPhase: damagePhaseDraft, observation: damageObservationDraft });
    setDamageChecked(true);
    setDamageEditing(false);
    if (!formIsManual) {
      applyLocationStatus(selectedLocObj.code, { ...scannedLine, condition: 'Damaged', activityPhase: damagePhaseDraft, observation: damageObservationDraft }, expectedSkus[0] ?? null, qtyChecked, true);
    }
  };

  // Manual Mode's whole point is reporting a problem, so saving it always
  // raises the issue (red dot) too. Stays on this pallet afterward — the
  // button itself flips to a confirmed "Issue Raised" state (below) so the
  // tap has visible proof it worked; moving on is a deliberate separate
  // "Next Pallet" action instead of an implicit side effect of saving.
  const handleSaveManualIssue = async () => {
    if (!selectedLocObj) return;
    // Every Manual Mode save both raises an issue and marks its origin —
    // otherwise it's structurally identical to a normal in-scope scan once
    // saved, and Reported Audits has no way to tell them apart.
    const line: CountLine = { ...manualLine, issueRaised: true, source: 'manual' };
    await saveRecord(tree, { auditId, layout: layoutName, rack: rackCode, bay: bayCodeForLoc(selectedLocObj.code), loc: selectedLocObj.code }, [line]);
    setManualLine(line);
    handleRaiseIssue(line.sku);
    // Collapse back to the "tap to see details" summary once saved — same
    // resting state as re-selecting this pallet later.
    setManualReviewExpanded(false);
    // Same auto-advance handleScanNext gives normal mode — jumps to the
    // next pallet in whatever Scan Direction/Scope order is active,
    // instead of leaving the inspector to tap the canvas by hand for
    // wherever's next. Manual Mode already makes every pallet in the rack
    // selectable (isLocSelectable's `manualMode ||`), so scannableLocations
    // here is already the full rack in that same order, not just the
    // audit's in-scope pallets.
    const locs = scannableLocations;
    const idx = locs.findIndex((l) => l.code === selectedLocObj.code);
    const next = idx !== -1 ? locs[idx + 1] : undefined;
    if (!next) {
      setSkuPanelOpen(false);
      return;
    }
    selectLocation(next.code);
  };

  const handleSaveSkuPanel = async () => {
    if (selectedLocObj && scanLines.length) {
      const ref = { auditId, layout: layoutName, rack: rackCode, bay: bayCodeForLoc(selectedLocObj.code), loc: selectedLocObj.code };
      await saveRecord(tree, ref, scanLines);
      await completeLocation(tree, ref);
    }
    setSkuPanelOpen(false);
  };

  // Feeds the beforeRemove listener registered near the top of this
  // component — kept in sync every render so leaving this screen any way
  // (header back arrow, hardware/gesture back) asks first whenever a
  // pallet's record is open with something on it worth keeping (scanned,
  // not yet advanced past), instead of silently discarding it.
  skuPanelOpenRef.current = skuPanelOpen;
  hasPendingRecordRef.current = skuPanelOpen && (formIsManual ? manualScanned : scanLines.length > 0);
  saveThenLeaveRef.current = async () => {
    if (formIsManual) {
      await handleSaveManualIssue();
    } else {
      await handleSaveSkuPanel();
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: tokens.muted }}>
      <AppHeader
        title={audit.audit_name}
        sub={audit.audit_id}
        showBack
        onBack={confirmBack}
        menuItems={[{ label: 'Sync Now', onPress: () => {} }]}
        backgroundColor="#F7F8FA"
      />

      <View style={[styles.toolbar, { backgroundColor: tokens.card, borderBottomColor: tokens.border }]}>
        <View>
          <ToolbarField label={layoutObj.name} open={pickerField === 'layout'} onPress={() => setPickerField(pickerField === 'layout' ? null : 'layout')} />
          {pickerField === 'layout' ? (
            <>
              <Pressable style={StyleSheet.absoluteFill} onPress={() => setPickerField(null)} />
              <InlineDropdown options={layoutOptions} selectedValue={layoutName} onSelect={handlePickLayout} />
            </>
          ) : null}
        </View>
        <View>
          <ToolbarField label={`Rack ${rackObj.code}`} open={pickerField === 'rack'} onPress={() => setPickerField(pickerField === 'rack' ? null : 'rack')} />
          {pickerField === 'rack' ? (
            <>
              <Pressable style={StyleSheet.absoluteFill} onPress={() => setPickerField(null)} />
              <InlineDropdown options={rackOptions} selectedValue={rackCode} onSelect={handlePickRack} />
            </>
          ) : null}
        </View>
        <View>
          <ToolbarField
            label={bayFilter === 'all' ? 'All Bays' : `Bay ${bayFilter}`}
            open={pickerField === 'bay'}
            onPress={() => setPickerField(pickerField === 'bay' ? null : 'bay')}
          />
          {pickerField === 'bay' ? (
            <>
              <Pressable style={StyleSheet.absoluteFill} onPress={() => setPickerField(null)} />
              <InlineDropdown
                options={bayOptions}
                selectedValue={bayFilter}
                onSelect={(v) => {
                  setBayFilter(v);
                  setPickerField(null);
                }}
              />
            </>
          ) : null}
        </View>
        <View>
          <ToolbarField
            label={selectedLocObj ? palletIdFor(selectedLocObj, bayCodeForLoc(selectedLocObj.code)) : 'Select Pallet'}
            open={pickerField === 'pallet'}
            onPress={() => setPickerField(pickerField === 'pallet' ? null : 'pallet')}
          />
          {pickerField === 'pallet' ? (
            <>
              <Pressable style={StyleSheet.absoluteFill} onPress={() => setPickerField(null)} />
              <InlineDropdown options={palletOptions} selectedValue={selectedLoc ?? ''} onSelect={handlePickPallet} />
            </>
          ) : null}
        </View>
        <ManualModeToggle value={manualMode} onToggle={handleToggleManualMode} />
        <Pressable
          onPress={() => setPendingModalOpen(true)}
          style={[styles.pendingBtn, { backgroundColor: tokens.card, borderColor: tokens.border, borderRadius: tokens.radius.lg, marginLeft: 'auto' }]}
        >
          <Ionicons name="alert-circle-outline" size={16} color={tokens.rag.amber.strong} />
          <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.semibold, fontSize: tokens.text.xs }}>Unresolved Locations</Text>
          {pendingLocations.length + emptyLocations.length ? (
            <View style={[styles.pendingCountBadge, { backgroundColor: tokens.rag.amber.strong, borderRadius: tokens.radius.xl }]}>
              <Text style={{ color: '#fff', fontSize: tokens.text.xxs, fontWeight: tokens.fontWeight.bold }}>{pendingLocations.length + emptyLocations.length}</Text>
            </View>
          ) : null}
        </Pressable>
      </View>

      {manualMode ? (
        <View style={[styles.manualModeBanner, { backgroundColor: tokens.rag.amber.soft, borderBottomColor: tokens.rag.amber.border }]}>
          <Ionicons name="warning-outline" size={14} color={tokens.rag.amber.strong} />
          <Text style={{ color: tokens.rag.amber.strong, fontWeight: tokens.fontWeight.semibold, fontSize: tokens.text.xs, flex: 1 }}>
            Manual Mode — every pallet in this rack is selectable, outside this audit's assigned scope too. Pick a location, scan the SKU that's actually there, and report what you found.
          </Text>
        </View>
      ) : null}

      <View style={styles.body}>
        {/* Canvas and the Reconciliation Form sit side by side, both full
            height, once a pallet's audit is started — not a small overlay —
            so the canvas highlight and the form stay visible together. */}
        <View style={skuPanelOpen ? styles.splitRow : styles.singleRow}>
        {/* flex: 1.5 vs. the SKU panel's flex: 1 below — a 60/40 split
            favoring the canvas, only meaningful once splitRow is active
            (singleRow ignores the ratio since the canvas is alone). */}
        <Card style={{ padding: 0, overflow: 'hidden', flex: skuPanelOpen ? 1.5 : 1 }}>
          <View style={[styles.diagramHeadRow, { backgroundColor: '#F7F8FA', borderBottomColor: tokens.border, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }]}>
            <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm }}>
              Front View — Rack {rackObj.code} — {rackObj.bays.length} Bay{rackObj.bays.length === 1 ? '' : 's'}
            </Text>
            <View style={styles.directionAnchor}>
              {/* Status badge — shows the active pattern, purely informational,
                  kept separate from the settings icon below so the two don't
                  read as one confusing combined tap target. */}
              <View style={[styles.directionBadge, { backgroundColor: tokens.accentBlue.soft, borderRadius: tokens.radius.xl }]}>
                <Ionicons
                  name={scanDirection === 'up' || scanDirection === 'down' ? 'swap-vertical-outline' : 'swap-horizontal-outline'}
                  size={14}
                  color={tokens.accentBlue.strong}
                />
                <Text style={{ color: tokens.accentBlue.strong, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.xs }}>
                  {scanDirection === 'up' || scanDirection === 'down' ? 'Vertical' : 'Horizontal'}
                  {scanScope === 'bay' ? ' · Each Bay' : ' · Whole Rack'}
                </Text>
                <Ionicons name={scanDirectionArrowIcon(scanDirection)} size={14} color={tokens.accentBlue.strong} />
              </View>
              {/* Settings icon — the actual tap target that opens the centered Scan Direction modal. */}
              <Pressable
                onPress={() => setDirectionMenuOpen((v) => !v)}
                style={[styles.directionSettingsBtn, { borderColor: directionMenuOpen ? tokens.primary : tokens.border, backgroundColor: tokens.card, borderRadius: tokens.radius.lg }]}
              >
                <Ionicons name="options-outline" size={16} color={tokens.foreground} />
              </Pressable>
              <ScanDirectionMenu
                visible={directionMenuOpen}
                direction={scanDirection}
                scope={scanScope}
                onSelectScope={setScanScope}
                onSelect={(d) => {
                  setScanDirection(d);
                  setDirectionMenuOpen(false);
                }}
                onClose={() => setDirectionMenuOpen(false)}
              />
            </View>
          </View>
          <View style={styles.diagramBody}>
            <GestureDetector gesture={canvasGesture}>
              <View style={styles.diagramCenter}>
                <Animated.View style={canvasAnimatedStyle}>
                  <View style={styles.bayColumnsRow}>
                    {bayDiagrams.map(({ bay, rows }, bayIndex) => (
                      <View key={bay.code} style={styles.bayColumnWrap}>
                        {/* The upright between adjacent bays — a real rack's
                            physical frame member — instead of repeating the
                            level label on every single bay. */}
                        {bayIndex > 0 ? <View style={[styles.bayUpright, { backgroundColor: tokens.border }]} /> : null}
                        <View style={styles.bayColumn}>
                          <View style={styles.diagram}>
                            {rows.map((row) => (
                              <View key={row.level} style={styles.diagramRow}>
                                {bayIndex === 0 ? (
                                  <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xs, width: 22 }}>L{row.level}</Text>
                                ) : null}
                                <View style={styles.diagramCells}>
                                  {/* A level with fewer than the full slot
                                      count (e.g. 2 pallets on an even level
                                      vs. 3 on an odd one) is a real, deliberate
                                      shape of that beam — not a gap waiting to
                                      be filled — so its cells stretch to
                                      occupy the whole row width instead of
                                      leaving a small faded stub cell where the
                                      missing slot would've been. */}
                                  {(() => {
                                    const realCells = row.cells.filter((c): c is NonNullable<typeof c> => !!c);
                                    const cellWidth =
                                      realCells.length > 0 && realCells.length < RACK_DIAGRAM_SLOTS_PER_LEVEL
                                        ? (FULL_DIAGRAM_ROW_WIDTH - (realCells.length - 1) * DIAGRAM_CELL_GAP) / realCells.length
                                        : undefined;
                                    return realCells.map((cell) => {
                                    // Canvas <-> dropdown selection is the
                                    // same `selectedLoc` value both ways, so
                                    // tapping a cell here updates the
                                    // toolbar's Pallet field automatically.
                                    const selected = cell.code === selectedLoc;
                                    const status = locationStatus[cell.code];
                                    const highlighted = isLocHighlighted(cell.code);
                                    const selectable = isLocSelectable(cell.code);
                                    const manualOnly = isManualOnly(cell.code);
                                    const dimmed = !selectable;
                                    // Selection wins over status/highlight
                                    // coloring entirely — a light blue fill
                                    // with a dark blue border, blinking,
                                    // so the currently-selected pallet is
                                    // unmistakable on a busy canvas.
                                    // Selection only overrides the fill for
                                    // a not-yet-resolved pallet (plain
                                    // blue = "this is what's selected right
                                    // now, nothing decided yet"). Once a
                                    // pallet has a real status, re-selecting
                                    // it keeps that true color — only the
                                    // border turns dark blue and blinks —
                                    // so its resolved state stays visible.
                                    const bg =
                                      status === 'matched'
                                        ? tokens.rag.green.soft
                                        : status === 'issue'
                                          ? tokens.rag.amber.soft
                                          : status === 'mismatch'
                                            ? tokens.rag.red.soft
                                            : status === 'missing'
                                              ? tokens.slate400
                                              : selected
                                                ? '#BFDBFE'
                                                : highlighted
                                                  ? tokens.slate300
                                                  : tokens.muted;
                                    const border = selected
                                      ? '#1D4ED8'
                                      : status === 'matched'
                                        ? tokens.rag.green.border
                                        : status === 'issue'
                                          ? tokens.rag.amber.border
                                          : status === 'mismatch'
                                            ? tokens.rag.red.border
                                            : status === 'missing'
                                              ? tokens.mutedForeground
                                              : highlighted
                                                ? tokens.slate400
                                                : manualOnly
                                                  ? tokens.rag.amber.strong
                                                  : tokens.border;
                                    return (
                                      <RackCell
                                        key={cell.code}
                                        bg={bg}
                                        border={border}
                                        selected={selected}
                                        selectable={selectable}
                                        dashed={status === 'missing' || manualOnly}
                                        blinking={selected}
                                        dimmed={dimmed}
                                        flagged={flaggedLocs.has(cell.code)}
                                        width={cellWidth}
                                        onPress={() => selectLocation(cell.code)}
                                      />
                                    );
                                    });
                                  })()}
                                </View>
                              </View>
                            ))}
                          </View>
                          <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xs, textAlign: 'center', marginTop: 10 }}>Bay {bay.code}</Text>
                        </View>
                      </View>
                    ))}
                  </View>
                </Animated.View>
              </View>
            </GestureDetector>
            {!skuPanelOpen ? (
              <View style={styles.footerRow}>
                <Pressable onPress={() => setSelectedLoc(null)} style={[styles.outlineBtn, styles.footerBtn, { borderColor: tokens.border, borderRadius: tokens.radius.lg }]}>
                  <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.semibold, fontSize: tokens.text.sm }}>Cancel</Text>
                </Pressable>
                <Pressable
                  disabled={!selectedLoc}
                  onPress={handleStartAudit}
                  style={[styles.primaryBtn, styles.footerBtn, { backgroundColor: tokens.primary, borderRadius: tokens.radius.lg, opacity: selectedLoc ? 1 : 0.5 }]}
                >
                  <Text style={{ color: tokens.primaryForeground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm }}>Start Audit</Text>
                  <Ionicons name="chevron-forward" size={16} color={tokens.primaryForeground} />
                </Pressable>
              </View>
            ) : null}
          </View>
        </Card>

        {skuPanelOpen ? (
          <Card style={styles.skuPanel}>
            {/* Header carries only the form name, banded the same way as
                the canvas card's "Front View" header — location/pallet
                identity is its own precise detail block below, and
                scanning happens from the dotted scan target further down,
                not a header icon. */}
            {/* This Card (unlike the canvas one) isn't overflow:'hidden',
                so the header's negative-margin bleed needs its own top
                corner radius — otherwise it'd sit square against the
                Card's own rounded corners instead of matching them. */}
            <View
              style={[
                styles.skuPanelHead,
                { backgroundColor: '#F7F8FA', borderBottomColor: tokens.border, borderTopLeftRadius: tokens.radius.xxl, borderTopRightRadius: tokens.radius.xxl },
              ]}
            >
              <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm }}>
                {formIsManual ? 'Manual Issue Report' : 'Reconciliation Form'}
              </Text>
            </View>

            <Text style={{ color: tokens.mutedForeground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.xxs, textTransform: 'uppercase', marginBottom: 8 }}>
              Selected Location Details
            </Text>
            <View style={styles.locDetailsBox}>
              <DetailRow label="Location Code" value={selectedLocObj?.code ?? '—'} tokens={tokens} />
              <DetailRow label="Rack" value={rackObj.code} tokens={tokens} />
              <DetailRow label="Bay" value={selectedLocObj ? bayCodeForLoc(selectedLocObj.code) : '—'} tokens={tokens} />
              <DetailRow label="Pallet" value={selectedLocObj ? palletIdFor(selectedLocObj) : '—'} tokens={tokens} />
            </View>
            <View style={[styles.divider, { backgroundColor: tokens.border }]} />

            <ScrollView style={{ flex: 1 }} contentContainerStyle={{ flexGrow: 1, gap: 10, paddingBottom: 10 }}>
              {formIsManual && manualRaised && !manualReviewExpanded ? (
                // Already reported — collapsed by default instead of
                // reopening the full form every time this pallet is
                // re-selected. Whole card is tappable, not just an icon.
                <Pressable
                  onPress={() => setManualReviewExpanded(true)}
                  style={[styles.manualSummaryBox, { backgroundColor: tokens.card, borderColor: tokens.border, borderRadius: tokens.radius.xl }]}
                >
                  <View style={[styles.editStatusPill, { backgroundColor: tokens.rag.green.soft, borderColor: tokens.rag.green.border, borderRadius: tokens.radius.lg }]}>
                    <Text style={{ color: tokens.rag.green.strong, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.xs }}>Issue Raised</Text>
                  </View>
                  <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm }}>{manualLine.sku}</Text>
                  <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xs, marginTop: 1 }}>{manualLine.name}</Text>
                  <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xs, marginTop: 5 }}>
                    Qty {manualLine.qty} · {manualLine.condition}
                  </Text>
                  <Text style={{ color: tokens.primary, fontWeight: tokens.fontWeight.semibold, fontSize: tokens.text.xs, marginTop: 10 }}>Tap to see details</Text>
                </Pressable>
              ) : (
                <>
                <View style={[styles.fieldCard, { backgroundColor: tokens.card, borderWidth: 0, borderRadius: tokens.radius.xl }]}>
                  <View style={[styles.fieldCardBody, { paddingHorizontal: 0, paddingVertical: 0 }]}>
                    <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm }}>Is the pallet condition at this location good?</Text>
                    <View style={styles.condGrid}>
                      {([
                        { label: 'Good', value: true },
                        { label: 'Not Good', value: false },
                      ] as const).map((opt) => {
                        const selected = palletConditionGood === opt.value;
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

                {noScannerFound ? (
                  <View style={[styles.noScannerRow, { backgroundColor: tokens.slate300, borderColor: tokens.mutedForeground, borderRadius: tokens.radius.lg }]}>
                    <Ionicons name="alert-circle" size={20} color={tokens.mutedForeground} />
                    <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.semibold, fontSize: tokens.text.sm, flex: 1 }}>
                      Marked Empty — no scanner code found at this location
                    </Text>
                  </View>
                ) : null}

                {!scannedLine && !noScannerFound ? (
                  // The one way into a scan — a dotted target, not a corner
                  // icon, so it reads as "this is the thing to do next"
                  // rather than a secondary action. Stretches to fill the
                  // empty space below the location details instead of
                  // leaving it blank, and explains itself below rather than
                  // assuming the icon alone is self-evident.
                  <>
                    <Pressable
                      onPress={() => setScannerOpen('sku')}
                      style={[styles.scanDottedBox, { borderColor: tokens.mutedForeground, borderRadius: tokens.radius.xl }]}
                    >
                      <View style={[styles.scanDottedIconWrap, { backgroundColor: tokens.primary }]}>
                        <Ionicons name="qr-code-outline" size={26} color={tokens.primaryForeground} />
                      </View>
                      <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.semibold, fontSize: tokens.text.sm, marginTop: 10 }}>Tap to Scan SKU</Text>
                    </Pressable>
                    <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xs, textAlign: 'center' }}>
                      {formIsManual
                        ? 'Scans the SKU code on this pallet so you can report what you actually found here.'
                        : "Scans the SKU code on the pallet at this location, then checks it against what's expected here."}
                    </Text>
                  </>
                ) : null}

                {scannedLine ? (
                  (() => {
                    // Primary status is SKU identity only: Matched or
                    // Misplaced. Quantity/condition issues only matter once
                    // the SKU itself is right, so they render as smaller
                    // secondary pills alongside "Matched", never in place of it.
                    const primary = misplaced ? { label: 'Mismatch', rag: tokens.rag.red } : { label: 'Matched', rag: tokens.rag.green };
                    const qtyMismatch = !misplaced && qtyChecked && scannedLine.qty !== expectedSku?.qty;
                    const conditionFlagged = !misplaced && damageChecked && scannedLine.condition !== 'Good';
                    const raised = issuesRaised.has(scannedLine.sku);
                    return (
                      <>
                        {!formIsManual ? (
                          <>
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
                            <View style={styles.compareRow}>
                              <View style={[styles.compareCol, { backgroundColor: tokens.card, borderColor: tokens.border, borderRadius: tokens.radius.xl }]}>
                                <Text style={{ color: tokens.mutedForeground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.xxs, textTransform: 'uppercase' }}>Expected</Text>
                                {expectedSku ? (
                                  <>
                                    <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm, marginTop: 4 }}>{expectedSku.sku}</Text>
                                    <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xs, marginTop: 1 }}>{expectedSku.name}</Text>
                                    <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xs, marginTop: 5 }}>Qty {expectedSku.qty}</Text>
                                  </>
                                ) : (
                                  <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xs, marginTop: 4 }}>Nothing expected</Text>
                                )}
                              </View>
                              <View style={[styles.compareCol, { backgroundColor: tokens.card, borderColor: tokens.border, borderRadius: tokens.radius.xl }]}>
                                <Text style={{ color: tokens.mutedForeground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.xxs, textTransform: 'uppercase' }}>Scanned</Text>
                                {scannedLine ? (
                                  <>
                                    <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm, marginTop: 4 }}>{scannedLine.sku}</Text>
                                    <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xs, marginTop: 1 }}>{scannedLine.name}</Text>
                                    <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xs, marginTop: 5 }}>
                                      Qty {qtyChecked ? scannedLine.qty : '-'} · {damageChecked ? scannedLine.condition : '-'}
                                    </Text>
                                  </>
                                ) : (
                                  <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xs, marginTop: 4 }}>Not scanned yet</Text>
                                )}
                              </View>
                            </View>
                          </>
                        ) : null}
                        {misplaced ? (
                          // Wrong SKU is known the instant the scan resolves
                          // — nothing to enter, so this raises the issue
                          // directly rather than opening the qty/damage form.
                          <Pressable
                            disabled={raised}
                            onPress={() => {
                              const next = scanLines.slice();
                              next[0] = { ...next[0], issueRaised: true };
                              setScanLines(next);
                              handleRaiseIssue(scannedLine.sku);
                            }}
                            style={[
                              styles.raiseIssueBox,
                              {
                                backgroundColor: raised ? tokens.rag.green.soft : tokens.rag.red.soft,
                                borderColor: raised ? tokens.rag.green.border : tokens.rag.red.border,
                                borderRadius: tokens.radius.lg,
                              },
                            ]}
                          >
                            <Ionicons name={raised ? 'checkmark-circle' : 'flag'} size={18} color={raised ? tokens.rag.green.strong : tokens.rag.red.strong} />
                            <Text style={{ color: raised ? tokens.rag.green.strong : tokens.rag.red.strong, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm, flex: 1 }}>
                              {raised ? 'Issue raised for this SKU' : 'Raise Issue — wrong item scanned'}
                            </Text>
                            {!raised ? <Text style={{ color: tokens.rag.red.strong, fontWeight: tokens.fontWeight.semibold, fontSize: tokens.text.xs }}>Tap to raise</Text> : null}
                          </Pressable>
                        ) : (
                          // SKU matched — quantity and damage are two
                          // independent findings on this pallet (an inspector
                          // can raise one, the other, both, or neither), so
                          // each gets its own entry control, its own Matched/
                          // Mismatched status, and its own Raise Issue button
                          // rather than a single combined subform.
                          <>
                            <View style={[styles.fieldCard, { backgroundColor: tokens.card, borderColor: tokens.border, borderRadius: tokens.radius.xl }]}>
                              <View style={[styles.fieldCardHead, { backgroundColor: '#F7F8FA', borderBottomColor: tokens.border }]}>
                                <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm }}>Issue For 1: Quantity</Text>
                                {!formIsManual && qtyChecked ? (
                                  <View
                                    style={[
                                      styles.editStatusPill,
                                      {
                                        backgroundColor: scannedLine.qty === expectedSku?.qty ? tokens.rag.green.soft : tokens.rag.amber.soft,
                                        borderColor: scannedLine.qty === expectedSku?.qty ? tokens.rag.green.border : tokens.rag.amber.border,
                                        borderRadius: tokens.radius.lg,
                                      },
                                    ]}
                                  >
                                    <Text
                                      style={{
                                        color: scannedLine.qty === expectedSku?.qty ? tokens.rag.green.strong : tokens.rag.amber.strong,
                                        fontWeight: tokens.fontWeight.bold,
                                        fontSize: tokens.text.xs,
                                      }}
                                    >
                                      {scannedLine.qty === expectedSku?.qty ? 'Matched' : 'Mismatched'}
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
                                  <Pressable
                                    onPress={() => {
                                      setQtyInputText(qtyChecked ? String(scannedLine.qty) : '');
                                      setQtyEditing(true);
                                    }}
                                    style={styles.fieldValueRow}
                                  >
                                    <Text style={{ color: tokens.foreground, fontSize: tokens.text.sm }}>
                                      Qty found: <Text style={{ fontWeight: tokens.fontWeight.bold }}>{qtyChecked ? scannedLine.qty : '-'}</Text>
                                    </Text>
                                    <View style={[styles.editIconBtn, { backgroundColor: tokens.muted, borderRadius: tokens.radius.sm }]}>
                                      <Ionicons name={qtyChecked ? 'create-outline' : 'add'} size={14} color={tokens.primary} />
                                    </View>
                                  </Pressable>
                                )}
                                {(formIsManual ? qtyChecked : qtyChecked && scannedLine.qty !== expectedSku?.qty) ? (
                                  <Pressable
                                    disabled={!!scannedLine.qtyIssueRaised}
                                    onPress={() => raiseFieldIssue('qty')}
                                    style={[
                                      styles.raiseIssueBox,
                                      {
                                        backgroundColor: scannedLine.qtyIssueRaised ? tokens.rag.green.soft : tokens.rag.red.soft,
                                        borderColor: scannedLine.qtyIssueRaised ? tokens.rag.green.border : tokens.rag.red.border,
                                        borderRadius: tokens.radius.lg,
                                      },
                                    ]}
                                  >
                                    <Ionicons name={scannedLine.qtyIssueRaised ? 'checkmark-circle' : 'flag'} size={16} color={scannedLine.qtyIssueRaised ? tokens.rag.green.strong : tokens.rag.red.strong} />
                                    <Text style={{ color: scannedLine.qtyIssueRaised ? tokens.rag.green.strong : tokens.rag.red.strong, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.xs, flex: 1 }}>
                                      {scannedLine.qtyIssueRaised ? 'Issue raised for quantity' : 'Raise Issue — quantity'}
                                    </Text>
                                  </Pressable>
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
                                        backgroundColor: scannedLine.condition === 'Good' ? tokens.rag.green.soft : tokens.rag.amber.soft,
                                        borderColor: scannedLine.condition === 'Good' ? tokens.rag.green.border : tokens.rag.amber.border,
                                        borderRadius: tokens.radius.lg,
                                      },
                                    ]}
                                  >
                                    <Text
                                      style={{
                                        color: scannedLine.condition === 'Good' ? tokens.rag.green.strong : tokens.rag.amber.strong,
                                        fontWeight: tokens.fontWeight.bold,
                                        fontSize: tokens.text.xs,
                                      }}
                                    >
                                      {scannedLine.condition === 'Good' ? 'Matched' : 'Mismatched'}
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
                                          <Pressable
                                            key={phase}
                                            onPress={() => handleSelectActivityPhase(phase)}
                                            style={styles.condChip}
                                          >
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
                                            <Pressable
                                              key={obs}
                                              onPress={() => setDamageObservationDraft(obs)}
                                              style={styles.condChip}
                                            >
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
                                  <Pressable
                                    onPress={() => {
                                      setDamagePhaseDraft(damageChecked ? (scannedLine.activityPhase ?? null) : null);
                                      setDamageObservationDraft(damageChecked ? (scannedLine.observation ?? null) : null);
                                      setDamageEditing(true);
                                    }}
                                    style={styles.fieldValueRow}
                                  >
                                    <View style={{ flex: 1 }}>
                                      <Text style={{ color: tokens.foreground, fontSize: tokens.text.sm }}>
                                        Damage found: <Text style={{ fontWeight: tokens.fontWeight.bold }}>{damageChecked ? (scannedLine.observation ?? scannedLine.condition) : '-'}</Text>
                                      </Text>
                                      {damageChecked && scannedLine.activityPhase ? (
                                        <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xs, marginTop: 2 }}>{scannedLine.activityPhase}</Text>
                                      ) : null}
                                    </View>
                                    <View style={[styles.editIconBtn, { backgroundColor: tokens.muted, borderRadius: tokens.radius.sm }]}>
                                      <Ionicons name={damageChecked ? 'create-outline' : 'add'} size={14} color={tokens.primary} />
                                    </View>
                                  </Pressable>
                                )}
                                {damageChecked && scannedLine.condition !== 'Good' ? (
                                  <Pressable
                                    disabled={!!scannedLine.damageIssueRaised}
                                    onPress={() => raiseFieldIssue('damage')}
                                    style={[
                                      styles.raiseIssueBox,
                                      {
                                        backgroundColor: scannedLine.damageIssueRaised ? tokens.rag.green.soft : tokens.rag.red.soft,
                                        borderColor: scannedLine.damageIssueRaised ? tokens.rag.green.border : tokens.rag.red.border,
                                        borderRadius: tokens.radius.lg,
                                      },
                                    ]}
                                  >
                                    <Ionicons name={scannedLine.damageIssueRaised ? 'checkmark-circle' : 'flag'} size={16} color={scannedLine.damageIssueRaised ? tokens.rag.green.strong : tokens.rag.red.strong} />
                                    <Text style={{ color: scannedLine.damageIssueRaised ? tokens.rag.green.strong : tokens.rag.red.strong, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.xs, flex: 1 }}>
                                      {scannedLine.damageIssueRaised ? 'Issue raised for damage' : 'Raise Issue — damage'}
                                    </Text>
                                  </Pressable>
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
                  })()
                ) : null}
                </>
              )}
            </ScrollView>
            {formIsManual ? (
              // No separate "Next Pallet" button — Raise Issue already
              // both saves and auto-advances to the next pallet in the
              // active Scan Direction/Scope order (see handleSaveManualIssue),
              // same as normal mode's Scan Next SKU. Cancel just closes.
              <View style={[styles.skuPanelFooter, { borderTopColor: tokens.border }]}>
                <Pressable onPress={() => setSkuPanelOpen(false)} style={[styles.outlineBtn, { flex: 1, backgroundColor: tokens.muted, borderColor: tokens.border, borderRadius: tokens.radius.lg }]}>
                  <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.semibold, fontSize: tokens.text.sm }}>Cancel</Text>
                </Pressable>
                <Pressable
                  disabled={!manualScanned || (manualRaised && !manualReviewExpanded)}
                  onPress={handleSaveManualIssue}
                  style={[
                    styles.primaryBtn,
                    {
                      flex: 1,
                      backgroundColor: tokens.primary,
                      borderRadius: tokens.radius.lg,
                      opacity: !manualScanned || (manualRaised && !manualReviewExpanded) ? 0.5 : 1,
                    },
                  ]}
                >
                  <Text style={{ color: tokens.primaryForeground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm }}>
                    {manualRaised && !manualReviewExpanded ? 'Issue Raised ✓' : 'Raise Issue'}
                  </Text>
                </Pressable>
              </View>
            ) : (
              <View style={[styles.skuPanelFooter, { borderTopColor: tokens.border }]}>
                <Pressable onPress={() => setSkuPanelOpen(false)} style={[styles.outlineBtn, { flex: 1, backgroundColor: tokens.muted, borderColor: tokens.border, borderRadius: tokens.radius.lg }]}>
                  <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.semibold, fontSize: tokens.text.sm }}>Cancel</Text>
                </Pressable>
                <Pressable
                  disabled={noScannerFound}
                  onPress={() => handleToggleNoScannerFound(true)}
                  style={[styles.outlineBtn, { flex: 1, backgroundColor: tokens.muted, borderColor: tokens.border, borderRadius: tokens.radius.lg, opacity: noScannerFound ? 0.5 : 1 }]}
                >
                  <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.semibold, fontSize: tokens.text.sm }}>{noScannerFound ? 'Marked Empty' : 'Empty'}</Text>
                </Pressable>
                <Pressable
                  disabled={!scannedLine && !noScannerFound}
                  onPress={handleScanNext}
                  style={[styles.primaryBtn, { flex: 1, backgroundColor: tokens.primary, borderRadius: tokens.radius.lg, opacity: scannedLine || noScannerFound ? 1 : 0.5 }]}
                >
                  <Text style={{ color: tokens.primaryForeground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm }}>Save & Scan Next</Text>
                </Pressable>
              </View>
            )}
          </Card>
        ) : null}
        </View>
      </View>

      <BarcodeScannerModal
        visible={scannerOpen === 'sku'}
        title="Scan SKU"
        hint="Point at the SKU QR code on the pallet"
        onScanned={(data) => {
          setScannerOpen(null);
          handleSkuScanned(data);
        }}
        onUseSimulated={() => {
          setScannerOpen(null);
          handleSkuSimulated();
        }}
        onClose={() => setScannerOpen(null)}
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
      <Modal visible={pendingModalOpen} transparent statusBarTranslucent animationType="fade" onRequestClose={() => setPendingModalOpen(false)}>
        <Pressable style={[styles.backdrop, { backgroundColor: 'rgba(0,0,0,0.5)' }]} onPress={() => setPendingModalOpen(false)}>
          <Pressable
            style={[styles.pendingModalCard, { backgroundColor: tokens.popover, borderRadius: tokens.radius.xl }]}
            onPress={(e) => e.stopPropagation()}
          >
            <View style={styles.pendingModalHead}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Ionicons name="alert-circle-outline" size={18} color={tokens.rag.amber.strong} />
                <Text style={{ color: tokens.popoverForeground, fontWeight: tokens.fontWeight.extrabold, fontSize: tokens.text.base }}>
                  Unresolved Locations
                </Text>
              </View>
              <Pressable onPress={() => setPendingModalOpen(false)} hitSlop={8}>
                <Ionicons name="close" size={20} color={tokens.foreground} />
              </Pressable>
            </View>

            <View style={styles.pendingTabRow}>
              <Pressable
                onPress={() => setPendingTab('pending')}
                style={[
                  styles.pendingTabBtn,
                  {
                    backgroundColor: pendingTab === 'pending' ? tokens.primary : tokens.muted,
                    borderColor: pendingTab === 'pending' ? tokens.primary : tokens.border,
                    borderRadius: tokens.radius.lg,
                  },
                ]}
              >
                <Text
                  style={{
                    color: pendingTab === 'pending' ? tokens.primaryForeground : tokens.foreground,
                    fontWeight: tokens.fontWeight.bold,
                    fontSize: tokens.text.xs,
                  }}
                >
                  Unresolved ({pendingLocations.length})
                </Text>
              </Pressable>
              <Pressable
                onPress={() => setPendingTab('empty')}
                style={[
                  styles.pendingTabBtn,
                  {
                    backgroundColor: pendingTab === 'empty' ? tokens.primary : tokens.muted,
                    borderColor: pendingTab === 'empty' ? tokens.primary : tokens.border,
                    borderRadius: tokens.radius.lg,
                  },
                ]}
              >
                <Text
                  style={{
                    color: pendingTab === 'empty' ? tokens.primaryForeground : tokens.foreground,
                    fontWeight: tokens.fontWeight.bold,
                    fontSize: tokens.text.xs,
                  }}
                >
                  Location Found as Empty ({emptyLocations.length})
                </Text>
              </Pressable>
            </View>

            <View style={[styles.pendingSearchBox, { backgroundColor: tokens.muted, borderColor: tokens.border, borderRadius: tokens.radius.lg }]}>
              <Ionicons name="search" size={15} color={tokens.mutedForeground} />
              <TextInput
                value={pendingSearch}
                onChangeText={setPendingSearch}
                placeholder="Search location, pallet, SKU..."
                placeholderTextColor={tokens.slate400}
                style={{ flex: 1, color: tokens.foreground, fontSize: tokens.text.sm, paddingVertical: 6 }}
              />
            </View>

            {(() => {
              const q = pendingSearch.trim().toLowerCase();
              const sourceList = pendingTab === 'pending' ? pendingLocations : emptyLocations;
              const filtered = sourceList.filter((loc) => {
                if (!q) return true;
                const expected = EXPECTED_SKUS[loc.code]?.[0];
                return [loc.code, palletIdFor(loc, bayCodeForLoc(loc.code)), expected?.sku, expected?.name].join(' ').toLowerCase().includes(q);
              });
              // Bay-wise groups, in the rack's actual bay order — cuts the
              // scroll length down a lot on multi-bay racks, same accordion
              // pattern as Audit Details' bay breakdown.
              const byBay = rackObj.bays
                .map((b) => ({ bay: b, items: filtered.filter((loc) => bayCodeForLoc(loc.code) === b.code) }))
                .filter((g) => g.items.length);

              return (
                <>
                  <View style={[styles.pendingTotalBadge, { backgroundColor: tokens.rag.amber.soft, borderRadius: tokens.radius.lg }]}>
                    <Text style={{ color: tokens.rag.amber.strong, fontSize: tokens.text.xs, fontWeight: tokens.fontWeight.bold }}>
                      Total : {String(filtered.length).padStart(2, '0')}
                    </Text>
                  </View>
                  <ScrollView style={{ maxHeight: 420 }}>
                    {byBay.length ? (
                      byBay.map(({ bay, items }) => {
                        const open = !closedPendingBays[bay.code];
                        return (
                          <View key={bay.code} style={styles.pendingBaySection}>
                            <Pressable
                              onPress={() => setClosedPendingBays((prev) => ({ ...prev, [bay.code]: !prev[bay.code] }))}
                              style={styles.pendingBayHead}
                            >
                              <Ionicons name="server-outline" size={18} color="#667085" />
                              <Text style={{ flex: 1, color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm }}>Bay {bay.code}</Text>
                              <View style={[styles.pendingBayBadge, { backgroundColor: tokens.accentBlue.soft, borderRadius: tokens.radius.lg }]}>
                                <Text style={{ color: tokens.accentBlue.strong, fontSize: tokens.text.xs, fontWeight: tokens.fontWeight.bold }}>
                                  {String(items.length).padStart(2, '0')}
                                </Text>
                              </View>
                              <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={16} color="#667085" />
                            </Pressable>
                            {open ? (
                              <View style={styles.pendingGrid}>
                                {items.map((loc) => {
                                  const expected = EXPECTED_SKUS[loc.code]?.[0];
                                  const saved = loc.pallets.find((p) => p.saved);
                                  const line = saved?.lines[0];
                                  // Mismatch (wrong SKU) never appears in this list — it's
                                  // excluded from pendingLocations entirely as an already-known,
                                  // conclusive result. Only Not Scanned or Qty/Damage remain.
                                  const status =
                                    pendingTab === 'empty'
                                      ? { label: 'Empty', rag: tokens.rag.red }
                                      : !line
                                        ? { label: 'Not Scanned', rag: tokens.rag.amber }
                                        : { label: 'Qty/Damage Issue', rag: tokens.rag.amber };
                                  return (
                                    <Pressable
                                      key={loc.code}
                                      onPress={() => {
                                        setPendingModalOpen(false);
                                        setBayFilter(bayCodeForLoc(loc.code));
                                        selectLocation(loc.code);
                                        setSkuPanelOpen(true);
                                      }}
                                      style={[styles.pendingCard, { backgroundColor: tokens.card, borderColor: tokens.border, borderRadius: tokens.radius.lg }]}
                                    >
                                      <View style={styles.pendingCardHead}>
                                        <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm }} numberOfLines={1}>
                                          {loc.code}
                                        </Text>
                                        <View style={[styles.pendingStatusPill, { backgroundColor: status.rag.soft, borderColor: status.rag.border, borderRadius: tokens.radius.lg }]}>
                                          <Text style={{ color: status.rag.strong, fontSize: tokens.text.xxs, fontWeight: tokens.fontWeight.bold }}>{status.label}</Text>
                                        </View>
                                      </View>
                                      <View style={styles.pendingFieldRow}>
                                        <View style={styles.pendingField}>
                                          <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xxs }}>Pallet</Text>
                                          <Text style={{ color: tokens.foreground, fontSize: tokens.text.xs, fontWeight: tokens.fontWeight.semibold }}>{palletIdFor(loc)}</Text>
                                        </View>
                                        {pendingTab === 'pending' ? (
                                        <View style={styles.pendingField}>
                                          <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xxs }}>Expected SKU</Text>
                                          <Text style={{ color: tokens.foreground, fontSize: tokens.text.xs, fontWeight: tokens.fontWeight.semibold }} numberOfLines={1}>
                                            {expected?.sku ?? '—'}
                                          </Text>
                                        </View>
                                        ) : null}
                                      </View>
                                    </Pressable>
                                  );
                                })}
                              </View>
                            ) : null}
                          </View>
                        );
                      })
                    ) : (
                      <View style={{ alignItems: 'center', gap: 8, paddingVertical: 40 }}>
                        <Ionicons name="checkmark-circle-outline" size={28} color={tokens.mutedForeground} />
                        <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm }}>Nothing pending</Text>
                        <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xs }}>Every in-scope pallet in this rack is matched.</Text>
                      </View>
                    )}
                  </ScrollView>
                </>
              );
            })()}
          </Pressable>
        </Pressable>
      </Modal>

      {confirm.element}
    </View>
  );
}

// A canvas cell owns its own blink animation (a repeating opacity pulse)
// rather than the parent, since starting/stopping a reanimated loop needs a
// hook tied to this specific cell's `blinking` prop — pulses while it's the
// current selection, so it stays unmistakable on a busy canvas.
function RackCell({
  bg,
  border,
  selected,
  selectable,
  dashed,
  blinking,
  dimmed,
  flagged,
  width,
  onPress,
}: {
  bg: string;
  border: string;
  selected: boolean;
  selectable: boolean;
  dashed: boolean;
  blinking: boolean;
  dimmed: boolean;
  flagged: boolean;
  width?: number;
  onPress: () => void;
}) {
  const opacity = useSharedValue(dimmed ? 0.45 : 1);

  useEffect(() => {
    if (blinking) {
      opacity.value = withRepeat(withSequence(withTiming(0.35, { duration: 350 }), withTiming(1, { duration: 350 })), -1, true);
    } else {
      cancelAnimation(opacity);
      opacity.value = withTiming(dimmed ? 0.45 : 1, { duration: 150 });
    }
  }, [blinking, dimmed]);

  const animatedStyle = useAnimatedStyle(() => ({ opacity: opacity.value }));

  return (
    <Pressable disabled={!selectable} onPress={onPress}>
      <Animated.View
        style={[
          styles.cell,
          {
            backgroundColor: bg,
            borderColor: border,
            borderWidth: selected ? 2 : 1,
            borderStyle: dashed ? 'dashed' : 'solid',
            borderRadius: dashed ? 0 : 4,
            ...(width != null ? { width } : null),
          },
          animatedStyle,
        ]}
      />
      {flagged ? <View style={styles.flagDot} /> : null}
    </Pressable>
  );
}

// The canvas header's Scan Direction control — a centered modal (matching
// this screen's other modals, e.g. the Unresolved Locations one), not an
// anchored popover. Mode first, direction second — a bare 4-way D-pad
// conflates "which pattern" with "which end it starts from" into one
// ambiguous gesture, so this splits them: a Horizontal/Vertical tab picks
// the real-world pattern (no-MHE sweeping every bay one level at a time,
// vs. MHE clearing one bay fully before the fork moves), then two
// clearly-labeled rows pick which end that pattern starts from.
function ScanDirectionMenu({
  visible,
  direction,
  scope,
  onSelectScope,
  onSelect,
  onClose,
}: {
  visible: boolean;
  direction: ScanDirection;
  scope: ScanScope;
  onSelectScope: (s: ScanScope) => void;
  onSelect: (d: ScanDirection) => void;
  onClose: () => void;
}) {
  const { tokens } = useTheme();
  const [mode, setMode] = useState<'horizontal' | 'vertical'>(direction === 'up' || direction === 'down' ? 'vertical' : 'horizontal');
  // A Modal's `visible` prop hides it without unmounting it, unlike the old
  // conditional-render popover — so this component no longer gets a fresh
  // mount (and fresh useState initializer) every time it opens. Re-derive
  // the tab explicitly on each open instead, so it still always reflects
  // whatever direction is actually active right now rather than whichever
  // tab was left selected the last time this same instance was open.
  useEffect(() => {
    if (visible) setMode(direction === 'up' || direction === 'down' ? 'vertical' : 'horizontal');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);
  const rows: { value: ScanDirection; icon: keyof typeof Ionicons.glyphMap; label: string; desc: string }[] =
    mode === 'horizontal'
      ? [
          {
            value: 'right',
            icon: 'arrow-forward',
            label: 'Left → Right',
            desc: scope === 'bay' ? 'Each bay: L1 slots left→right, then up a level, same every bay' : 'Bay 1 → last bay at L1, then reverse each level up',
          },
          {
            value: 'left',
            icon: 'arrow-back',
            label: 'Right → Left',
            desc: scope === 'bay' ? 'Each bay: L1 slots right→left, then up a level, same every bay' : 'Last bay → Bay 1 at L1, then reverse each level up',
          },
        ]
      : [
          {
            value: 'up',
            icon: 'arrow-up',
            label: 'Bottom → Top',
            desc: scope === 'bay' ? 'Each bay cleared L1 → top level, same every bay' : 'Bay 1 goes L1 → top level, then reverse each next bay',
          },
          {
            value: 'down',
            icon: 'arrow-down',
            label: 'Top → Bottom',
            desc: scope === 'bay' ? 'Each bay cleared top level → L1, same every bay' : 'Bay 1 goes top level → L1, then reverse each next bay',
          },
        ];
  return (
    <Modal visible={visible} transparent statusBarTranslucent animationType="fade" onRequestClose={onClose}>
      <Pressable style={[styles.backdrop, { backgroundColor: 'rgba(0,0,0,0.5)' }]} onPress={onClose}>
        <Pressable
          style={[menuStyles.wrap, { backgroundColor: tokens.popover, borderColor: tokens.border, borderRadius: tokens.radius.xl }]}
          onPress={(e) => e.stopPropagation()}
        >
          <View style={menuStyles.head}>
            <View style={{ flex: 1 }}>
              <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.extrabold, fontSize: tokens.text.lg }}>Scan Direction</Text>
              <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xs, marginTop: 2 }}>How Scan Next SKU walks the rack</Text>
            </View>
            <Pressable onPress={onClose} hitSlop={8} style={[menuStyles.closeBtn, { backgroundColor: tokens.muted }]}>
              <Ionicons name="close" size={20} color={tokens.foreground} />
            </Pressable>
          </View>
          <View style={[menuStyles.headDivider, { backgroundColor: tokens.border }]} />

          <ScrollView contentContainerStyle={menuStyles.scrollBody} showsVerticalScrollIndicator={false}>
            {/* Scope — whether the picked direction below governs the whole
                rack (bays alternate, MHE-vs-no-MHE) or is applied fresh, the
                same way, inside each bay on its own. No icons here — the
                two choices read fine as plain text, and a full sentence
                underneath spells out what each one actually does. */}
            <Text style={[menuStyles.groupLabel, { color: tokens.mutedForeground }]}>Scope</Text>
            <View style={[menuStyles.tabs, { backgroundColor: tokens.muted, borderRadius: tokens.radius.lg }]}>
              <ToggleTab label="Whole Rack" active={scope === 'rack'} onPress={() => onSelectScope('rack')} />
              <ToggleTab label="Each Bay" active={scope === 'bay'} onPress={() => onSelectScope('bay')} />
            </View>
            <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xs, marginTop: 8 }}>
              {scope === 'rack'
                ? 'The direction switches from bay to bay as you move up each level.'
                : 'Every bay is scanned the same way on its own — nothing alternates.'}
            </Text>

            {/* Pattern — Horizontal (sweeps every bay a level at a time) vs.
                Vertical (clears one bay before moving to the next), stacked
                one below the other as a plain radio choice, same as
                Starting Point right below it. */}
            <Text style={[menuStyles.groupLabel, { color: tokens.mutedForeground, marginTop: 18 }]}>Pattern</Text>
            <View style={{ gap: 8 }}>
              <RadioRow icon="arrow-forward" label="Horizontal" desc="Sweeps every bay one level at a time" active={mode === 'horizontal'} onPress={() => setMode('horizontal')} />
              <RadioRow icon="arrow-up" label="Vertical" desc="Clears one bay fully before moving to the next" active={mode === 'vertical'} onPress={() => setMode('vertical')} />
            </View>

            {/* Starting Point — same stacked radio rows as Pattern. */}
            <Text style={[menuStyles.groupLabel, { color: tokens.mutedForeground, marginTop: 18 }]}>Starting Point</Text>
            <View style={{ gap: 8 }}>
              {rows.map((row) => (
                <RadioRow key={row.value} icon={row.icon} label={row.label} desc={row.desc} active={direction === row.value} onPress={() => onSelect(row.value)} />
              ))}
            </View>
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// Shared borderless toggle button for Scope / Pattern / Starting Point — a
// plain filled-background pill (no border, no radio dot), optionally with a
// leading icon, so all three controls in this popup read as one family
// instead of three different control types.
function ToggleTab({
  label,
  icon,
  active,
  onPress,
}: {
  label: string;
  icon?: keyof typeof Ionicons.glyphMap;
  active: boolean;
  onPress: () => void;
}) {
  const { tokens } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      hitSlop={6}
      style={({ pressed }) => [menuStyles.tab, { backgroundColor: active ? tokens.card : 'transparent', borderRadius: tokens.radius.sm, opacity: pressed ? 0.6 : 1 }]}
    >
      {icon ? <Ionicons name={icon} size={16} color={active ? tokens.primary : tokens.mutedForeground} /> : null}
      <Text style={{ color: active ? tokens.foreground : tokens.mutedForeground, fontWeight: active ? tokens.fontWeight.bold : tokens.fontWeight.medium, fontSize: tokens.text.xs }}>
        {label}
      </Text>
    </Pressable>
  );
}

// Plain circle-fill radio row — bordered, stacked one below the other,
// used for both Pattern and Starting Point so they read as the same kind
// of choice.
function RadioRow({
  icon,
  label,
  desc,
  active,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  desc: string;
  active: boolean;
  onPress: () => void;
}) {
  const { tokens } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      hitSlop={6}
      style={[menuStyles.radioRow, { borderColor: active ? tokens.primary : tokens.border, backgroundColor: active ? tokens.accentBlue.soft : tokens.card, borderRadius: tokens.radius.lg }]}
    >
      <View style={[menuStyles.radioRowIcon, { backgroundColor: '#fff', borderRadius: tokens.radius.xxl }]}>
        <Ionicons name={icon} size={16} color={tokens.primary} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={{ color: tokens.foreground, fontWeight: active ? tokens.fontWeight.bold : tokens.fontWeight.medium, fontSize: tokens.text.sm }}>{label}</Text>
        <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xs, marginTop: 2 }}>{desc}</Text>
      </View>
      <View style={[menuStyles.radioOuter, { borderColor: active ? tokens.primary : tokens.border }]}>
        {active ? <View style={[menuStyles.radioInner, { backgroundColor: tokens.primary }]} /> : null}
      </View>
    </Pressable>
  );
}

// A real switch (track + sliding thumb), not just a color-swapped button —
// reads unambiguously as an on/off toggle at a glance, with the amber
// on-state matching the caution banner it reveals below the toolbar.
function ManualModeToggle({ value, onToggle }: { value: boolean; onToggle: () => void }) {
  const { tokens } = useTheme();
  const thumbX = useSharedValue(value ? 16 : 2);

  useEffect(() => {
    thumbX.value = withTiming(value ? 16 : 2, { duration: 180 });
  }, [value]);

  const thumbStyle = useAnimatedStyle(() => ({ transform: [{ translateX: thumbX.value }] }));

  return (
    <Pressable onPress={onToggle} style={styles.manualModeWrap}>
      <Ionicons name={value ? 'construct' : 'construct-outline'} size={14} color={value ? tokens.rag.amber.strong : tokens.mutedForeground} />
      <Text style={{ color: value ? tokens.rag.amber.strong : tokens.foreground, fontWeight: tokens.fontWeight.semibold, fontSize: tokens.text.xs }}>Manual Mode</Text>
      <View style={[styles.switchTrack, { backgroundColor: value ? tokens.rag.amber.strong : tokens.slate300 }]}>
        <Animated.View style={[styles.switchThumb, thumbStyle]} />
      </View>
    </Pressable>
  );
}

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

const styles = StyleSheet.create({
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  toolbar: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  manualModeWrap: { flexDirection: 'row', alignItems: 'center', gap: 7, height: 36, paddingHorizontal: 6 },
  switchTrack: { width: 34, height: 20, borderRadius: 10 },
  switchThumb: { position: 'absolute', top: 2, left: 0, width: 16, height: 16, borderRadius: 8, backgroundColor: '#fff' },
  manualModeBanner: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, paddingVertical: 8, borderBottomWidth: 1 },
  body: { flex: 1, padding: 16 },
  singleRow: { flex: 1 },
  splitRow: { flex: 1, flexDirection: 'row', gap: 16 },
  diagramHeadRow: { minHeight: 60, paddingHorizontal: 14, paddingVertical: 12, borderBottomWidth: 1 },
  directionAnchor: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  directionBadge: { flexDirection: 'row', alignItems: 'center', gap: 6, height: 36, paddingHorizontal: 12 },
  directionSettingsBtn: { width: 36, height: 36, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  diagramBody: { flex: 1, padding: 14 },
  diagramCenter: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  bayColumnsRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 16 },
  bayColumnWrap: { flexDirection: 'row', alignItems: 'flex-end', gap: 16 },
  bayUpright: { width: 2, alignSelf: 'stretch', marginBottom: 24 },
  bayColumn: { alignItems: 'center' },
  diagram: { gap: 6 },
  diagramRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  diagramCells: { flexDirection: 'row', gap: 8 },
  cell: { width: 38, height: 26, borderWidth: 1, borderRadius: 4 },
  flagDot: {
    position: 'absolute',
    top: -3,
    right: -3,
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#DC2626',
    borderWidth: 1,
    borderColor: '#fff',
    zIndex: 10,
    elevation: 4,
  },
  outlineBtn: { flex: 1, height: 44, alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
  primaryBtn: { flex: 1, flexDirection: 'row', height: 44, alignItems: 'center', justifyContent: 'center', gap: 6 },
  footerRow: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 16 },
  footerBtn: { flex: 0, paddingHorizontal: 18 },
  skuPanel: { flex: 1 },
  // Full-bleed banded header, matching the canvas card's "Front View" head
  // row — negative margins escape the Card's own 16px padding just for
  // this row, rather than de-padding the whole panel.
  skuPanelHead: { minHeight: 60, justifyContent: 'center', marginHorizontal: -16, marginTop: -16, marginBottom: 14, paddingHorizontal: 14, paddingVertical: 12, borderBottomWidth: 1 },
  locDetailsBox: { flexDirection: 'row', flexWrap: 'wrap', rowGap: 12, columnGap: 16, marginBottom: 16 },
  divider: { height: StyleSheet.hairlineWidth, marginBottom: 16 },
  detailRow: { flexBasis: '45%', flexGrow: 1 },
  scanDottedBox: { flex: 1, minHeight: 160, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderStyle: 'dashed', paddingVertical: 32, marginBottom: 10 },
  scanDottedIconWrap: { width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center' },
  compareRow: { flexDirection: 'row', gap: 10 },
  compareCol: { flex: 1, borderWidth: 1, padding: 12 },
  manualSummaryBox: { borderWidth: 1, padding: 14 },
  noScannerRow: { flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, padding: 12 },
  raiseIssueBox: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, padding: 12 },
  statusPillRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 8 },
  editStatusPill: { alignSelf: 'flex-start', borderWidth: 1, paddingHorizontal: 10, paddingVertical: 5 },
  // Full-bleed banded head + its own padded body — same technique as the
  // Reconciliation Form's own header, escaping fieldCard's border so the
  // title/status band reads as a distinct strip from the filled-in content
  // beneath it, instead of everything running together edge to edge.
  fieldCard: { borderWidth: 1, overflow: 'hidden', marginBottom: 10 },
  fieldCardHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 14, paddingVertical: 10, borderBottomWidth: 1 },
  fieldCardBody: { padding: 14, gap: 10 },
  fieldValueRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  editIconBtn: { width: 26, height: 26, alignItems: 'center', justifyContent: 'center' },
  sectionLabel: { fontSize: 12, fontWeight: '700' },
  qtyInput: { height: 40, borderWidth: 1, paddingHorizontal: 12, fontSize: 14 },
  smallPrimaryBtn: { height: 40, paddingHorizontal: 14, alignItems: 'center', justifyContent: 'center' },
  condGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  condChip: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 6 },
  radioDot: { width: 14, height: 14, borderRadius: 7, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  radioDotFill: { width: 7, height: 7, borderRadius: 3.5 },
  skuPanelFooter: { flexDirection: 'row', gap: 10, marginTop: 12, paddingTop: 12, borderTopWidth: StyleSheet.hairlineWidth },
  pendingBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, height: 36, paddingHorizontal: 12, borderWidth: 1 },
  pendingCountBadge: { minWidth: 18, height: 18, paddingHorizontal: 4, alignItems: 'center', justifyContent: 'center' },
  backdrop: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  pendingModalCard: { width: '100%', maxWidth: 720, maxHeight: '85%', padding: 20 },
  pendingModalHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 },
  pendingSearchBox: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, paddingHorizontal: 12, marginBottom: 12 },
  pendingTotalBadge: { alignSelf: 'flex-start', paddingHorizontal: 10, paddingVertical: 4, marginBottom: 12 },
  pendingGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginTop: 12 },
  pendingCard: { flexGrow: 1, flexBasis: 220, borderWidth: 1, padding: 12, gap: 8 },
  pendingCardHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  pendingStatusPill: { paddingHorizontal: 8, paddingVertical: 3, borderWidth: 1 },
  pendingFieldRow: { flexDirection: 'row', gap: 16 },
  pendingField: { gap: 2 },
  pendingBaySection: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#e2e8f0', paddingVertical: 12 },
  pendingBayHead: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  pendingBayBadge: { paddingHorizontal: 10, paddingVertical: 4 },
  pendingTabRow: { flexDirection: 'row', gap: 8, marginBottom: 14 },
  pendingTabBtn: { flex: 1, alignItems: 'center', justifyContent: 'center', height: 38, borderWidth: 1, paddingHorizontal: 8 },
});

const menuStyles = StyleSheet.create({
  wrap: { width: '100%', maxWidth: 560, maxHeight: '85%', borderWidth: 1, padding: 22 },
  head: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 },
  closeBtn: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  headDivider: { height: StyleSheet.hairlineWidth, marginTop: 14 },
  scrollBody: { paddingTop: 16 },
  groupLabel: { fontSize: 11, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 },
  tabs: { flexDirection: 'row', gap: 3, padding: 4 },
  tab: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, paddingVertical: 9, paddingHorizontal: 9, minHeight: 44 },
  radioRow: { flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, padding: 12, minHeight: 56 },
  radioRowIcon: { width: 30, height: 30, alignItems: 'center', justifyContent: 'center' },
  radioOuter: { width: 18, height: 18, borderRadius: 9, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  radioInner: { width: 9, height: 9, borderRadius: 4.5 },
});
