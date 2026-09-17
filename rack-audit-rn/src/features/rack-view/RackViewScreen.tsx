import { Ionicons } from '@expo/vector-icons';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, BackHandler, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { cancelAnimation, useAnimatedStyle, useSharedValue, withRepeat, withSequence, withTiming } from 'react-native-reanimated';
import Svg, { Path } from 'react-native-svg';
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
import { allLocations } from '@/lib/auditLogic';
import { buildFindings, type Finding, type FindingType } from '@/lib/findings';
import { findLayoutIn, findRackIn } from '@/lib/locationsRepo';
import { EXPECTED_SKUS, expectedUnitIdsForQty, generateWaveformBars, INVENTORY_POOL, RACK_DIAGRAM_SLOTS_PER_LEVEL, type ExpectedSkuLine } from '@/lib/mockData';
import { ACTIVITY_PHASES, CONDITIONS, OBSERVATIONS_BY_PHASE, type ActivityPhase, type CountLine, type Evidence, type LocationNode } from '@/lib/types';
import { useTheme } from '@/theme/ThemeProvider';
import { useAudits } from '../dashboard/hooks';
import { useCountSheetMutations } from '../count-sheet/mutations';
import { buildBayDiagram, buildScanOrder, locLevelPosition, type ScanFrom, type ScanPattern, type ScanScope, type ScanVertical } from './buildBayDiagram';

// `source: 'bay-chip'` marks arriving from an Audit Details bay chip
// specifically — the one entry point where the bay lock is meant to stay
// absolute (other bays' pending SKUs only reachable via the Bay dropdown).
// Every other entry point (Resume Audit, opening the rack generally, etc.)
// leaves `source` unset and keeps pending locations directly tappable
// across bays regardless of the lock — see isLocSelectable below.
type Params = { auditId: string; layout: string; rackId: string; bay: string; loc?: string; source?: 'bay-chip'; fresh?: string };

const EMPTY_EVIDENCE: Evidence = { note: '', noteOpen: false, audio: null, images: [], videos: [] };

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
// Level, Position, and Pallet as three distinct, readable segments (Level
// = which row in the bay elevation, Position = which slot in that row,
// Pallet = the level+position combined into the same code this location
// has always been identified by) instead of one opaque combined code.
function palletIdFor(loc: { level?: number; slot?: number; code: string }, bayCode?: string): string {
  const base =
    loc.level != null && loc.slot != null
      ? `L${loc.level}-P${String(loc.slot).padStart(2, '0')}-P${String(loc.level).padStart(2, '0')}${String(loc.slot).padStart(2, '0')}`
      : loc.code;
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
  // A genuinely fresh "Start Audit" (nothing scanned yet) lands on some
  // rack/layout under the hood — the route requires one — but the Layout
  // and Rack toolbar fields show as unselected placeholders rather than
  // that default, since the inspector never actually chose it. The moment
  // they pick anything themselves (layout, rack, bay, or a canvas tap),
  // this clears and the fields show the real selection like normal.
  const [freshUnselected, setFreshUnselected] = useState(!!params.fresh);
  const [pendingModalOpen, setPendingModalOpen] = useState(false);
  // Layout-wise accordion — Unresolved Locations is warehouse-wide (every
  // layout/rack in this audit's tree), not just the currently-open rack, so
  // it groups by layout the same way Audit Details' own bay breakdown
  // groups by bay. Every layout starts collapsed, and only one is ever open
  // at a time — opening one closes whichever was already open, rather than
  // letting them stack.
  const [openPendingLayout, setOpenPendingLayout] = useState<string | null>(null);
  const [pendingFilterOpen, setPendingFilterOpen] = useState(false);
  const [pendingLayoutFilter, setPendingLayoutFilter] = useState<string[]>([]);
  const [pickerField, setPickerField] = useState<'layout' | 'rack' | 'bay' | 'pallet' | null>(null);
  // How "Scan Next SKU" walks the rack — matches how the audit is actually
  // being physically worked (see buildScanOrder). Defaults mirror the
  // reference toolbar's own defaults (From Left, Current Up, Bay wise).
  const [scanFrom, setScanFrom] = useState<ScanFrom>('left');
  const [scanPattern, setScanPattern] = useState<ScanPattern>('last');
  const [scanVertical, setScanVertical] = useState<ScanVertical>('up');
  const [scanScope, setScanScope] = useState<ScanScope>('bay');
  const [scopeMenuOpen, setScopeMenuOpen] = useState(false);
  const [selectedLoc, setSelectedLoc] = useState<string | null>(params.loc ?? null);
  // A specific `loc` param (Resume Audit's "pick up exactly where I left
  // off", Count Sheet's Scan Next) means the inspector is being sent
  // straight back to a pallet they were already working — canvas+form
  // should already be open, not just that pallet highlighted on the
  // canvas requiring an extra tap to reopen the form.
  const [skuPanelOpen, setSkuPanelOpen] = useState(!!params.loc);
  // A pallet can now carry more than one distinct SKU (multiple boxes of
  // the same SKU, or several different SKUs stacked together) — scanLines
  // holds one CountLine per distinct SKU found this session, its `qty`
  // tallied up from repeat scans of that SKU rather than typed in by hand.
  // activeLineIndex is whichever line the detail editor below (qty/damage/
  // evidence/raise-issue) is currently showing — defaults to the
  // just-scanned line, but tapping an earlier row in the Scanned SKUs list
  // switches it.
  const [scanLines, setScanLines] = useState<CountLine[]>([]);
  const [activeLineIndex, setActiveLineIndex] = useState(0);
  // Its own accordion, separate from the SKU-line accordion above it — a
  // unit's evidence section auto-opens the moment Damage is switched on
  // (toggleUnitDamage), but can then be collapsed/reopened independently
  // via its own chevron without having to turn Damage back off.
  const [openUnitIds, setOpenUnitIds] = useState<Set<string>>(new Set());
  // Every box's unique label already scanned onto the CURRENT pallet this
  // session — a real pallet QR is "<sku>::<label>" (same convention as
  // Zone Audit's scanner), so two different boxes of the same SKU carry
  // different labels and both count, while a repeat of the same label (the
  // same physical box scanned twice) is rejected as a duplicate.
  const [scannedLabels, setScannedLabels] = useState<Set<string>>(new Set());
  const [duplicateScanLabel, setDuplicateScanLabel] = useState<string | null>(null);
  // "Save & Scan Next" checks for expected units never scanned before it
  // lets the inspector leave this pallet — this just gates the confirm
  // modal; the actual missing-group data is recomputed fresh each render
  // (missingGroups below) rather than snapshotted here.
  const [missingModalOpen, setMissingModalOpen] = useState(false);
  // Shown once each time Manual Mode is switched ON (not every render it
  // stays on) — the persistent banner already says this passively while
  // it's on, this is the "did you mean to do this" gate at the moment of
  // turning it on.
  const [manualModeInfoOpen, setManualModeInfoOpen] = useState(false);
  // Canvas header's (i) — Reconciliation Findings scoped to whichever bay
  // is currently in focus, so an inspector can see what's already been
  // reported here without leaving Rack View.
  const [bayFindingsModalOpen, setBayFindingsModalOpen] = useState(false);
  const [bayFindingsFilter, setBayFindingsFilter] = useState<FindingType | 'All'>('All');
  // "Is the pallet condition at this location good?" is mandatory — Save &
  // Scan Next (and Manual Mode's own Raise Issue) refuse to proceed until
  // it's actually answered, surfacing this instead of just staying quiet
  // about why the button didn't do anything.
  const [conditionRequiredError, setConditionRequiredError] = useState(false);
  const [scanRequiredError, setScanRequiredError] = useState(false);
  const [scanPallet, setScanPallet] = useState<string | null>(null);
  const [expectedSkus, setExpectedSkus] = useState<ExpectedSkuLine[]>([]);
  const [skuScanCount, setSkuScanCount] = useState(0);
  const [scannerOpen, setScannerOpen] = useState<'sku' | null>(null);
  // Location Details moved out of the form's always-visible body into a
  // tap-to-open popup from the header's own pin icon — the form itself
  // stays focused on scanning/reconciling, not repeating identity details
  // the inspector already knows from picking this pallet on the canvas.
  const [locationDetailsOpen, setLocationDetailsOpen] = useState(false);
  // Quantity and damage are unknown at scan time — a scan only proves SKU
  // identity — so each starts unchecked ("-" shown instead of a number)
  // until the inspector deliberately enters what they actually found.
  // *Editing is the input row being open right now; *Checked is "a real
  // value has been entered this session" (or this pallet already had a
  // saved record when selected), which is what unlocks the Matched/
  // Mismatch badge and the Raise Issue button for that field.
  const [qtyChecked, setQtyChecked] = useState(false);
  const [qtyEditing, setQtyEditing] = useState(false);
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
  const [attachmentTarget, setAttachmentTarget] = useState<'qty' | 'damage' | 'condition' | `unit:${string}` | null>(null);
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
      if (!prev[activeLineIndex]) return prev;
      const next = prev.slice();
      next[activeLineIndex] = { ...next[activeLineIndex], ...(typeof patch === 'function' ? patch(next[activeLineIndex]) : patch) };
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
  // Evidence for the "Not Good" pallet condition answer — same shape/UI as
  // qty/damage evidence (EvidenceBlock), just pallet-wide instead of tied to
  // one scanned SKU, so it's collected once up top rather than per line.
  const [conditionEvidence, setConditionEvidence] = useState<Evidence>(EMPTY_EVIDENCE);

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

  // Save & Scan Next (and Proceed on Missing Inventory Unit IDs) can advance
  // the blinking selection to a pallet the inspector previously panned/
  // zoomed away from — reset the canvas back to its default framing on
  // every selection change so the newly-selected, blinking cell is actually
  // back in view instead of off-screen.
  useEffect(() => {
    scale.value = withTiming(1, { duration: 200 });
    translateX.value = withTiming(0, { duration: 200 });
    translateY.value = withTiming(0, { duration: 200 });
    savedScale.value = 1;
    savedTranslateX.value = 0;
    savedTranslateY.value = 0;
  }, [selectedLoc]);

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
  const paramsKey = `${auditId}|${params.layout}|${params.rackId}|${params.bay}|${params.loc ?? ''}|${params.source ?? ''}|${params.fresh ?? ''}`;
  const paramsKeyRef = useRef<string>(paramsKey);
  useEffect(() => {
    if (paramsKeyRef.current === paramsKey) return;
    paramsKeyRef.current = paramsKey;
    setLayoutName(params.layout);
    setRackCode(params.rackId);
    setBayFilter(params.bay || 'all');
    setSelectedLoc(params.loc ?? null);
    setSkuPanelOpen(!!params.loc);
    setFreshUnselected(!!params.fresh);
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

  // Whichever bay is actually "in focus" right now — the bay filter if one
  // is picked, else whatever bay the currently selected pallet is in —
  // scopes the (i) button's Findings modal below to just that bay, same
  // Finding-building logic Reconciliation Findings itself uses.
  const focusedBayCode = bayFilter !== 'all' ? bayFilter : selectedLocObj ? bayCodeForLoc(selectedLocObj.code) : undefined;
  const bayFindings: Finding[] = audit
    ? buildFindings([audit], { [auditId]: tree }, [], undefined, undefined).filter(
        (f) => f.layout === layoutName && f.rack === rackCode && (!focusedBayCode || f.bay === focusedBayCode),
      )
    : [];
  const bayFindingsFiltered = bayFindingsFilter === 'All' ? bayFindings : bayFindings.filter((f) => f.findingType === bayFindingsFilter);

  // Selecting a pallet — from the canvas, the Pallet dropdown, or an
  // auto-advance — always syncs the Bay field to that pallet's actual bay
  // too, so the toolbar reflects exactly where the current selection is
  // instead of whatever bay filter happened to be set beforehand.
  const selectLocation = (code: string) => {
    setSelectedLoc(code);
    setBayFilter(bayCodeForLoc(code));
    setFreshUnselected(false);
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
  const activeLine = scanLines[activeLineIndex] ?? null;
  const scannedLine = formIsManual ? (manualScanned ? manualLine : null) : activeLine;

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
  // Under scanScope 'rack' (Bay's Level) the bay-filter gate is skipped
  // entirely: selectLocation re-syncs bayFilter to whichever bay was just
  // selected, so a rack-wide snake walk would otherwise lock every OTHER
  // bay's next step back out the moment it enters a new bay — falling
  // through to the isLocPending fallback below only rescued locations that
  // happen to carry an EXPECTED_SKUS entry, not every location has one.
  // 'bay' scope keeps the gate (confining selection to the filtered bay is
  // the whole point there); Manual Mode already bypasses this line.
  const isLocSelectable = (locCode: string) =>
    manualMode ||
    ((scanScope === 'rack' || inBayFilter(locCode)) && (!audit.target_sku || matchesTargetSku(locCode))) ||
    (params.source !== 'bay-chip' && isLocPending(locCode));

  // Picking a bay from the toolbar dropdown also jumps the canvas selection
  // straight to whatever's still unresolved in it — the first pending
  // (unscanned/mismatched) location in bay order — rather than leaving the
  // previous bay's pallet highlighted, or nothing at all. Falls back to
  // that bay's first location (its bottom-most, per fillBayLevels' build
  // order) if every one of its pallets is already resolved.
  const pickBayFilter = (bay: string) => {
    setBayFilter(bay);
    setPickerField(null);
    setFreshUnselected(false);
    if (bay === 'all') return;
    const bayLocs = rackLocations.filter((loc) => bayCodeForLoc(loc.code) === bay);
    const next = bayLocs.find((loc) => isLocPending(loc.code)) ?? bayLocs[0];
    if (next) setSelectedLoc(next.code);
  };
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
  const scannableLocations = buildScanOrder(
    { from: scanFrom, pattern: scanPattern, vertical: scanVertical, scope: scanScope },
    bayDiagrams,
    selectedLoc ? bayCodeForLoc(selectedLoc) : undefined,
  ).filter((l) => isLocSelectable(l.code) || l.code === selectedLoc);

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

  // Unresolved Locations' own modal is warehouse-wide — every layout/rack
  // in this audit's tree, not just the rack currently open on the canvas —
  // so it re-derives pending/empty straight from the tree instead of the
  // rack-scoped lists above. Empty is read back the same durable way
  // Reconciliation Findings does (a saved source:'empty' line), since
  // locationStatus is local component state that only ever covers the
  // rack that's actually been visited this session.
  const warehouseLocs = allLocations(tree);
  const warehousePending = warehouseLocs
    .filter(({ loc }) => {
      if (audit.target_sku && !matchesTargetSku(loc.code)) return false;
      const expected = EXPECTED_SKUS[loc.code]?.[0];
      if (!expected) return false;
      const saved = loc.pallets.find((p) => p.saved);
      const emptyLine = saved?.lines.find((l) => l.source === 'empty');
      if (emptyLine) return false;
      const line = saved?.lines[0];
      if (!line) return true;
      if (line.sku !== expected.sku) return false;
      return line.qty !== expected.qty || line.condition !== 'Good';
    })
    .map(({ layout, rack, bay, loc }) => ({ layout, rack, bay, loc }));
  const pendingLayoutNames = [...new Set(tree.layouts.map((l) => l.name))];
  const togglePendingLayoutFilter = (name: string) =>
    setPendingLayoutFilter((prev) => (prev.includes(name) ? prev.filter((v) => v !== name) : [...prev, name]));

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
    setFreshUnselected(false);
  };

  const handlePickRack = (code: string) => {
    setRackCode(code);
    setPickerField(null);
    setFreshUnselected(false);
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
  // Aggregates every scanned line at this location into one canvas-cell
  // status — worst case wins: any line scanned that isn't among the
  // expected SKUs makes the whole pallet 'mismatch'; otherwise any line
  // whose unit count or condition is off makes it 'issue'; only when every
  // line matches cleanly is it 'matched'.
  const applyLocationStatus = (locCode: string, lines: CountLine[], expected: ExpectedSkuLine[]) => {
    setLocationStatus((prev) => {
      if (!lines.length) {
        if (!(locCode in prev)) return prev;
        const next = { ...prev };
        delete next[locCode];
        return next;
      }
      let status: 'matched' | 'issue' | 'mismatch' = 'matched';
      for (const line of lines) {
        const exp = expected.find((e) => e.sku === line.sku);
        if (!exp) {
          status = 'mismatch';
          break;
        }
        if (line.qty !== exp.qty || line.condition !== 'Good') status = 'issue';
      }
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
    if (checked) setScanRequiredError(false);
    if (!selectedLocObj) return;
    if (checked) {
      setScanLines([]);
      setScannedLabels(new Set());
      setActiveLineIndex(0);
      setQtyChecked(false);
      setDamageChecked(false);
      setQtyEditing(false);
      setDamageEditing(false);
      setLocationStatus((prev) => ({ ...prev, [selectedLocObj.code]: 'missing' }));
    } else {
      applyLocationStatus(selectedLocObj.code, scanLines, expectedSkus);
    }
  };

  // Answerable the moment a location is selected, independent of whether
  // it's been scanned yet — writes straight into the live line (manualLine
  // always exists; scanLines[0] only once an actual scan is on record), so
  // the two stay in sync no matter which happens first.
  const handleSelectPalletCondition = (good: boolean) => {
    setPalletConditionGood(good);
    setConditionRequiredError(false);
    if (formIsManual) {
      setManualLine((prev) => ({ ...prev, palletConditionGood: good }));
      return;
    }
    // Pallet condition is about the physical pallet at this location, not
    // any one SKU on it — carries onto every line scanned here, present or
    // future, not just whichever one is currently active.
    setScanLines((prev) => prev.map((l) => ({ ...l, palletConditionGood: good })));
  };

  // Same "carries onto every line, present or future" reasoning as
  // handleSelectPalletCondition above — the evidence is for the pallet
  // condition answer, not any one scanned SKU.
  const updateConditionEvidence = (patch: Partial<Evidence>) => {
    setConditionEvidence((prev) => {
      const next = { ...prev, ...patch };
      if (formIsManual) {
        setManualLine((p) => ({ ...p, conditionEvidence: next }));
      } else {
        setScanLines((prev2) => prev2.map((l) => ({ ...l, conditionEvidence: next })));
      }
      return next;
    });
  };

  // Per-Inventory-Unit-ID damage — Rack View's own replacement for the
  // Activity Phase/Observation flow (still used by Quick Scan's 3 modes,
  // not yet ported here). Flagging any one unit marks the whole scanned
  // line 'Damaged' so everything downstream that reads line.condition
  // (Reported Audits, Maintenance tasks, chip coloring) keeps working
  // unchanged — this only changes how the damage finding gets entered, not
  // what it means once entered.
  const toggleUnitDamage = (unitId: string) => {
    if (!scannedLine) return;
    const current = scannedLine.unitDamage?.[unitId];
    const nextFlagged = !current?.flagged;
    const unitDamage = { ...scannedLine.unitDamage, [unitId]: { flagged: nextFlagged, evidence: current?.evidence ?? EMPTY_EVIDENCE } };
    const anyFlagged = Object.values(unitDamage).some((u) => u.flagged);
    const patch: Partial<CountLine> = { unitDamage, condition: anyFlagged ? 'Damaged' : 'Good', damageConfirmed: true };
    updateCurrentLine(patch);
    setDamageChecked(true);
    setOpenUnitIds((prev) => {
      const next = new Set(prev);
      if (nextFlagged) next.add(unitId);
      else next.delete(unitId);
      return next;
    });
    // Same reasoning as the old handleConfirmDamage — condition changed, so
    // the canvas cell color (green/amber/red) needs recomputing too, not
    // just the panel's own state.
    if (!formIsManual && selectedLocObj) {
      const nextLines = scanLines.slice();
      if (nextLines[activeLineIndex]) nextLines[activeLineIndex] = { ...nextLines[activeLineIndex], ...patch };
      applyLocationStatus(selectedLocObj.code, nextLines, expectedSkus);
    }
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
    updateCurrentLine((line) => {
      const current = line.unitDamage?.[unitId] ?? { flagged: true, evidence: EMPTY_EVIDENCE };
      return { unitDamage: { ...line.unitDamage, [unitId]: { ...current, evidence: { ...(current.evidence ?? EMPTY_EVIDENCE), ...patch } } } };
    });
  };

  // A unit reads Mismatched either because its SKU isn't the one expected
  // here (lineMatched), or — even for the right SKU — because this exact
  // physical Inventory Unit ID was already saved at a DIFFERENT location
  // earlier in the audit: the same real-world unit can't legitimately be in
  // two places, so finding its label again elsewhere is itself a mismatch,
  // not just a re-scan of the same box.
  const isDuplicateUnit = (unitId: string): boolean => {
    if (!tree || !selectedLocObj) return false;
    for (const layout of tree.layouts) {
      for (const rack of layout.racks) {
        for (const bay of rack.bays) {
          for (const loc of bay.locations) {
            if (loc.code === selectedLocObj.code) continue;
            for (const pallet of loc.pallets) {
              if (!pallet.saved) continue;
              for (const line of pallet.lines) {
                if (line.unitIds?.includes(unitId)) return true;
              }
            }
          }
        }
      }
    }
    return false;
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
      setOpenUnitIds(new Set());
      setQtyEditing(false);
      setDamageEditing(false);
      setPalletConditionGood(line.palletConditionGood ?? null);
      setConditionEvidence(line.conditionEvidence ?? EMPTY_EVIDENCE);
      setConditionRequiredError(false);
      // A previously-saved issue (this session or an earlier one) should
      // still read as raised, not reset back to a fresh unflagged state.
      if (existing?.lines[0]?.issueRaised) {
        setIssuesRaised((prev) => new Set(prev).add(existing.lines[0].sku));
        setFlaggedLocs((prev) => new Set(prev).add(loc.code));
      }
      return;
    }
    const existing = loc.pallets.find((p) => p.saved) ?? null;
    // A synthetic empty-pallet record (see handleScanNext's noScannerFound
    // branch) isn't a real scan to restore into scanLines — reopening it
    // should read right back as "marked empty", pallet condition/evidence
    // and all, not as a pallet carrying one blank-SKU line.
    const wasMarkedEmpty = existing?.lines[0]?.source === 'empty';
    // A pallet can carry more than one distinct SKU now — every previously
    // saved line applies, not just the first. A line that was already
    // saved this audit already has real, confirmed qty/condition values —
    // unlike a fresh scan, it doesn't need the inspector to re-enter them
    // before its Matched/Mismatched status shows.
    const base = existing && !wasMarkedEmpty ? existing.lines.map((l) => ({ ...l, qtyConfirmed: true, damageConfirmed: true })) : [];
    const expected = EXPECTED_SKUS[loc.code] ?? [];
    setScanPallet(existing ? existing.pallet : null);
    setScanLines(base);
    setScannedLabels(new Set());
    setActiveLineIndex(Math.max(0, base.length - 1));
    base.forEach((line) => {
      if (line.issueRaised) {
        setIssuesRaised((prev) => new Set(prev).add(line.sku));
        setFlaggedLocs((prev) => new Set(prev).add(loc.code));
      }
    });
    // A pallet already saved this audit shows its real qty/damage right
    // away; a fresh one starts unchecked ("-") until the inspector enters
    // what they actually found.
    setQtyChecked(!!base.length);
    setDamageChecked(!!base.length);
    setOpenUnitIds(new Set());
    setQtyEditing(false);
    setDamageEditing(false);
    setExpectedSkus(expected);
    setNoScannerFound(wasMarkedEmpty);
    const conditionLine = wasMarkedEmpty ? existing?.lines[0] : base[0];
    setPalletConditionGood(conditionLine?.palletConditionGood ?? null);
    setConditionEvidence(conditionLine?.conditionEvidence ?? EMPTY_EVIDENCE);
    setConditionRequiredError(false);
    applyLocationStatus(loc.code, base, expected);
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
    // Only surfaced turning it ON — an inspector flipping it back off
    // doesn't need re-warning about scope, they're leaving that scope.
    if (!manualMode) setManualModeInfoOpen(true);
  };

  // What the admin pick list (EXPECTED_SKUS, via expectedUnitIdsForQty)
  // says should be here that hasn't actually been scanned onto this pallet
  // yet — per SKU, only the specific Inventory Unit IDs still missing, not
  // just "not fully scanned". A SKU with no scanned line at all here is
  // entirely missing; a partially-scanned one only lists what's left.
  const missingGroups =
    !formIsManual && !noScannerFound
      ? expectedSkus
          .map((exp) => {
            const expectedIds = expectedUnitIdsForQty(exp.qty);
            const scannedIds = new Set(scanLines.find((l) => l.sku === exp.sku)?.unitIds ?? []);
            const missingIds = expectedIds.filter((id) => !scannedIds.has(id));
            return { sku: exp.sku, name: exp.name, lot: exp.lot, missingIds };
          })
          .filter((g) => g.missingIds.length > 0)
      : [];
  const missingTotal = missingGroups.reduce((sum, g) => sum + g.missingIds.length, 0);

  // "Proceed" on the Missing Inventory Unit IDs prompt — marks every still-
  // missing unit onto this pallet's record (a real line if the SKU was
  // scanned at all, a synthetic source:'missing' line if it never was) so
  // the gap is an actual saved finding, not silently dropped, then
  // continues exactly like a normal Save & Scan Next.
  const handleConfirmMissingAndProceed = () => {
    setScanLines((prev) => {
      const next = prev.slice();
      missingGroups.forEach((g) => {
        const idx = next.findIndex((l) => l.sku === g.sku);
        if (idx !== -1) {
          next[idx] = { ...next[idx], missingUnitIds: g.missingIds };
        } else {
          next.push({
            sku: g.sku,
            name: g.name,
            lot: g.lot,
            qty: 0,
            condition: 'Good',
            source: 'missing',
            missingUnitIds: g.missingIds,
          });
        }
      });
      return next;
    });
    setMissingModalOpen(false);
    // scanLines won't reflect the update above until the next render, but
    // handleScanNext reads it via closure on THIS render — same pattern
    // saveRecord already relies on elsewhere, so defer one tick.
    setTimeout(() => handleScanNext(), 0);
  };

  const handleSaveAndScanNextPress = () => {
    if (palletConditionGood === null) {
      setConditionRequiredError(true);
      return;
    }
    if (!scanLines.length && !noScannerFound) {
      setScanRequiredError(true);
      return;
    }
    setScanRequiredError(false);
    if (missingGroups.length) {
      setMissingModalOpen(true);
      return;
    }
    handleScanNext();
  };

  // Persists the pallet just finished, then jumps straight to the next
  // scannableLocations only ever covers the CURRENT rack's own scan order
  // (buildScanOrder builds it from this rack's bay diagrams alone) — once
  // that's exhausted, look ahead to the rest of this layout's racks, in
  // order, for the first still-pending location instead of just stranding
  // the inspector on a bare canvas with the form closed.
  const findNextPendingAcrossRacks = (): { rack: string; bay: string; loc: string } | null => {
    const idx = layoutObj.racks.findIndex((r) => r.code === rackCode);
    for (let i = idx + 1; i < layoutObj.racks.length; i++) {
      const r = layoutObj.racks[i];
      for (const bay of r.bays) {
        const pending = bay.locations.find((l) => l.status !== 'Completed');
        if (pending) return { rack: r.code, bay: bay.code, loc: pending.code };
      }
    }
    return null;
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
      // Still saves a record (one synthetic source:'empty' line) so the
      // pallet condition question/evidence answered up top for this
      // location survives past the session — Reconciliation Findings'
      // "Show Empty location" cards read it back via emptyLocations().
      const ref = { auditId, layout: layoutName, rack: rackCode, bay: bayCodeForLoc(selectedLocObj.code), loc: selectedLocObj.code };
      await saveRecord(tree, ref, [
        { sku: '', name: '', lot: '—', qty: 0, condition: 'Good', source: 'empty', palletConditionGood: palletConditionGood ?? undefined, conditionEvidence },
      ]);
      await completeLocation(tree, ref);
    }
    const locs = scannableLocations;
    const idx = selectedLocObj ? locs.findIndex((l) => l.code === selectedLocObj.code) : -1;
    const next = idx !== -1 ? locs[idx + 1] : undefined;
    if (!next) {
      const acrossRacks = findNextPendingAcrossRacks();
      if (acrossRacks) {
        router.push({
          pathname: '/audit/[auditId]/rack/[rackId]',
          params: { auditId, rackId: acrossRacks.rack, layout: layoutName, bay: acrossRacks.bay, loc: acrossRacks.loc },
        } as never);
        return;
      }
      // Truly nothing left pending anywhere in this layout — only then does
      // the panel actually close back to the bare canvas.
      setSkuPanelOpen(false);
      return;
    }
    selectLocation(next.code);
  };

  // Every scan adds a unit, not a fresh single line — one box, one scan.
  // Two cases: another box of a SKU already on this pallet just bumps that
  // line's unit count; a SKU that hasn't shown up yet on this pallet starts
  // a new line. A real pallet QR is "<sku>::<unique label>" (same
  // convention as Zone Audit's scanner) — the label identifies this one
  // physical box, so two different boxes of the same SKU carry different
  // labels and both count as separate units, while a repeat of a label
  // already scanned onto this pallet (the same box scanned twice) is
  // caught and refused before it ever reaches the list, same as Zone
  // Audit's own "Already Scanned" prompt. A code with no "::" (an older
  // single-sku code) falls back to the raw scanned text as its own label.
  // Unlike the old single-scan model, the unit count and condition are
  // both immediately known the moment a line exists (they come from the
  // scan itself), so qty/damage start "checked" right away instead of
  // waiting on a separate manual entry.
  const applyMultiSkuScan = (raw: string) => {
    const trimmed = raw.trim();
    const [skuCode, labelPart] = trimmed.includes('::') ? trimmed.split('::') : [trimmed, trimmed];
    if (scannedLabels.has(labelPart)) {
      setDuplicateScanLabel(labelPart);
      return;
    }
    const pick = INVENTORY_POOL.find((p) => p.sku === skuCode) ?? { sku: skuCode, name: 'Unlisted SKU', lot: '—' };
    setScannedLabels((prev) => new Set(prev).add(labelPart));
    setScanRequiredError(false);
    setScanLines((prev) => {
      const idx = prev.findIndex((l) => l.sku === pick.sku);
      let next: CountLine[];
      let landedIndex: number;
      if (idx !== -1) {
        next = prev.slice();
        // The tally just changed, so whatever was previously entered as
        // "found units" is stale — back to unconfirmed until the inspector
        // re-enters it.
        next[idx] = { ...next[idx], qty: next[idx].qty + 1, qtyConfirmed: false, unitIds: [...(next[idx].unitIds ?? []), labelPart] };
        landedIndex = idx;
      } else {
        const line: CountLine = {
          sku: pick.sku,
          name: pick.name,
          lot: pick.lot,
          qty: 1,
          condition: 'Good',
          source: 'scan',
          // Carries forward whatever was already answered before this scan —
          // the pallet condition question doesn't depend on the SKU scan.
          palletConditionGood: palletConditionGood ?? undefined,
          conditionEvidence,
          unitIds: [labelPart],
        };
        next = [...prev, line];
        landedIndex = next.length - 1;
      }
      setActiveLineIndex(landedIndex);
      // A scan only proves SKU identity — the inspector still has to enter
      // the units they actually found and confirm the pallet's condition
      // before either one's Matched/Mismatched status shows.
      setQtyChecked(!!next[landedIndex].qtyConfirmed);
      setDamageChecked(!!next[landedIndex].damageConfirmed);
      setOpenUnitIds(new Set());
      if (selectedLocObj) applyLocationStatus(selectedLocObj.code, next, expectedSkus);
      return next;
    });
    setNoScannerFound(false);
    setQtyEditing(false);
    setDamageEditing(false);
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
    if (formIsManual) {
      const code = data.trim();
      const pick = INVENTORY_POOL.find((p) => p.sku === code) ?? { sku: code, name: 'Unlisted SKU', lot: '—' };
      applyManualSkuScan(pick);
      return;
    }
    applyMultiSkuScan(data);
  };

  const handleSkuSimulated = () => {
    if (formIsManual) {
      applyManualSkuScan(INVENTORY_POOL[skuScanCount % INVENTORY_POOL.length]);
      setSkuScanCount((c) => c + 1);
      return;
    }
    // Mostly scan the expected SKU (the common case), occasionally
    // simulate a genuinely different/unexpected item to demo that path too
    // — each tap gets its own numeric Inventory Unit ID (1001, 1002, ...,
    // matching the admin "Pallet" tool's own unit ID convention) so
    // repeated taps add fresh units. Every 5th tap deliberately re-sends the
    // immediately previous tap's own ID instead of a fresh one, so the
    // Already-Scanned duplicate flow (there's no real camera in Expo Go to
    // trigger it by re-scanning a physical sticker) is reachable from this
    // simulate button too.
    const expected = expectedSkus[0];
    const useExpected = expected && skuScanCount % 3 !== 0;
    const pick = useExpected ? expected : INVENTORY_POOL[skuScanCount % INVENTORY_POOL.length];
    const isDuplicateDemo = skuScanCount > 0 && skuScanCount % 5 === 4;
    const unitId = isDuplicateDemo ? 1001 + skuScanCount - 1 : 1001 + skuScanCount;
    applyMultiSkuScan(`${pick.sku}::${unitId}`);
    setSkuScanCount((c) => c + 1);
  };

  const handleRaiseIssue = (sku: string) => {
    setIssuesRaised((prev) => new Set(prev).add(sku));
    if (selectedLocObj) setFlaggedLocs((prev) => new Set(prev).add(selectedLocObj.code));
  };

  // Quantity and damage are independent findings on a pallet — each gets
  // its own evidence, kept on whichever line is live right now (manualLine
  // in Manual Mode, scanLines[activeLineIndex] otherwise — a pallet can
  // hold several scanned lines now, but only one is ever open for detail
  // editing at a time in either mode).
  const ensureFieldEvidence = (field: 'qtyEvidence' | 'damageEvidence'): Evidence =>
    scannedLine?.[field] ?? { note: '', noteOpen: false, audio: null, images: [], videos: [] };

  const updateFieldEvidence = (field: 'qtyEvidence' | 'damageEvidence', patch: Partial<Evidence>) => {
    if (!scannedLine) return;
    updateCurrentLine({ [field]: { ...ensureFieldEvidence(field), ...patch } });
  };

  // Manual Mode's whole point is reporting a problem, so saving it always
  // raises the issue (red dot) too. Stays on this pallet afterward — the
  // button itself flips to a confirmed "Issue Raised" state (below) so the
  // tap has visible proof it worked; moving on is a deliberate separate
  // "Next Pallet" action instead of an implicit side effect of saving.
  const handleSaveManualIssue = async () => {
    if (!selectedLocObj) return;
    if (palletConditionGood === null) {
      setConditionRequiredError(true);
      return;
    }
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
          <ToolbarField label={freshUnselected ? 'Select Layout' : layoutObj.name} open={pickerField === 'layout'} onPress={() => setPickerField(pickerField === 'layout' ? null : 'layout')} />
          {pickerField === 'layout' ? (
            <>
              <Pressable style={StyleSheet.absoluteFill} onPress={() => setPickerField(null)} />
              <InlineDropdown options={layoutOptions} selectedValue={layoutName} onSelect={handlePickLayout} />
            </>
          ) : null}
        </View>
        <View>
          <ToolbarField label={freshUnselected ? 'Select Rack' : `Rack ${rackObj.code}`} open={pickerField === 'rack'} onPress={() => setPickerField(pickerField === 'rack' ? null : 'rack')} />
          {pickerField === 'rack' ? (
            <>
              <Pressable style={StyleSheet.absoluteFill} onPress={() => setPickerField(null)} />
              <InlineDropdown options={rackOptions} selectedValue={rackCode} onSelect={handlePickRack} />
            </>
          ) : null}
        </View>
        <View>
          <ToolbarField
            label={freshUnselected ? 'Select Bay' : bayFilter === 'all' ? 'All Bays' : `Bay ${bayFilter}`}
            open={pickerField === 'bay'}
            onPress={() => setPickerField(pickerField === 'bay' ? null : 'bay')}
          />
          {pickerField === 'bay' ? (
            <>
              <Pressable style={StyleSheet.absoluteFill} onPress={() => setPickerField(null)} />
              <InlineDropdown options={bayOptions} selectedValue={bayFilter} onSelect={pickBayFilter} />
            </>
          ) : null}
        </View>
        <View>
          <ToolbarField
            label={selectedLocObj ? palletIdFor(selectedLocObj, bayCodeForLoc(selectedLocObj.code)) : 'Select Pallet'}
            open={pickerField === 'pallet'}
            onPress={() => setPickerField(pickerField === 'pallet' ? null : 'pallet')}
            width="auto"
          />
          {pickerField === 'pallet' ? (
            <>
              <Pressable style={StyleSheet.absoluteFill} onPress={() => setPickerField(null)} />
              <InlineDropdown options={palletOptions} selectedValue={selectedLoc ?? ''} onSelect={handlePickPallet} width={220} />
            </>
          ) : null}
        </View>
        <ManualModeToggle value={manualMode} onToggle={handleToggleManualMode} />
        <Pressable
          onPress={() => setPendingModalOpen(true)}
          style={[styles.pendingBtn, { backgroundColor: tokens.card, borderColor: tokens.border, borderRadius: tokens.radius.lg, marginLeft: 'auto' }]}
        >
          <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.semibold, fontSize: tokens.text.xs }}>Unresolved Locations</Text>
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
            <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm }}>Front View</Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              {/* Purely informational recap of the active pattern. */}
              <View style={[styles.directionBadge, { backgroundColor: tokens.accentBlue.soft, borderRadius: tokens.radius.xl }]}>
                <Text style={{ color: tokens.accentBlue.strong, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.xs }}>
                  {scanScope === 'bay' ? 'Bay wise' : "Bay's Level"} · {scanFrom === 'left' ? 'Right' : 'Left'}-{scanPattern === 'last' ? 'Current' : 'Initial'}-
                  {scanVertical === 'up' ? 'Up' : 'Down'}
                </Text>
              </View>
              {/* Scope dropdown — the only actual control up here; the
                  From/Pattern controls live in the toolbar at the bottom
                  of the canvas instead of a settings icon/modal. */}
              <View>
                <Pressable
                  onPress={() => setScopeMenuOpen((v) => !v)}
                  style={[dirToolbarStyles.scopeBtn, { borderColor: scopeMenuOpen ? tokens.primary : tokens.border, backgroundColor: tokens.card, borderRadius: tokens.radius.lg }]}
                >
                  <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.semibold, fontSize: tokens.text.sm }}>{scanScope === 'bay' ? 'Bay wise' : "Bay's Level"}</Text>
                  <Ionicons name={scopeMenuOpen ? 'chevron-up' : 'chevron-down'} size={14} color={tokens.mutedForeground} />
                </Pressable>
                {scopeMenuOpen ? (
                  <InlineDropdown
                    options={[
                      { value: 'bay', label: 'Bay wise' },
                      { value: 'rack', label: "Bay's Level" },
                    ]}
                    selectedValue={scanScope}
                    onSelect={(v) => {
                      setScanScope(v as ScanScope);
                      setScopeMenuOpen(false);
                    }}
                  />
                ) : null}
              </View>
              {/* Reported Reconciliation Findings for whichever bay is
                  currently in focus (the bay filter if one's picked, else
                  the selected location's own bay) — same Finding-building
                  logic Reconciliation Findings itself uses. */}
              <Pressable
                onPress={() => setBayFindingsModalOpen(true)}
                style={[styles.infoIconBtn, { backgroundColor: tokens.card, borderColor: tokens.border, borderRadius: tokens.radius.lg }]}
              >
                <Ionicons name="information-circle-outline" size={18} color={tokens.foreground} />
              </Pressable>
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
            <ScanDirectionToolbar
              from={scanFrom}
              pattern={scanPattern}
              vertical={scanVertical}
              onSetFrom={setScanFrom}
              onSetPattern={(p, v) => {
                setScanPattern(p);
                setScanVertical(v);
              }}
            />
          </View>
        </Card>

        {skuPanelOpen ? (
          <Card style={styles.skuPanel}>
            {/* Header carries the form name plus, in normal mode, a scan
                icon — the entry point into scanning multiple SKUs onto this
                pallet (each scan adds a unit; the dotted target further
                down offers the same action once the list is empty).
                Manual Mode keeps its old single-scan flow, so it gets no
                header icon here. */}
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
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Pressable
                  onPress={() => setLocationDetailsOpen(true)}
                  hitSlop={8}
                  style={({ pressed }) => [
                    styles.headerScanBtn,
                    {
                      backgroundColor: pressed ? tokens.primary : tokens.card,
                      borderColor: pressed ? tokens.primary : tokens.border,
                      borderRadius: tokens.radius.lg,
                    },
                  ]}
                >
                  {({ pressed }) => <Ionicons name="location-outline" size={16} color={pressed ? tokens.primaryForeground : tokens.foreground} />}
                </Pressable>
                {!formIsManual && !noScannerFound ? (
                  // The one way to scan, from the very first SKU onward — the
                  // dashed box below is just an instructional note before
                  // anything's scanned, not a second trigger into the same
                  // action.
                  <Pressable
                    onPress={() => setScannerOpen('sku')}
                    hitSlop={8}
                    style={({ pressed }) => [
                      styles.headerScanBtn,
                      {
                        backgroundColor: pressed ? tokens.primary : tokens.muted,
                        borderColor: pressed ? tokens.primary : tokens.border,
                        borderRadius: tokens.radius.lg,
                      },
                    ]}
                  >
                    {({ pressed }) => <Ionicons name="qr-code-outline" size={16} color={pressed ? tokens.primaryForeground : tokens.foreground} />}
                  </Pressable>
                ) : null}
              </View>
            </View>

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
                {/* Asked right after Selected Location Details, independent
                    of whether the pallet's been scanned yet — see
                    palletConditionGood's own state comment above. Sits at
                    the very top of the form for exactly that reason. */}
                <View style={[styles.fieldCard, { backgroundColor: tokens.card, borderWidth: 0, borderRadius: tokens.radius.xl }]}>
                  <View style={[styles.fieldCardBody, { paddingHorizontal: 0, paddingVertical: 0 }]}>
                    <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm }}>
                      Is the pallet condition at this location good? <Text style={{ color: tokens.rag.red.strong }}>*</Text>
                    </Text>
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
                    {palletConditionGood === false ? (
                      <EvidenceBlock
                        evidence={conditionEvidence}
                        onOpenNote={() => updateConditionEvidence({ noteOpen: true })}
                        onChangeNote={(note) => updateConditionEvidence({ note })}
                        onRecordAudio={() => updateConditionEvidence({ audio: { durationSec: 20, playing: false, bars: generateWaveformBars() } })}
                        onToggleAudioPlay={() => {
                          if (!conditionEvidence.audio) return;
                          updateConditionEvidence({ audio: { ...conditionEvidence.audio, playing: !conditionEvidence.audio.playing } });
                        }}
                        onRemoveAudio={() => updateConditionEvidence({ audio: null })}
                        onAddImage={() => setAttachmentTarget('condition')}
                        onRemoveImage={(i) => updateConditionEvidence({ images: conditionEvidence.images.filter((_, ii) => ii !== i) })}
                        onAddVideo={() => updateConditionEvidence({ videos: [...conditionEvidence.videos, { durationSec: 20 }] })}
                        onRemoveVideo={(i) => updateConditionEvidence({ videos: conditionEvidence.videos.filter((_, ii) => ii !== i) })}
                      />
                    ) : null}
                  </View>
                </View>

                {!formIsManual ? (
                  // Same underlying state/handler the footer's old "Empty"
                  // button used (handleToggleNoScannerFound) — moved up here
                  // as a real toggle, asked alongside pallet condition
                  // rather than buried in the footer.
                  <View style={styles.emptyToggleRow}>
                    <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm, flex: 1 }}>
                      Is the selected location pallet is empty? <Text style={{ color: tokens.rag.red.strong }}>*</Text>
                    </Text>
                    <SimpleToggle value={noScannerFound} onToggle={() => handleToggleNoScannerFound(!noScannerFound)} />
                  </View>
                ) : null}

                {noScannerFound ? (
                  <View style={[styles.noScannerRow, { backgroundColor: tokens.slate300, borderColor: tokens.mutedForeground, borderRadius: tokens.radius.lg }]}>
                    <Ionicons name="alert-circle" size={20} color={tokens.mutedForeground} />
                    <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.semibold, fontSize: tokens.text.sm, flex: 1 }}>
                      Marked Empty — no scanner code found at this location
                    </Text>
                  </View>
                ) : null}

                {!noScannerFound && !formIsManual && scanLines.length === 0 ? (
                  // Normal mode's only way to scan is the header icon — this
                  // is just an info note pointing at it, not a second
                  // trigger into the same action. A badge icon + heading +
                  // supporting line reads more like guidance than a wall of
                  // text in one paragraph.
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

                {!formIsManual && !noScannerFound ? (
                  // Persistent running tally — how many times the inspector
                  // has actually scanned something onto this pallet (every
                  // distinct successful scan, i.e. scannedLabels.size), not
                  // how many distinct SKU groups that collapses into below —
                  // repeat-scanning the same expected SKU several times
                  // keeps this climbing even while scanLines.length stays
                  // at 1.
                  <View style={styles.scanCountRow}>
                    <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm }}>Scanned SKUS:</Text>
                    <View style={[styles.scanCountBadge, { backgroundColor: tokens.muted, borderRadius: tokens.radius.lg }]}>
                      <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm }}>{String(scannedLabels.size).padStart(2, '0')}</Text>
                    </View>
                  </View>
                ) : null}

                {!formIsManual && !noScannerFound && scanLines.length ? (
                  // Every distinct SKU scanned onto this pallet so far, in
                  // the order it was first scanned — a true accordion, one
                  // open at a time: tapping a collapsed row expands it in
                  // place into the full qty/damage/evidence/raise-issue
                  // editor; tapping the open row (or a different one)
                  // collapses it back to a summary line. Repeat scans of a
                  // SKU already here don't add a new row, they bump that
                  // row's own unit count.
                  <View style={styles.scannedListWrap}>
                    {scanLines.map((line, i) => {
                      const isActive = i === activeLineIndex;
                      // SKU identity only — feeds the per-unit Matched/
                      // Mismatched pills inside the expanded body below, not
                      // shown as its own label up here anymore.
                      const lineMatched = expectedSkus.some((e) => e.sku === line.sku);
                      return (
                        <View key={`${line.sku}-${i}`}>
                          <Pressable
                            onPress={() => {
                              setActiveLineIndex((prev) => (prev === i ? -1 : i));
                              // Each line carries its own confirmed state —
                              // switching to one only shows Matched/
                              // Mismatched if it was actually confirmed.
                              setQtyChecked(!!line.qtyConfirmed);
                              setDamageChecked(!!line.damageConfirmed);
                              setQtyEditing(false);
                              setDamageEditing(false);
                              setOpenUnitIds(new Set());
                            }}
                            style={[
                              styles.scannedRow,
                              { backgroundColor: tokens.card, borderColor: tokens.border, borderRadius: isActive ? 0 : tokens.radius.lg, borderTopLeftRadius: tokens.radius.lg, borderTopRightRadius: tokens.radius.lg, borderBottomWidth: isActive ? 0 : 1 },
                            ]}
                          >
                            <View style={{ flex: 1 }}>
                              <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm }}>{line.sku}</Text>
                              <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xs, marginTop: 1 }}>{line.name}</Text>
                            </View>
                            <View style={[styles.scanCountBadge, { backgroundColor: tokens.accentBlue.soft, borderRadius: tokens.radius.lg, minWidth: 0, paddingHorizontal: 10 }]}>
                              <Text style={{ color: tokens.accentBlue.strong, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm }}>
                                {String(line.unitIds?.length ?? 1).padStart(2, '0')}
                              </Text>
                            </View>
                            <Ionicons name={isActive ? 'chevron-up' : 'chevron-down'} size={16} color={tokens.mutedForeground} />
                          </Pressable>

                          {isActive && scannedLine ? (
                            <View style={[styles.accordionBody, { backgroundColor: tokens.card, borderColor: tokens.border, borderRadius: tokens.radius.lg }]}>
                              {(() => {
                    // SKU identity status (Matched/Mismatched) is already
                    // shown on the collapsed accordion row above — no need
                    // to repeat it here as its own header.
                    return (
                      <>
                            <View style={[styles.fieldCard, { backgroundColor: tokens.card, borderColor: tokens.border, borderRadius: tokens.radius.xl }]}>
                              <View style={[styles.fieldCardHead, { backgroundColor: '#F7F8FA', borderBottomColor: tokens.border, borderBottomWidth: 1 }]}>
                                <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm }}>Inventory Unit IDs</Text>
                              </View>
                              <View style={styles.fieldCardBody}>
                                {/* One row per physical unit scanned onto this SKU line (unitIds), not
                                    one section for the whole line. Matched requires both the right SKU
                                    (lineMatched) AND this exact physical unit ID not already sitting at
                                    a different location this audit — a duplicate label showing up
                                    somewhere else is itself a mismatch, so units of the same SKU can
                                    genuinely read differently. Damage is tracked per unit too. */}
                                {(scannedLine.unitIds?.length ? scannedLine.unitIds : [scannedLine.sku]).map((unitId, ui) => {
                                  const unitFlagged = !!scannedLine.unitDamage?.[unitId]?.flagged;
                                  const unitOpen = openUnitIds.has(unitId);
                                  const unitEvidence = scannedLine.unitDamage?.[unitId]?.evidence ?? EMPTY_EVIDENCE;
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
                                            // Same footprint as the chevron above — keeps every row's
                                            // Damage toggle sitting at the same horizontal position
                                            // whether or not that unit has an issue, instead of the
                                            // flagged rows alone shifting left for the extra icon.
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
                                            onRemoveImage={(i) => updateUnitEvidence(unitId, { images: unitEvidence.images.filter((_, ii) => ii !== i) })}
                                            onAddVideo={() => updateUnitEvidence(unitId, { videos: [...unitEvidence.videos, { durationSec: 20 }] })}
                                            onRemoveVideo={(i) => updateUnitEvidence(unitId, { videos: unitEvidence.videos.filter((_, ii) => ii !== i) })}
                                          />
                                      ) : null}
                                    </View>
                                  );
                                })}
                              </View>
                            </View>
                      </>
                    );
                              })()}
                            </View>
                          ) : null}
                        </View>
                      );
                    })}
                  </View>
                ) : null}

                {!noScannerFound && formIsManual && !scannedLine ? (
                  // Manual Mode has no header scan icon — this dashed box is
                  // still its one way into a scan.
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
                      Scans the SKU code on this pallet so you can report what you actually found here.
                    </Text>
                  </>
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
              <View>
                {conditionRequiredError && palletConditionGood === null ? (
                  <View style={[styles.footerErrorBanner, { backgroundColor: tokens.rag.red.soft, borderRadius: tokens.radius.lg }]}>
                    <Ionicons name="alert-circle" size={16} color={tokens.rag.red.strong} />
                    <Text style={{ color: tokens.rag.red.strong, fontSize: tokens.text.xs, fontWeight: tokens.fontWeight.semibold, flex: 1 }}>
                      Select Good or Not Good for pallet condition to continue.
                    </Text>
                  </View>
                ) : scanRequiredError ? (
                  <View style={[styles.footerErrorBanner, { backgroundColor: tokens.rag.red.soft, borderRadius: tokens.radius.lg }]}>
                    <Ionicons name="alert-circle" size={16} color={tokens.rag.red.strong} />
                    <Text style={{ color: tokens.rag.red.strong, fontSize: tokens.text.xs, fontWeight: tokens.fontWeight.semibold, flex: 1 }}>
                      Scan at least one item, or mark this location empty, to continue.
                    </Text>
                  </View>
                ) : null}
                <View style={[styles.skuPanelFooter, { borderTopColor: tokens.border }]}>
                <Pressable onPress={() => setSkuPanelOpen(false)} style={[styles.outlineBtn, { flex: 1, backgroundColor: tokens.muted, borderColor: tokens.border, borderRadius: tokens.radius.lg }]}>
                  <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.semibold, fontSize: tokens.text.sm }}>Cancel</Text>
                </Pressable>
                <Pressable
                  onPress={handleSaveAndScanNextPress}
                  style={[styles.primaryBtn, { flex: 1, backgroundColor: tokens.primary, borderRadius: tokens.radius.lg }]}
                >
                  <Text style={{ color: tokens.primaryForeground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm }}>Save & Scan Next</Text>
                </Pressable>
                </View>
              </View>
            )}
          </Card>
        ) : null}
        </View>
      </View>

      <Modal visible={locationDetailsOpen} transparent animationType="fade" onRequestClose={() => setLocationDetailsOpen(false)}>
        <Pressable style={[styles.dupBackdrop, { backgroundColor: 'rgba(0,0,0,0.5)' }]} onPress={() => setLocationDetailsOpen(false)}>
          <Pressable style={[styles.locModalCard, { backgroundColor: tokens.popover, borderRadius: tokens.radius.xl }]} onPress={(e) => e.stopPropagation()}>
            <View style={styles.locModalHead}>
              <View style={[styles.locModalIconWrap, { backgroundColor: tokens.accentBlue.soft }]}>
                <Ionicons name="location" size={20} color={tokens.accentBlue.strong} />
              </View>
              <Text style={{ flex: 1, color: tokens.popoverForeground, fontWeight: tokens.fontWeight.extrabold, fontSize: tokens.text.base }}>Location Details</Text>
              <Pressable onPress={() => setLocationDetailsOpen(false)} hitSlop={8}>
                <Ionicons name="close" size={20} color={tokens.mutedForeground} />
              </Pressable>
            </View>

            {(() => {
              const bayForLoc = selectedLocObj ? rackObj.bays.find((b) => b.locations.some((l) => l.code === selectedLocObj.code)) : undefined;
              const { level, position } = locLevelPosition(bayForLoc, selectedLocObj?.code);
              return (
                <>
                  <View style={[styles.locModalHero, { backgroundColor: tokens.accentBlue.soft, borderRadius: tokens.radius.lg }]}>
                    <Text style={{ color: tokens.accentBlue.strong, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.xxs, textTransform: 'uppercase', letterSpacing: 0.4 }}>
                      Pallet
                    </Text>
                    <Text style={{ color: tokens.accentBlue.strong, fontWeight: tokens.fontWeight.extrabold, fontSize: tokens.text.lg, marginTop: 2 }}>
                      {selectedLocObj ? palletIdFor(selectedLocObj) : '—'}
                    </Text>
                  </View>
                  <View style={styles.locModalGrid}>
                    <DetailRow label="Layout" value={layoutObj.name} tokens={tokens} />
                    <DetailRow label="Rack" value={rackObj.code} tokens={tokens} />
                    <DetailRow label="Bay" value={selectedLocObj ? bayCodeForLoc(selectedLocObj.code) : '—'} tokens={tokens} />
                    <DetailRow label="Level" value={level ? `L${level}` : '—'} tokens={tokens} />
                    <DetailRow label="Position" value={position ? `P${String(position).padStart(2, '0')}` : '—'} tokens={tokens} />
                  </View>
                </>
              );
            })()}
          </Pressable>
        </Pressable>
      </Modal>

      <BarcodeScannerModal
        visible={scannerOpen === 'sku'}
        title={formIsManual ? 'Scan SKU' : 'Scan SKUs'}
        hint={formIsManual ? 'Point at the SKU QR code on the pallet' : "Scan a box's code. Scan again (from the header icon) to add another SKU or another unit."}
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

      {/* Same Modal/backdrop/card language as Zone Audit's own "Already
          Scanned" prompt — refuses the re-scan (same physical box's code,
          not just the same SKU) instead of quietly counting it again, with
          a one-tap way to retry with a different box. */}
      <Modal visible={!!duplicateScanLabel} transparent animationType="fade" onRequestClose={() => setDuplicateScanLabel(null)}>
        <Pressable style={[styles.dupBackdrop, { backgroundColor: 'rgba(0,0,0,0.5)' }]} onPress={() => setDuplicateScanLabel(null)}>
          <Pressable style={[styles.dupCard, { backgroundColor: tokens.popover, borderRadius: tokens.radius.xl }]} onPress={(e) => e.stopPropagation()}>
            <View style={[styles.dupIconWrap, { backgroundColor: tokens.rag.amber.soft }]}>
              <Ionicons name="alert-outline" size={22} color={tokens.rag.amber.strong} />
            </View>
            <Text style={{ color: tokens.popoverForeground, fontWeight: tokens.fontWeight.extrabold, fontSize: tokens.text.base, marginTop: 12 }}>
              Inventory Unit ID Already Scanned
            </Text>
            <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.sm, lineHeight: 19, marginTop: 6, textAlign: 'center' }}>
              This SKU Inventory Unit ID is already scanned. Proceed to scan another SKU.
            </Text>
            <View style={styles.dupActions}>
              <Pressable onPress={() => setDuplicateScanLabel(null)} style={[styles.dupBtn, styles.dupOutlineBtn, { borderColor: tokens.border, borderRadius: tokens.radius.lg }]}>
                <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.semibold, fontSize: tokens.text.sm }}>Cancel</Text>
              </Pressable>
              <Pressable
                onPress={() => {
                  setDuplicateScanLabel(null);
                  setScannerOpen('sku');
                }}
                style={[styles.dupBtn, { backgroundColor: tokens.rag.amber.strong, borderRadius: tokens.radius.lg }]}
              >
                <Text style={{ color: '#fff', fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm }}>Scan Again</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
      <Modal visible={missingModalOpen} transparent animationType="fade" onRequestClose={() => setMissingModalOpen(false)}>
        <Pressable style={[styles.dupBackdrop, { backgroundColor: 'rgba(0,0,0,0.5)' }]} onPress={() => setMissingModalOpen(false)}>
          <Pressable style={[styles.missingModalCard, { backgroundColor: tokens.popover, borderRadius: tokens.radius.xl }]} onPress={(e) => e.stopPropagation()}>
            <View style={styles.missingModalHead}>
              <View style={[styles.dupIconWrap, { backgroundColor: tokens.rag.red.soft }]}>
                <Ionicons name="shield-outline" size={20} color={tokens.rag.red.strong} />
              </View>
              <Text style={{ flex: 1, color: tokens.popoverForeground, fontWeight: tokens.fontWeight.extrabold, fontSize: tokens.text.base }}>
                Missing Inventory Unit IDs
              </Text>
            </View>
            <View style={[styles.manualInfoDivider, { backgroundColor: tokens.border }]} />
            <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.sm, lineHeight: 19 }}>
              The following SKUs have Inventory Unit IDs that haven't been scanned yet. Clicking Proceed will mark them as missing.
            </Text>
            <View style={[styles.missingTotalBadge, { backgroundColor: tokens.accentBlue.soft, borderRadius: tokens.radius.lg }]}>
              <Text style={{ color: tokens.accentBlue.strong, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm }}>Total : {missingTotal}</Text>
            </View>
            <ScrollView style={styles.missingTableScroll}>
              <View style={[styles.missingTableHead, { borderBottomColor: tokens.border }]}>
                <Text style={{ flex: 1, color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.xs }}>SKU ID & Name</Text>
                <Text style={{ flex: 1.4, color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.xs }}>Inventory Unit IDs</Text>
              </View>
              {missingGroups.map((g) => (
                <View key={g.sku} style={[styles.missingTableRow, { borderBottomColor: tokens.border }]}>
                  <View style={{ flex: 1 }}>
                    <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm }}>{g.sku}</Text>
                    <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xs, marginTop: 1 }}>{g.name}</Text>
                  </View>
                  <Text style={{ flex: 1.4, color: tokens.foreground, fontSize: tokens.text.sm }}>{g.missingIds.join(', ')}</Text>
                </View>
              ))}
            </ScrollView>
            <View style={[styles.manualInfoDivider, { backgroundColor: tokens.border, marginBottom: 0 }]} />
            <View style={[styles.dupActions, { marginTop: 16 }]}>
              <Pressable onPress={() => setMissingModalOpen(false)} style={[styles.dupBtn, styles.dupOutlineBtn, { borderColor: tokens.border, borderRadius: tokens.radius.lg }]}>
                <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.semibold, fontSize: tokens.text.sm }}>Cancel</Text>
              </Pressable>
              <Pressable onPress={handleConfirmMissingAndProceed} style={[styles.dupBtn, { backgroundColor: tokens.primary, borderRadius: tokens.radius.lg }]}>
                <Text style={{ color: tokens.primaryForeground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm }}>Proceed</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
      <Modal
        visible={manualModeInfoOpen}
        transparent
        animationType="fade"
        onRequestClose={() => {
          setManualMode(false);
          setManualModeInfoOpen(false);
        }}
      >
        <Pressable style={[styles.dupBackdrop, { backgroundColor: 'rgba(0,0,0,0.5)' }]} onPress={() => setManualModeInfoOpen(false)}>
          <Pressable style={[styles.missingModalCard, { backgroundColor: tokens.popover, borderRadius: tokens.radius.xl }]} onPress={(e) => e.stopPropagation()}>
            <View style={styles.manualInfoHeadRow}>
              <View style={styles.manualInfoHeadLeft}>
                <View style={[styles.dupIconWrap, { backgroundColor: tokens.rag.red.soft }]}>
                  <Ionicons name="information-circle-outline" size={20} color={tokens.rag.red.strong} />
                </View>
                <Text style={{ color: tokens.popoverForeground, fontWeight: tokens.fontWeight.extrabold, fontSize: tokens.text.base }}>Manual Mode</Text>
              </View>
              {/* X reverts the toggle — same as not confirming the gate —
                  while Proceed below just closes, keeping Manual Mode on. */}
              <Pressable
                onPress={() => {
                  setManualMode(false);
                  setManualModeInfoOpen(false);
                }}
                hitSlop={8}
              >
                <Ionicons name="close" size={20} color={tokens.mutedForeground} />
              </Pressable>
            </View>
            <View style={[styles.manualInfoDivider, { backgroundColor: tokens.border }]} />
            <Text style={{ color: tokens.foreground, fontSize: tokens.text.sm, lineHeight: 20 }}>
              Note: Every pallet in this rack is selectable, outside this audit's assigned scope too. Pick a location, scan the SKU that's actually there, and report what
              you found.
            </Text>
            <View style={[styles.manualInfoDivider, { backgroundColor: tokens.border, marginTop: 16 }]} />
            <Pressable onPress={() => setManualModeInfoOpen(false)} style={[styles.manualInfoProceedBtn, { backgroundColor: tokens.primary, borderRadius: tokens.radius.lg }]}>
              <Text style={{ color: tokens.primaryForeground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm }}>Proceed</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>
      <Modal visible={bayFindingsModalOpen} transparent animationType="fade" onRequestClose={() => setBayFindingsModalOpen(false)}>
        <Pressable style={[styles.dupBackdrop, { backgroundColor: 'rgba(0,0,0,0.5)' }]} onPress={() => setBayFindingsModalOpen(false)}>
          <Pressable style={[styles.missingModalCard, styles.bayFindingsModalCard, { backgroundColor: tokens.popover, borderRadius: tokens.radius.xl }]} onPress={(e) => e.stopPropagation()}>
            <View style={styles.manualInfoHeadRow}>
              <Text style={{ color: tokens.popoverForeground, fontWeight: tokens.fontWeight.extrabold, fontSize: tokens.text.base }}>Findings at selected location</Text>
              <Pressable onPress={() => setBayFindingsModalOpen(false)} hitSlop={8}>
                <Ionicons name="close" size={20} color={tokens.mutedForeground} />
              </Pressable>
            </View>
            <View style={[styles.manualInfoDivider, { backgroundColor: tokens.border }]} />
            <View style={[styles.findingsTabRow, { backgroundColor: tokens.muted, borderRadius: tokens.radius.lg }]}>
              {(['All', 'Pallet Damage', 'Mismatched SKU', 'Missing SKU', 'Pallet Empty'] as const).map((t) => {
                const active = bayFindingsFilter === t;
                return (
                  <Pressable
                    key={t}
                    onPress={() => setBayFindingsFilter(t)}
                    style={[styles.findingsTab, active ? { backgroundColor: tokens.accentBlue.soft, borderRadius: tokens.radius.lg } : null]}
                  >
                    <Text
                      numberOfLines={1}
                      style={{ color: active ? tokens.accentBlue.strong : tokens.mutedForeground, fontWeight: tokens.fontWeight.semibold, fontSize: tokens.text.xs }}
                    >
                      {t}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
            <ScrollView style={styles.findingsListScroll}>
              {bayFindingsFiltered.length ? (
                bayFindingsFiltered.map((f, i) => {
                  const badge =
                    f.findingType === 'Missing SKU'
                      ? { bg: tokens.accentBlue.soft, fg: tokens.accentBlue.strong }
                      : f.findingType === 'Pallet Damage'
                        ? { bg: tokens.rag.red.soft, fg: tokens.rag.red.strong }
                        : f.findingType === 'Pallet Empty'
                          ? { bg: tokens.accentPurple.soft, fg: tokens.accentPurple.strong }
                          : { bg: tokens.rag.amber.soft, fg: tokens.rag.amber.strong };
                  const bayObjForFinding = rackObj.bays.find((b) => b.code === f.bay);
                  const { level, position } = locLevelPosition(bayObjForFinding, f.locCode);
                  const location = `${f.layout} · Rack ${f.rack} · Bay ${f.bay} · ${level != null ? `L-${String(level).padStart(2, '0')}` : '—'} · ${
                    position != null ? `P${String(position).padStart(2, '0')}` : '—'
                  } · ${f.pallet}`;
                  return (
                    <View key={`${f.discId}-${f.unitId}-${i}`} style={[styles.findingRowCard, { borderColor: tokens.border, borderRadius: tokens.radius.lg }]}>
                      <View style={[styles.findingRowStripe, { backgroundColor: tokens.accentBlue.base }]} />
                      <View style={{ flex: 1, padding: 12 }}>
                        <View style={[styles.findingTypeBadgeSmall, { backgroundColor: badge.bg, borderRadius: tokens.radius.lg }]}>
                          <Text style={{ color: badge.fg, fontSize: tokens.text.xs, fontWeight: tokens.fontWeight.bold }}>{f.findingType}</Text>
                        </View>
                        <View style={styles.findingsColRow}>
                          <View style={{ flex: 1 }}>
                            <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.xs, marginBottom: 2 }}>SKU</Text>
                            <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.sm }}>{f.sku || '—'}</Text>
                          </View>
                          <View style={{ flex: 1 }}>
                            <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.xs, marginBottom: 2 }}>Inventory unit id</Text>
                            <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.sm }}>{f.findingType === 'Pallet Empty' ? '—' : f.unitId}</Text>
                          </View>
                          <View style={{ flex: 2 }}>
                            <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.xs, marginBottom: 2 }}>Location</Text>
                            <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.sm }} numberOfLines={1}>
                              {location}
                            </Text>
                          </View>
                        </View>
                      </View>
                    </View>
                  );
                })
              ) : (
                <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.sm, paddingVertical: 20, textAlign: 'center' }}>No findings for this bay yet.</Text>
              )}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
      <NewAttachmentModal
        visible={attachmentTarget !== null}
        onClose={() => setAttachmentTarget(null)}
        onSave={(image) => {
          if (attachmentTarget === null) return;
          if (attachmentTarget === 'condition') {
            updateConditionEvidence({ images: [...conditionEvidence.images, image] });
            return;
          }
          if (attachmentTarget.startsWith('unit:')) {
            const unitId = attachmentTarget.slice('unit:'.length);
            const existing = scannedLine?.unitDamage?.[unitId]?.evidence?.images ?? [];
            updateUnitEvidence(unitId, { images: [...existing, image] });
            return;
          }
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
              <Text style={{ color: tokens.popoverForeground, fontWeight: tokens.fontWeight.extrabold, fontSize: tokens.text.lg }}>
                Unresolved Locations
              </Text>
              <Pressable onPress={() => setPendingModalOpen(false)} hitSlop={8}>
                <Ionicons name="close" size={22} color={tokens.foreground} />
              </Pressable>
            </View>
            <View style={[styles.pendingHeadDivider, { backgroundColor: tokens.border }]} />

            <View style={styles.pendingScanRow}>
              <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.sm }}>Location to be scanned</Text>
              <View>
                <Pressable
                  onPress={() => setPendingFilterOpen((o) => !o)}
                  style={[styles.pendingFilterIconBtn, { backgroundColor: tokens.card, borderColor: tokens.border, borderRadius: tokens.radius.lg }]}
                >
                  <Ionicons name="filter-outline" size={16} color={tokens.foreground} />
                </Pressable>
                {pendingFilterOpen ? (
                  <>
                    <Pressable style={StyleSheet.absoluteFill} onPress={() => setPendingFilterOpen(false)} />
                    <View style={[styles.pendingFilterPanel, { backgroundColor: tokens.popover, borderColor: tokens.border, borderRadius: tokens.radius.lg }]}>
                      {pendingLayoutNames.map((name) => {
                        const checked = pendingLayoutFilter.includes(name);
                        return (
                          <Pressable key={name} onPress={() => togglePendingLayoutFilter(name)} style={styles.pendingFilterRow}>
                            <View
                              style={[
                                styles.pendingFilterCheckbox,
                                { borderRadius: tokens.radius.sm, borderColor: checked ? tokens.primary : tokens.border, backgroundColor: checked ? tokens.primary : 'transparent' },
                              ]}
                            >
                              {checked ? <Ionicons name="checkmark" size={12} color={tokens.primaryForeground} /> : null}
                            </View>
                            <Text style={{ color: tokens.popoverForeground, fontSize: tokens.text.sm }}>{name}</Text>
                          </Pressable>
                        );
                      })}
                    </View>
                  </>
                ) : null}
              </View>
            </View>

            {pendingLayoutFilter.length ? (
              <View style={styles.pendingChipRow}>
                <View style={[styles.pendingChipDot, { backgroundColor: tokens.primary }]} />
                <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm, marginRight: 4 }}>Rack Name</Text>
                {pendingLayoutFilter.map((name) => (
                  <Pressable
                    key={name}
                    onPress={() => togglePendingLayoutFilter(name)}
                    style={[styles.pendingChip, { backgroundColor: tokens.accentBlue.soft, borderRadius: tokens.radius.lg }]}
                  >
                    <Text style={{ color: tokens.accentBlue.strong, fontSize: tokens.text.sm, fontWeight: tokens.fontWeight.semibold }}>{name}</Text>
                    <Ionicons name="close" size={14} color={tokens.accentBlue.strong} />
                  </Pressable>
                ))}
              </View>
            ) : null}
            <View style={[styles.pendingHeadDivider, { backgroundColor: tokens.border }]} />

            {(() => {
              const filtered = pendingLayoutFilter.length ? warehousePending.filter((i) => pendingLayoutFilter.includes(i.layout)) : warehousePending;
              // Layout → Rack → location pill grid, warehouse-wide — same
              // "default open, mark closed" accordion pattern as Audit
              // Details' own bay breakdown, just one level up (layout
              // instead of bay), since this spans every rack in the audit.
              const byLayout = pendingLayoutNames
                .map((name) => ({ layout: name, items: filtered.filter((i) => i.layout === name) }))
                .filter((g) => g.items.length);

              return (
                <ScrollView style={{ maxHeight: 460 }}>
                  {byLayout.length ? (
                    byLayout.map(({ layout, items }) => {
                      const open = openPendingLayout === layout;
                      const byRack = [...new Set(items.map((i) => i.rack))].map((rackCode) => ({
                        rack: rackCode,
                        items: items.filter((i) => i.rack === rackCode),
                      }));
                      return (
                        <View key={layout} style={styles.pendingLayoutSection}>
                          <Pressable
                            onPress={() => setOpenPendingLayout((prev) => (prev === layout ? null : layout))}
                            style={styles.pendingLayoutHead}
                          >
                            <View style={[styles.pendingIconWrap, { backgroundColor: tokens.accentBlue.soft, borderRadius: tokens.radius.lg }]}>
                              <Ionicons name="business-outline" size={18} color={tokens.accentBlue.strong} />
                            </View>
                            <Text style={{ flex: 1, color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.base }}>{layout}</Text>
                            <View style={[styles.pendingBayBadge, { backgroundColor: tokens.accentBlue.soft, borderRadius: tokens.radius.lg }]}>
                              <Text style={{ color: tokens.accentBlue.strong, fontSize: tokens.text.xs, fontWeight: tokens.fontWeight.bold }}>Total :{items.length}</Text>
                            </View>
                            <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={16} color="#667085" />
                          </Pressable>
                          {open
                            ? byRack.map(({ rack, items: rackItems }) => (
                                <View key={rack} style={styles.pendingRackSection}>
                                  <View style={styles.pendingRackHead}>
                                    <View style={[styles.pendingIconWrapSm, { backgroundColor: tokens.accentBlue.soft, borderRadius: tokens.radius.lg }]}>
                                      <Ionicons name="layers-outline" size={14} color={tokens.accentBlue.strong} />
                                    </View>
                                    <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.semibold, fontSize: tokens.text.sm }}>Rack {rack}</Text>
                                    <View style={[styles.pendingBayBadge, { backgroundColor: tokens.accentBlue.soft, borderRadius: tokens.radius.lg }]}>
                                      <Text style={{ color: tokens.accentBlue.strong, fontSize: tokens.text.xs, fontWeight: tokens.fontWeight.bold }}>
                                        Total : {rackItems.length}
                                      </Text>
                                    </View>
                                  </View>
                                  <View style={styles.pendingPillGrid}>
                                    {rackItems.map((item) => {
                                      const palletId = item.loc.pallets[0]?.pallet ?? '—';
                                      const label =
                                        item.loc.level != null && item.loc.slot != null
                                          ? `L${item.loc.level}-P${String(item.loc.slot).padStart(2, '0')}-${palletId}`
                                          : palletId;
                                      return (
                                        <Pressable
                                          key={item.loc.code}
                                          onPress={() => {
                                            setPendingModalOpen(false);
                                            router.push({
                                              pathname: '/audit/[auditId]/rack/[rackId]',
                                              params: { auditId, rackId: item.rack, layout: item.layout, bay: item.bay, loc: item.loc.code },
                                            } as never);
                                          }}
                                          style={[styles.pendingPill, { backgroundColor: tokens.muted, borderRadius: tokens.radius.xxl }]}
                                        >
                                          <Text style={{ color: tokens.foreground, fontSize: tokens.text.sm, fontWeight: tokens.fontWeight.semibold }} numberOfLines={1}>
                                            {label}
                                          </Text>
                                        </Pressable>
                                      );
                                    })}
                                  </View>
                                </View>
                              ))
                            : null}
                        </View>
                      );
                    })
                  ) : (
                    <View style={{ alignItems: 'center', gap: 8, paddingVertical: 40 }}>
                      <Ionicons name="checkmark-circle-outline" size={28} color={tokens.mutedForeground} />
                      <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm }}>Nothing pending</Text>
                      <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xs }}>Every in-scope pallet in this audit is matched.</Text>
                    </View>
                  )}
                </ScrollView>
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

// Replaces the old settings-icon + centered-modal Scan Direction control —
// a persistent bottom toolbar on the canvas itself (never hidden behind a
// tap), matching the reference: a From Left/Right pair, a 4-way Pattern
// group (combining vertical direction with raster-vs-snake), and a scope
// dropdown. Always visible, whether or not the Reconciliation Form panel
// is open, since the pattern matters just as much while still picking the
// first pallet as it does mid-audit.
// Just the From/Pattern controls — Scope now lives in the canvas header
// next to the info pill, not down here.
function ScanDirectionToolbar({
  from,
  pattern,
  vertical,
  onSetFrom,
  onSetPattern,
}: {
  from: ScanFrom;
  pattern: ScanPattern;
  vertical: ScanVertical;
  onSetFrom: (f: ScanFrom) => void;
  onSetPattern: (p: ScanPattern, v: ScanVertical) => void;
}) {
  const { tokens } = useTheme();
  // Each pattern icon is a hooked return arrow — Last (snake) hooks
  // FORWARD (continues in the direction of travel), First (raster) hooks
  // BACK (returns to the starting side) — matching the reference exactly.
  // No Left/Right prefix here — the From buttons directly to the left of
  // this group already convey that, so repeating it in every pattern
  // label would just be redundant.
  const patternButtons: { pattern: ScanPattern; vertical: ScanVertical; corner: 'right-up' | 'left-up' | 'right-down' | 'left-down'; label: string }[] = [
    { pattern: 'first', vertical: 'up', corner: 'left-up', label: 'Initial Up' },
    { pattern: 'last', vertical: 'up', corner: 'right-up', label: 'Current Up' },
    { pattern: 'first', vertical: 'down', corner: 'left-down', label: 'Initial Down' },
    { pattern: 'last', vertical: 'down', corner: 'right-down', label: 'Current Down' },
  ];
  return (
    // Negative margins cancel out diagramBody's own 14px padding (this
    // toolbar renders as diagramBody's last child) so the bar bleeds all
    // the way to the canvas Card's actual border on the left, right, and
    // bottom — Card's overflow:hidden clips it cleanly to its rounded
    // corners rather than the bar floating inset inside the canvas frame.
    <View style={[dirToolbarStyles.row, { backgroundColor: '#F7F8FA', borderTopColor: tokens.border, marginHorizontal: -14, marginBottom: -14 }]}>
      <DirToolbarBtn customIcon={<BarArrowIcon pointing="left" color={from === 'right' ? tokens.primary : tokens.foreground} />} label="Left" active={from === 'right'} onPress={() => onSetFrom('right')} />
      <DirToolbarBtn customIcon={<BarArrowIcon pointing="right" color={from === 'left' ? tokens.primary : tokens.foreground} />} label="Right" active={from === 'left'} onPress={() => onSetFrom('left')} />
      <View style={[dirToolbarStyles.divider, { backgroundColor: tokens.border }]} />
      {patternButtons.map((b) => (
        <DirToolbarBtn
          key={`${b.pattern}-${b.vertical}`}
          customIcon={<CornerArrowIcon corner={b.corner} color={pattern === b.pattern && vertical === b.vertical ? tokens.primary : tokens.foreground} />}
          label={b.label}
          active={pattern === b.pattern && vertical === b.vertical}
          onPress={() => onSetPattern(b.pattern, b.vertical)}
        />
      ))}
    </View>
  );
}

// Ionicons has no "arrow into a wall" glyph — a straight stroke with an
// arrowhead on one end and a flat bar on the other — so this is drawn
// directly as an SVG path to match the reference pixel-for-pixel instead
// of approximating with a stock icon.
function BarArrowIcon({ pointing, color }: { pointing: 'left' | 'right'; color: string }) {
  return (
    <Svg width={18} height={16} viewBox="0 0 24 24" fill="none">
      {pointing === 'left' ? (
        <>
          <Path d="M20 12 H7" stroke={color} strokeWidth={2} strokeLinecap="round" />
          <Path d="M11 7 L6 12 L11 17" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
          <Path d="M20 5 V19" stroke={color} strokeWidth={2} strokeLinecap="round" />
        </>
      ) : (
        <>
          <Path d="M4 12 H17" stroke={color} strokeWidth={2} strokeLinecap="round" />
          <Path d="M13 7 L18 12 L13 17" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
          <Path d="M4 5 V19" stroke={color} strokeWidth={2} strokeLinecap="round" />
        </>
      )}
    </Svg>
  );
}

// Same "sharp-cornered" hook shape the reference uses (an L-turn into an
// arrowhead), not Ionicons' smoother return-up/return-down curves —
// mirrored/flipped per corner rather than four separate hand-drawn paths.
function CornerArrowIcon({ corner, color }: { corner: 'right-up' | 'left-up' | 'right-down' | 'left-down'; color: string }) {
  // Base shape drawn as "right-up": foot at bottom-left, corner turn on
  // the right, arrowhead pointing up. The other 3 corners are this exact
  // same path, just reflected horizontally and/or vertically.
  const flipX = corner === 'left-up' || corner === 'left-down';
  const flipY = corner === 'right-down' || corner === 'left-down';
  return (
    <Svg width={16} height={16} viewBox="0 0 24 24" fill="none" style={{ transform: [{ scaleX: flipX ? -1 : 1 }, { scaleY: flipY ? -1 : 1 }] }}>
      <Path d="M4 18 H11 Q17 18 17 12 V6" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      <Path d="M13 10 L17 6 L21 10" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

// Icon and label are two separate elements, not one bordered pill — only
// the icon square gets a border/fill for the active state; the label
// underneath is plain text, same as the reference.
function DirToolbarBtn({
  icon,
  customIcon,
  label,
  active,
  onPress,
}: {
  icon?: keyof typeof Ionicons.glyphMap;
  customIcon?: ReactNode;
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  const { tokens } = useTheme();
  return (
    <Pressable onPress={onPress} style={dirToolbarStyles.btnWrap}>
      <View
        style={[dirToolbarStyles.btn, { borderColor: active ? tokens.primary : tokens.border, backgroundColor: active ? tokens.accentBlue.soft : tokens.card, borderRadius: tokens.radius.lg }]}
      >
        {customIcon ?? (icon ? <Ionicons name={icon} size={16} color={active ? tokens.primary : tokens.foreground} /> : null)}
      </View>
      {/* No numberOfLines/truncation — the wrap is wide enough (and the
          font small enough) that every label fits on one line, same as
          the reference; clipping it to an ellipsis was the actual bug. */}
      <Text style={{ color: active ? tokens.primary : tokens.mutedForeground, fontWeight: active ? tokens.fontWeight.bold : tokens.fontWeight.medium, fontSize: 9, textAlign: 'center' }}>
        {label}
      </Text>
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
      <Text style={{ color: value ? tokens.rag.amber.strong : tokens.foreground, fontWeight: tokens.fontWeight.semibold, fontSize: tokens.text.xs }}>Manual Mode</Text>
      <View style={[styles.switchTrack, { backgroundColor: value ? tokens.rag.amber.strong : tokens.slate300 }]}>
        <Animated.View style={[styles.switchThumb, thumbStyle]} />
      </View>
    </Pressable>
  );
}

// Bare track+thumb, no icon/label — used where the question text itself is
// the label (e.g. "Is the selected location pallet is empty?").
function SimpleToggle({ value, onToggle }: { value: boolean; onToggle: () => void }) {
  const { tokens } = useTheme();
  const thumbX = useSharedValue(value ? 16 : 2);

  useEffect(() => {
    thumbX.value = withTiming(value ? 16 : 2, { duration: 180 });
  }, [value]);

  const thumbStyle = useAnimatedStyle(() => ({ transform: [{ translateX: thumbX.value }] }));

  return (
    <Pressable onPress={onToggle} hitSlop={8}>
      <View style={[styles.switchTrack, { backgroundColor: value ? tokens.primary : tokens.slate300 }]}>
        <Animated.View style={[styles.switchThumb, thumbStyle]} />
      </View>
    </Pressable>
  );
}

function DetailRow({ label, value, tokens }: { label: string; value: string; tokens: ReturnType<typeof useTheme>['tokens'] }) {
  return (
    <View style={styles.detailRow}>
      <Text style={{ color: tokens.mutedForeground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.xxs, textTransform: 'uppercase', letterSpacing: 0.4 }}>
        {label}
      </Text>
      <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm, marginTop: 3 }}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  dupBackdrop: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  dupCard: { width: '100%', maxWidth: 340, padding: 20, alignItems: 'center' },
  missingModalCard: { width: '100%', maxWidth: 560, padding: 22, maxHeight: '80%' },
  // Wider than the default modal card — 5 filter tabs (All/Pallet Damage/
  // Mismatched SKU/Missing SKU/Pallet Empty) need the extra room to each
  // sit on one line instead of wrapping/truncating.
  bayFindingsModalCard: { maxWidth: 820 },
  manualInfoHeadRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  manualInfoHeadLeft: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  manualInfoDivider: { height: StyleSheet.hairlineWidth, marginVertical: 14 },
  manualInfoProceedBtn: { height: 48, alignItems: 'center', justifyContent: 'center', marginTop: 16 },
  infoIconBtn: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
  footerErrorBanner: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 10, marginTop: 10 },
  findingsTabRow: { flexDirection: 'row', padding: 4, marginTop: 14, gap: 4 },
  findingsTab: { flex: 1, paddingVertical: 8, paddingHorizontal: 6, alignItems: 'center', justifyContent: 'center' },
  findingsListScroll: { marginTop: 14, maxHeight: 420 },
  findingRowCard: { flexDirection: 'row', borderWidth: 1, overflow: 'hidden', marginBottom: 10 },
  findingRowStripe: { width: 4 },
  findingTypeBadgeSmall: { alignSelf: 'flex-start', paddingHorizontal: 8, paddingVertical: 3, marginBottom: 8 },
  findingsColRow: { flexDirection: 'row', gap: 12 },
  missingModalHead: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  missingTotalBadge: { alignSelf: 'flex-start', paddingHorizontal: 12, paddingVertical: 5, marginTop: 12 },
  missingTableScroll: { marginTop: 14 },
  missingTableHead: { flexDirection: 'row', paddingBottom: 8, borderBottomWidth: 1, marginBottom: 4 },
  missingTableRow: { flexDirection: 'row', paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  dupIconWrap: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  dupActions: { flexDirection: 'row', gap: 10, marginTop: 20, width: '100%' },
  dupBtn: { flex: 1, height: 44, alignItems: 'center', justifyContent: 'center' },
  dupOutlineBtn: { borderWidth: 1 },
  toolbar: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  manualModeWrap: { flexDirection: 'row', alignItems: 'center', gap: 7, height: 36, paddingHorizontal: 6 },
  switchTrack: { width: 34, height: 20, borderRadius: 10 },
  switchThumb: { position: 'absolute', top: 2, left: 0, width: 16, height: 16, borderRadius: 8, backgroundColor: '#fff' },
  manualModeBanner: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, paddingVertical: 8, borderBottomWidth: 1 },
  body: { flex: 1, padding: 16 },
  singleRow: { flex: 1 },
  splitRow: { flex: 1, flexDirection: 'row', gap: 16 },
  diagramHeadRow: { minHeight: 60, paddingHorizontal: 14, paddingVertical: 12, borderBottomWidth: 1 },
  directionBadge: { flexDirection: 'row', alignItems: 'center', gap: 6, height: 36, paddingHorizontal: 12 },
  // overflow: 'hidden' clips the pan/zoom transform to THIS box specifically
  // — without it, only the outer Card's overflow:hidden applied, which
  // clips to the Card's full bounds (header row included), so panning/
  // zooming the canvas could paint transformed content up over the
  // diagramHeadRow above it instead of staying confined to the canvas area.
  diagramBody: { flex: 1, padding: 14, overflow: 'hidden' },
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
  skuPanelHead: { minHeight: 60, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginHorizontal: -16, marginTop: -16, marginBottom: 14, paddingHorizontal: 14, paddingVertical: 12, borderBottomWidth: 1 },
  headerScanBtn: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
  locDetailsBox: { flexDirection: 'row', flexWrap: 'wrap', rowGap: 12, columnGap: 16, marginBottom: 16 },
  locModalCard: { width: '100%', maxWidth: 440, padding: 26 },
  locModalHead: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 20 },
  locModalIconWrap: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  locModalHero: { padding: 16, marginBottom: 20 },
  locModalGrid: { flexDirection: 'row', flexWrap: 'wrap', rowGap: 14, columnGap: 10 },
  divider: { height: StyleSheet.hairlineWidth, marginBottom: 16 },
  // Fixed width (no flexGrow) — a lone item on the last row must NOT
  // stretch to fill the leftover space, or it renders far wider than every
  // other field above it (this is what made Level/Position look so
  // mismatched: Position was alone on its row and stretching almost to the
  // full card width).
  detailRow: { width: '45%' },
  scanDottedBox: { flex: 1, minHeight: 160, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderStyle: 'dashed', paddingVertical: 32, marginBottom: 10 },
  scanDottedIconWrap: { width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center' },
  scannedListWrap: { gap: 8, marginBottom: 10 },
  unitDivider: { marginTop: 14, paddingTop: 14, borderTopWidth: StyleSheet.hairlineWidth },
  unitRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  unitDamageWrap: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  scannedRow: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, padding: 10 },
  unitBadge: { paddingHorizontal: 10, paddingVertical: 4 },
  accordionBody: { borderWidth: 1, borderTopWidth: 0, borderTopLeftRadius: 0, borderTopRightRadius: 0, padding: 12, gap: 10 },
  sectionToggle: { width: 22, height: 22, borderRadius: 11, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  scanNoteBox: { flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: 1, padding: 14 },
  scanCountRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  emptyToggleRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  scanCountBadge: { paddingHorizontal: 12, paddingVertical: 4, minWidth: 34, alignItems: 'center' },
  scanNoteIconWrap: { width: 40, height: 40, borderRadius: 20, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
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
  backdrop: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  pendingModalCard: { width: '100%', maxWidth: 900, maxHeight: '85%', padding: 20 },
  pendingModalHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 },
  pendingHeadDivider: { height: StyleSheet.hairlineWidth },
  pendingScanRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 14 },
  pendingFilterIconBtn: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
  pendingFilterPanel: { position: 'absolute', top: 42, right: 0, width: 200, borderWidth: 1, padding: 10, zIndex: 21 },
  pendingFilterRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8 },
  pendingFilterCheckbox: { width: 18, height: 18, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  pendingChipRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8, paddingVertical: 12 },
  pendingChipDot: { width: 6, height: 6, borderRadius: 3 },
  pendingChip: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, paddingVertical: 5 },
  pendingLayoutSection: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#e2e8f0', paddingVertical: 14 },
  pendingLayoutHead: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  pendingIconWrap: { width: 34, height: 34, alignItems: 'center', justifyContent: 'center' },
  pendingIconWrapSm: { width: 26, height: 26, alignItems: 'center', justifyContent: 'center' },
  pendingBayBadge: { paddingHorizontal: 10, paddingVertical: 4 },
  pendingRackSection: { marginTop: 14, marginLeft: 10 },
  pendingRackHead: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 },
  pendingPillGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  pendingPill: { paddingHorizontal: 14, paddingVertical: 10 },
});

const dirToolbarStyles = StyleSheet.create({
  // Same #F7F8FA band + border as the canvas' own diagramHeadRow, and no
  // left/right padding — content is centered within a minHeight matched to
  // that header's own 60, so it bookends the canvas as a true header/footer
  // pair. Stays pinned to the bottom of the card since it's the last child
  // in that fixed-height flex column (outside the pan/zoom GestureDetector,
  // so it never moves with canvas gestures).
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 14, minHeight: 60, paddingHorizontal: 0, paddingVertical: 12, borderTopWidth: 1 },
  divider: { width: StyleSheet.hairlineWidth, alignSelf: 'stretch', marginVertical: 4, marginHorizontal: 2 },
  btnWrap: { alignItems: 'center', gap: 4, width: 76 },
  btn: { width: 38, height: 38, alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
  scopeBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, height: 40, paddingHorizontal: 12, borderWidth: 1 },
});
