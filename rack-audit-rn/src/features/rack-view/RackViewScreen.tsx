import { Ionicons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { cancelAnimation, useAnimatedStyle, useSharedValue, withRepeat, withSequence, withTiming } from 'react-native-reanimated';
import { AppHeader } from '@/components/AppHeader';
import { BarcodeScannerModal } from '@/components/BarcodeScannerModal';
import { Card } from '@/components/Card';
import { EvidenceBlock } from '@/components/EvidenceBlock';
import { NewAttachmentModal } from '@/components/NewAttachmentModal';
import { Pill } from '@/components/Pill';
import { SkuLineCard } from '@/components/SkuLineCard';
import type { SheetOption } from '@/components/BottomSheetPicker';
import { useConfirmDialog } from '@/hooks/useConfirmDialog';
import { useLocationsTree } from '@/hooks/useLocationsTree';
import { findLayoutIn, findRackIn } from '@/lib/locationsRepo';
import { EXPECTED_SKUS, generateWaveformBars, INVENTORY_POOL, type ExpectedSkuLine } from '@/lib/mockData';
import { CONDITIONS, type CountLine, type Evidence, type LocationNode } from '@/lib/types';
import { useTheme } from '@/theme/ThemeProvider';
import { useAudits } from '../dashboard/hooks';
import { useCountSheetMutations } from '../count-sheet/mutations';
import { buildBayDiagram } from './buildBayDiagram';

type Params = { auditId: string; layout: string; rackId: string; bay: string; loc?: string };

const STATUS_TONE = { 'Not Started': 'To Do', 'In Progress': 'In Progress', Completed: 'Completed' } as const;

// Pallet ID shown to the inspector — level + pallet number on that level,
// e.g. level 5 / pallet 1 -> "P-0501" — distinct from the location's
// internal `code` (rack/bay-scoped) used for lookups and saving records.
function palletIdFor(loc: { level?: number; slot?: number; code: string }): string {
  return loc.level != null && loc.slot != null ? `P-${String(loc.level).padStart(2, '0')}${String(loc.slot).padStart(2, '0')}` : loc.code;
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
  const { auditId, layout } = params;
  const { data: audits } = useAudits();
  const audit = audits?.find((a) => a.audit_id === auditId);
  const { data: tree, isLoading } = useLocationsTree(auditId);
  const { saveRecord } = useCountSheetMutations(auditId);

  const [rackCode, setRackCode] = useState(params.rackId);
  const [pickerField, setPickerField] = useState<'rack' | 'pallet' | null>(null);
  const [selectedLoc, setSelectedLoc] = useState<string | null>(params.loc ?? null);
  const [scanCycle, setScanCycle] = useState(0);
  const [skuPanelOpen, setSkuPanelOpen] = useState(false);
  const [scanLines, setScanLines] = useState<CountLine[]>([]);
  const [scanPallet, setScanPallet] = useState<string | null>(null);
  const [expectedSkus, setExpectedSkus] = useState<ExpectedSkuLine[]>([]);
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);
  const [skuScanCount, setSkuScanCount] = useState(0);
  const [scannerOpen, setScannerOpen] = useState<'pallet' | 'sku' | null>(null);
  // Session-only flags (not persisted) — "Raise Issue" in the detail view
  // just gives the inspector visible confirmation; the underlying condition
  // already makes the line show up in Reported Audits once saved.
  const [issuesRaised, setIssuesRaised] = useState<Set<string>>(new Set());
  // Location codes with a raised issue — drives the red dot on that
  // pallet's canvas cell, so a flagged location stays visible even after
  // the panel closes or a different pallet gets selected.
  const [flaggedLocs, setFlaggedLocs] = useState<Set<string>>(new Set());
  const [attachmentTarget, setAttachmentTarget] = useState<number | null>(null);
  // Manual Mode: for reporting a real-world issue (e.g. a damaged pallet)
  // found anywhere in the physical rack, not just the audit's assigned
  // scope — every pallet becomes selectable and the panel skips scanning
  // entirely, going straight to a location + qty/damage + evidence report.
  const [manualMode, setManualMode] = useState(false);
  const [manualLine, setManualLine] = useState<CountLine>({ sku: '', name: '', lot: '—', qty: 1, condition: 'Good' });
  const confirm = useConfirmDialog();

  // Exactly one SKU is expected per pallet, and exactly one scan is on
  // record for it (a new scan replaces the previous one rather than
  // accumulating a checklist). The SKU identity check happens first — if
  // the wrong item was scanned, that's "Misplaced" and there's nothing to
  // reconcile at this location for it. Only once the right SKU is
  // confirmed does the qty/condition form appear; Matched vs. Mismatch is
  // then decided by what the inspector records there.
  const expectedSku = expectedSkus[0] ?? null;
  const scannedLine = scanLines[0] ?? null;
  const skuMatched = !!scannedLine && !!expectedSku && scannedLine.sku === expectedSku.sku;
  const misplaced = !!scannedLine && !skuMatched;

  // Drives the bay canvas cell colors: green once a pallet's scan resolves
  // to a clean match, amber when the right SKU was found but qty/condition
  // is off ("matched but has an issue"), red when the wrong SKU was
  // scanned entirely, gray for anything not yet scanned this session.
  const [locationStatus, setLocationStatus] = useState<Record<string, 'matched' | 'issue' | 'mismatch' | 'missing'>>({});
  // Checked when the inspector physically found no scanner code at all at
  // the selected location — lets them resolve and move past it without a
  // scan, instead of getting stuck waiting for a code that doesn't exist.
  const [noScannerFound, setNoScannerFound] = useState(false);

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

  // Bay is no longer a pickable dimension — the whole rack's bays render
  // together, so only the rack (and layout) identify what's on screen.
  const seedKey = `${auditId}|${layout}|${rackCode}`;
  const seedKeyRef = useRef<string | null>(seedKey);
  useEffect(() => {
    if (seedKeyRef.current !== seedKey) {
      seedKeyRef.current = seedKey;
      setSelectedLoc(null);
      scale.value = 1;
      savedScale.value = 1;
      translateX.value = 0;
      translateY.value = 0;
      savedTranslateX.value = 0;
      savedTranslateY.value = 0;
    }
  }, [seedKey]);

  // The requested layout/rack (from route params or a stale picker
  // selection) may not exist in this audit's tree — rather than dead-ending
  // on an error, fall back to the first rack so Rack View for this task
  // always renders something the inspector can act on.
  const fallbackLayoutObj = tree ? (findLayoutIn(tree, layout) ?? tree.layouts[0]) : undefined;
  const fallbackRackObj = tree && fallbackLayoutObj ? (findRackIn(tree, fallbackLayoutObj.name, rackCode) ?? fallbackLayoutObj.racks[0]) : undefined;

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
  const bayDiagrams = rackObj.bays.map((b) => ({ bay: b, rows: buildBayDiagram(b) }));
  // Which bay a location actually belongs to — needed when saving, since
  // the repo looks the location up by its real bay code, not just its own.
  const bayCodeForLoc = (locCode: string) => rackObj.bays.find((b) => b.locations.some((l) => l.code === locCode))?.code ?? rackObj.bays[0].code;

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
  const isLocSelectable = (locCode: string) => manualMode || !audit.target_sku || matchesTargetSku(locCode);
  // Canvas highlight color: with a target_sku, only the matching pallets are
  // highlighted dark; without one, any pallet that has an assigned SKU is
  // (as before) — this is purely cosmetic and separate from selectability.
  const isLocHighlighted = (locCode: string) =>
    manualMode || (audit.target_sku ? matchesTargetSku(locCode) : (EXPECTED_SKUS[locCode]?.length ?? 0) > 0);
  const scannableLocations = rackLocations.filter((l) => isLocSelectable(l.code));

  const rackOptions: SheetOption[] = layoutObj.racks.map((r) => ({ value: r.code, label: `Rack ${r.code}` }));
  const palletOptions: SheetOption[] = scannableLocations.map((l) => ({
    value: l.code,
    label: palletIdFor(l),
  }));

  const handlePickRack = (code: string) => {
    setRackCode(code);
    setPickerField(null);
  };
  // Dropdown -> canvas: picking a pallet here also becomes the canvas'
  // selection (the cell gets the blue "selected" outline), same object of
  // truth (`selectedLoc`) as tapping the cell directly does.
  const handlePickPallet = (code: string) => {
    setSelectedLoc(code);
    setPickerField(null);
  };

  const handleSimulatedPalletScan = () => {
    if (!scannableLocations.length) return;
    const loc = scannableLocations[scanCycle % scannableLocations.length];
    setScanCycle((c) => c + 1);
    setSelectedLoc(loc.code);
  };

  const handleRealPalletScanned = (data: string) => {
    setScannerOpen(null);
    const code = data.trim();
    const match = scannableLocations.find((l) => l.code === code);
    if (match) setSelectedLoc(match.code);
  };

  // Drives the bay canvas cell colors: green once a pallet's scan resolves
  // to a clean match, amber when the right SKU was found but qty/condition
  // is off, red when the wrong SKU was scanned (misplaced), gray (the
  // default, just omitted from the map) for anything not yet scanned.
  // Called from every place the scan/edit state for the open pallet can
  // change, so the canvas behind the panel always reflects what's on
  // screen right now.
  const applyLocationStatus = (locCode: string, line: CountLine | null, expected: ExpectedSkuLine | null) => {
    setLocationStatus((prev) => {
      if (!line) {
        if (!(locCode in prev)) return prev;
        const next = { ...prev };
        delete next[locCode];
        return next;
      }
      const skuMatches = !!expected && line.sku === expected.sku;
      const status: 'matched' | 'issue' | 'mismatch' = !skuMatches ? 'mismatch' : line.qty === expected.qty && line.condition === 'Good' ? 'matched' : 'issue';
      return prev[locCode] === status ? prev : { ...prev, [locCode]: status };
    });
  };

  // "No Scanner Found" checkbox — the inspector is telling us the physical
  // code just isn't there, so there's nothing left to scan at this pallet.
  // Wipes any in-progress scan and marks the location 'missing' (dark gray,
  // dashed on canvas) instead of leaving it stuck gray/unresolved forever.
  const handleToggleNoScannerFound = (checked: boolean) => {
    setNoScannerFound(checked);
    if (!selectedLocObj) return;
    if (checked) {
      setScanLines([]);
      setExpandedIdx(null);
      setLocationStatus((prev) => ({ ...prev, [selectedLocObj.code]: 'missing' }));
    } else {
      applyLocationStatus(selectedLocObj.code, scanLines[0] ?? null, expectedSkus[0] ?? null);
    }
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
    if (manualMode) {
      // No scanning, no expected-vs-scanned check — just load whatever's
      // already on record for this pallet (if the inspector already
      // reported it) or the rack's real item here (for context) so the
      // form isn't blank, then let them go straight to qty/damage/evidence.
      const existing = loc.pallets.find((p) => p.saved) ?? null;
      const item = existing?.lines[0] ?? (EXPECTED_SKUS[loc.code] ?? [])[0];
      setManualLine(
        existing?.lines[0]
          ? { ...existing.lines[0] }
          : { sku: item?.sku ?? 'MANUAL-ISSUE', name: item?.name ?? 'Manual Issue Report', lot: item?.lot ?? '—', qty: item?.qty ?? 1, condition: 'Good' },
      );
      return;
    }
    const existing = loc.pallets.find((p) => p.saved) ?? null;
    // Single-SKU pallet: only the first line of any prior saved scan applies.
    const base = existing ? existing.lines.slice(0, 1).map((l) => ({ ...l })) : [];
    const expected = (EXPECTED_SKUS[loc.code] ?? []).slice(0, 1);
    setScanPallet(existing ? existing.pallet : null);
    setScanLines(base);
    // Always land on the compare view (Expected vs Scanned), never straight
    // into the edit subform — true for a fresh pallet and equally true when
    // re-selecting one already resolved this session, so re-tapping a saved
    // pallet always shows its saved details again instead of nothing.
    setExpandedIdx(null);
    setExpectedSkus(expected);
    setNoScannerFound(false);
    applyLocationStatus(loc.code, base[0] ?? null, expected[0] ?? null);
  };

  // Loads whichever pallet is currently selected into the panel — covers
  // opening the panel fresh (Start Audit), advancing (Scan Next), AND
  // simply re-tapping a different — including already-resolved — pallet on
  // the canvas while the panel is already open, so its saved details always
  // reload instead of the panel staying stuck showing the previous pallet.
  useEffect(() => {
    if (skuPanelOpen && selectedLocObj) {
      startAuditFor(selectedLocObj);
    }
  }, [selectedLoc, skuPanelOpen]);

  const handleStartAudit = () => {
    if (!selectedLocObj) return;
    setSkuPanelOpen(true);
  };

  // Persists the pallet just finished, then jumps straight to the next
  // location on this rack — selecting it (which highlights it on the
  // canvas behind the panel) reloads it via the effect above, so the
  // inspector never has to close the panel and tap the canvas by hand.
  // Progresses across all of the rack's bays in sequence, not just the one
  // the current location happens to be in.
  const handleScanNext = async () => {
    if (selectedLocObj && scanLines.length && !misplaced) {
      await saveRecord(tree, { auditId, layout, rack: rackCode, bay: bayCodeForLoc(selectedLocObj.code), loc: selectedLocObj.code }, scanLines);
    }
    const locs = scannableLocations;
    const idx = selectedLocObj ? locs.findIndex((l) => l.code === selectedLocObj.code) : -1;
    const next = idx !== -1 ? locs[idx + 1] : undefined;
    if (!next) {
      setSkuPanelOpen(false);
      return;
    }
    setSelectedLoc(next.code);
  };

  // One scan per pallet — a new scan replaces whatever was scanned before,
  // it doesn't accumulate into a list. The SKU identity check decides what
  // happens next: right SKU opens the qty/condition form, wrong SKU is
  // "Misplaced" with nothing further to fill in.
  const applySkuScan = (pick: { sku: string; name: string; lot: string }) => {
    const matchesExpected = !!expectedSkus[0] && expectedSkus[0].sku === pick.sku;
    // Scanning only ever confirms SKU identity — quantity and damage are
    // NOT known from the scan itself, so default them to "assume it's fine"
    // (expected qty, Good) rather than a fixed qty:1 that would read as a
    // false Quantity Mismatch the instant the scan resolves. The inspector
    // only sees a real qty/damage mismatch after they deliberately open
    // "Raise Issue" and correct these values to what they actually found.
    const line: CountLine = {
      sku: pick.sku,
      name: pick.name,
      lot: pick.lot,
      qty: matchesExpected ? expectedSkus[0].qty : 1,
      condition: 'Good',
    };
    setScanLines([line]);
    setNoScannerFound(false);
    // Land on the comparison view, not straight into the edit subform — the
    // inspector reads Expected vs Scanned first and only opens the subform
    // deliberately, via Raise Issue, if something actually looks off.
    setExpandedIdx(null);
    if (selectedLocObj) applyLocationStatus(selectedLocObj.code, line, expectedSkus[0] ?? null);
  };

  const handleSkuScanned = (data: string) => {
    const code = data.trim();
    const pick = INVENTORY_POOL.find((p) => p.sku === code) ?? { sku: code, name: 'Unlisted SKU', lot: '—' };
    applySkuScan(pick);
  };

  const handleSkuSimulated = () => {
    // Mostly scan the expected SKU (the common case), occasionally
    // simulate a misplaced item to demo that path too.
    const expected = expectedSkus[0];
    const useExpected = expected && skuScanCount % 3 !== 0;
    applySkuScan(useExpected ? expected : INVENTORY_POOL[skuScanCount % INVENTORY_POOL.length]);
    setSkuScanCount((c) => c + 1);
  };

  const ensureLineEvidence = (line: CountLine): Evidence => line.evidence ?? { note: '', noteOpen: false, audio: null, images: [], videos: [] };

  const handleRaiseIssue = (sku: string) => {
    setIssuesRaised((prev) => new Set(prev).add(sku));
    if (selectedLocObj) setFlaggedLocs((prev) => new Set(prev).add(selectedLocObj.code));
  };

  const updateLineEvidence = (idx: number, patch: Partial<Evidence>) => {
    const next = scanLines.slice();
    next[idx] = { ...next[idx], evidence: { ...ensureLineEvidence(next[idx]), ...patch } };
    setScanLines(next);
  };

  const updateManualEvidence = (patch: Partial<Evidence>) => {
    setManualLine((prev) => ({ ...prev, evidence: { ...ensureLineEvidence(prev), ...patch } }));
  };

  // Manual Mode's whole point is reporting a problem, so saving it always
  // raises the issue (red dot) too — there's no separate "looks fine, no
  // issue" outcome here the way a normal scan has. Advances to the next
  // pallet in the rack afterward, same progression as Scan Next.
  const handleSaveManualIssue = async () => {
    if (selectedLocObj) {
      await saveRecord(tree, { auditId, layout, rack: rackCode, bay: bayCodeForLoc(selectedLocObj.code), loc: selectedLocObj.code }, [manualLine]);
      handleRaiseIssue(manualLine.sku);
    }
    const locs = scannableLocations;
    const idx = selectedLocObj ? locs.findIndex((l) => l.code === selectedLocObj.code) : -1;
    const next = idx !== -1 ? locs[idx + 1] : undefined;
    if (!next) {
      setSkuPanelOpen(false);
      return;
    }
    setSelectedLoc(next.code);
  };

  const handleSaveSkuPanel = async () => {
    if (selectedLocObj && scanLines.length) {
      await saveRecord(tree, { auditId, layout, rack: rackCode, bay: bayCodeForLoc(selectedLocObj.code), loc: selectedLocObj.code }, scanLines);
    }
    setSkuPanelOpen(false);
  };

  return (
    <View style={{ flex: 1, backgroundColor: tokens.muted }}>
      <AppHeader title={audit.audit_name} sub={audit.audit_id} showBack menuItems={[{ label: 'Sync Now', onPress: () => {} }]} backgroundColor="#F7F8FA" />

      <View style={[styles.toolbar, { backgroundColor: tokens.card, borderBottomColor: tokens.border }]}>
        <ToolbarField label={layoutObj.name} fixed />
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
            label={selectedLocObj ? palletIdFor(selectedLocObj) : 'Select Pallet'}
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
        <Pressable
          onPress={() => {
            const next = !manualMode;
            setManualMode(next);
            setSelectedLoc(null);
            setSkuPanelOpen(false);
          }}
          style={[
            styles.manualModeToggle,
            { backgroundColor: manualMode ? tokens.rag.amber.strong : tokens.muted, borderColor: manualMode ? tokens.rag.amber.strong : tokens.border, borderRadius: tokens.radius.lg },
          ]}
        >
          <Ionicons name={manualMode ? 'construct' : 'construct-outline'} size={14} color={manualMode ? '#fff' : tokens.foreground} />
          <Text style={{ color: manualMode ? '#fff' : tokens.foreground, fontWeight: tokens.fontWeight.semibold, fontSize: tokens.text.xs }}>Manual Mode</Text>
        </Pressable>
        <Pressable onPress={() => setScannerOpen('pallet')} style={[styles.scanIconBtn, { backgroundColor: tokens.muted, borderRadius: tokens.radius.lg }]}>
          <Ionicons name="qr-code-outline" size={18} color={tokens.foreground} />
        </Pressable>
      </View>

      {manualMode ? (
        <View style={[styles.manualModeBanner, { backgroundColor: tokens.rag.amber.soft, borderBottomColor: tokens.rag.amber.border }]}>
          <Ionicons name="warning-outline" size={14} color={tokens.rag.amber.strong} />
          <Text style={{ color: tokens.rag.amber.strong, fontWeight: tokens.fontWeight.semibold, fontSize: tokens.text.xs, flex: 1 }}>
            Manual Mode — every pallet in this rack is selectable, outside this audit's assigned scope too. No scanning: pick a location and report what you found.
          </Text>
        </View>
      ) : null}

      <View style={styles.body}>
        {/* Canvas and the Reconciliation Form sit side by side, both full
            height, once a pallet's audit is started — not a small overlay —
            so the canvas highlight and the form stay visible together. */}
        <View style={skuPanelOpen ? styles.splitRow : styles.singleRow}>
        <Card style={{ padding: 0, overflow: 'hidden', flex: 1 }}>
          <View style={[styles.diagramHeadRow, { backgroundColor: '#F7F8FA', borderBottomColor: tokens.border }]}>
            <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm }}>
              Front View — {rackObj.bays.length} Bay{rackObj.bays.length === 1 ? '' : 's'}
            </Text>
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
                                  {row.cells.map((cell, i) => {
                                    if (!cell) return <View key={i} style={[styles.cell, styles.cellEmpty, { borderColor: tokens.border }]} />;
                                    // Canvas <-> dropdown selection is the
                                    // same `selectedLoc` value both ways, so
                                    // tapping a cell here updates the
                                    // toolbar's Pallet field automatically.
                                    const selected = cell.code === selectedLoc;
                                    const status = locationStatus[cell.code];
                                    const highlighted = isLocHighlighted(cell.code);
                                    const selectable = isLocSelectable(cell.code);
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
                                                : tokens.border;
                                    return (
                                      <RackCell
                                        key={cell.code}
                                        bg={bg}
                                        border={border}
                                        selected={selected}
                                        selectable={selectable}
                                        dashed={status === 'missing'}
                                        blinking={selected}
                                        dimmed={dimmed}
                                        flagged={flaggedLocs.has(cell.code)}
                                        onPress={() => setSelectedLoc(cell.code)}
                                      />
                                    );
                                  })}
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
            {/* Header carries only the form name — the location/pallet
                identity is its own precise detail block right below the
                divider, and scanning happens from the dotted scan target
                further down, not a header icon. */}
            <View style={styles.skuPanelHead}>
              <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.extrabold, fontSize: tokens.text.base }}>
                {manualMode ? 'Manual Issue Report' : 'Reconciliation Form'}
              </Text>
            </View>
            <View style={[styles.divider, { backgroundColor: tokens.border }]} />

            <Text style={{ color: tokens.mutedForeground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.xxs, textTransform: 'uppercase', marginBottom: 8 }}>
              Selected Location Details
            </Text>
            <View style={styles.locDetailsBox}>
              <DetailRow label="Location Code" value={selectedLocObj?.code ?? '—'} tokens={tokens} />
              <DetailRow label="Rack" value={rackObj.code} tokens={tokens} />
              <DetailRow label="Bay" value={selectedLocObj ? bayCodeForLoc(selectedLocObj.code) : '—'} tokens={tokens} />
              <DetailRow label="Pallet" value={selectedLocObj ? palletIdFor(selectedLocObj) : '—'} tokens={tokens} />
            </View>

            {manualMode ? (
              // No scanning, no expected-vs-scanned comparison — the
              // inspector already knows what they found and where, so this
              // goes straight to reporting it: qty, damage, and evidence.
              <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 10 }}>
                <SkuLineCard
                  line={manualLine}
                  active
                  conditionLabel="Damage"
                  conditionOptions={CONDITIONS.filter((c) => c !== 'Damaged')}
                  saveLabel="Raise Issue"
                  hideDelete
                  onQtyChange={(qty) => setManualLine((prev) => ({ ...prev, qty }))}
                  onConditionChange={(condition) => setManualLine((prev) => ({ ...prev, condition }))}
                  onSave={handleSaveManualIssue}
                  onDelete={() => {}}
                  onEdit={() => {}}
                  evidenceSlot={
                    <EvidenceBlock
                      evidence={ensureLineEvidence(manualLine)}
                      onOpenNote={() => updateManualEvidence({ noteOpen: true })}
                      onChangeNote={(note) => updateManualEvidence({ note })}
                      onRecordAudio={() => updateManualEvidence({ audio: { durationSec: 20, playing: false, bars: generateWaveformBars() } })}
                      onToggleAudioPlay={() => {
                        const ev = ensureLineEvidence(manualLine);
                        if (!ev.audio) return;
                        updateManualEvidence({ audio: { ...ev.audio, playing: !ev.audio.playing } });
                      }}
                      onRemoveAudio={() => updateManualEvidence({ audio: null })}
                      onAddImage={() => setAttachmentTarget(-1)}
                      onRemoveImage={(i) => updateManualEvidence({ images: ensureLineEvidence(manualLine).images.filter((_, ii) => ii !== i) })}
                      onAddVideo={() => updateManualEvidence({ videos: [...ensureLineEvidence(manualLine).videos, { durationSec: 20 }] })}
                      onRemoveVideo={(i) => updateManualEvidence({ videos: ensureLineEvidence(manualLine).videos.filter((_, ii) => ii !== i) })}
                    />
                  }
                />
              </ScrollView>
            ) : expandedIdx !== null && scannedLine && skuMatched && expectedSku ? (
              // The SKU form only appears once the identity check passes —
              // a misplaced scan (wrong SKU for this pallet) has nothing to
              // fill in, it's handled by the view below instead. Status here
              // is only ever Quantity/Condition mismatch or a clean Matched,
              // since "wrong SKU" can't happen in this branch.
              <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 10 }}>
                {(() => {
                  // Primary status is SKU identity only — this branch only
                  // ever renders once the SKU has already matched, so it's
                  // always "Matched" here. Quantity/condition are secondary,
                  // smaller pills layered next to it, not a replacement for it.
                  const line = scannedLine;
                  const qtyMismatch = line.qty !== expectedSku.qty;
                  const conditionFlagged = line.condition !== 'Good';
                  const raised = issuesRaised.has(line.sku);
                  return (
                    <>
                      <View style={styles.statusPillRow}>
                        <View style={[styles.editStatusPill, { backgroundColor: tokens.rag.green.soft, borderColor: tokens.rag.green.border, borderRadius: tokens.radius.lg }]}>
                          <Text style={{ color: tokens.rag.green.strong, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.xs }}>Matched</Text>
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
                      {qtyMismatch || conditionFlagged ? (
                        <Pressable
                          disabled={raised}
                          onPress={() => handleRaiseIssue(line.sku)}
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
                            {raised
                              ? 'Issue raised for this SKU'
                              : qtyMismatch
                                ? `Raise Issue — expected ${expectedSku.qty}, found ${line.qty}`
                                : `Raise Issue — damage: ${line.condition}`}
                          </Text>
                          {!raised ? <Text style={{ color: tokens.rag.red.strong, fontWeight: tokens.fontWeight.semibold, fontSize: tokens.text.xs }}>Tap to raise</Text> : null}
                        </Pressable>
                      ) : null}
                    </>
                  );
                })()}
                <SkuLineCard
                  line={scanLines[expandedIdx]}
                  active
                  conditionLabel="Damage"
                  conditionOptions={CONDITIONS.filter((c) => c !== 'Damaged')}
                  onQtyChange={(qty) => {
                    const next = scanLines.slice();
                    next[expandedIdx] = { ...next[expandedIdx], qty };
                    setScanLines(next);
                    if (selectedLocObj) applyLocationStatus(selectedLocObj.code, next[expandedIdx], expectedSku);
                  }}
                  onConditionChange={(condition) => {
                    const next = scanLines.slice();
                    next[expandedIdx] = { ...next[expandedIdx], condition };
                    setScanLines(next);
                    if (selectedLocObj) applyLocationStatus(selectedLocObj.code, next[expandedIdx], expectedSku);
                  }}
                  onSave={() => setExpandedIdx(null)}
                  onDelete={() =>
                    confirm.ask(`Remove ${scanLines[expandedIdx].sku} from this record?`, () => {
                      setScanLines(scanLines.filter((_, i) => i !== expandedIdx));
                      setExpandedIdx(null);
                      if (selectedLocObj) applyLocationStatus(selectedLocObj.code, null, expectedSku);
                    })
                  }
                  onEdit={() => {}}
                  evidenceSlot={
                    <EvidenceBlock
                      evidence={ensureLineEvidence(scanLines[expandedIdx])}
                      onOpenNote={() => updateLineEvidence(expandedIdx, { noteOpen: true })}
                      onChangeNote={(note) => updateLineEvidence(expandedIdx, { note })}
                      onRecordAudio={() => updateLineEvidence(expandedIdx, { audio: { durationSec: 20, playing: false, bars: generateWaveformBars() } })}
                      onToggleAudioPlay={() => {
                        const ev = ensureLineEvidence(scanLines[expandedIdx]);
                        if (!ev.audio) return;
                        updateLineEvidence(expandedIdx, { audio: { ...ev.audio, playing: !ev.audio.playing } });
                      }}
                      onRemoveAudio={() => updateLineEvidence(expandedIdx, { audio: null })}
                      onAddImage={() => setAttachmentTarget(expandedIdx)}
                      onRemoveImage={(i) =>
                        updateLineEvidence(expandedIdx, { images: ensureLineEvidence(scanLines[expandedIdx]).images.filter((_, ii) => ii !== i) })
                      }
                      onAddVideo={() =>
                        updateLineEvidence(expandedIdx, { videos: [...ensureLineEvidence(scanLines[expandedIdx]).videos, { durationSec: 20 }] })
                      }
                      onRemoveVideo={(i) =>
                        updateLineEvidence(expandedIdx, { videos: ensureLineEvidence(scanLines[expandedIdx]).videos.filter((_, ii) => ii !== i) })
                      }
                    />
                  }
                />
              </ScrollView>
            ) : (
              <ScrollView style={{ flex: 1 }} contentContainerStyle={{ flexGrow: 1, gap: 10, paddingBottom: 10 }}>
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
                      Scans the SKU code on the pallet at this location, then checks it against what's expected here.
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
                    const qtyMismatch = !misplaced && scannedLine.qty !== expectedSku?.qty;
                    const conditionFlagged = !misplaced && scannedLine.condition !== 'Good';
                    const hasIssue = misplaced || qtyMismatch || conditionFlagged;
                    const raised = issuesRaised.has(scannedLine.sku);
                    return (
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
                                  Qty {scannedLine.qty} · {scannedLine.condition}
                                </Text>
                              </>
                            ) : (
                              <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xs, marginTop: 4 }}>Not scanned yet</Text>
                            )}
                          </View>
                        </View>
                        {misplaced ? (
                          // Wrong SKU is known the instant the scan resolves
                          // — nothing to enter, so this raises the issue
                          // directly rather than opening the qty/damage form.
                          <Pressable
                            disabled={raised}
                            onPress={() => handleRaiseIssue(scannedLine.sku)}
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
                          // SKU matched — quantity/damage are still unknown
                          // right now (the scan didn't capture them), so
                          // there's nothing to auto-flag. The inspector
                          // decides for themselves after eyeballing Expected
                          // vs Scanned, and only enters the real qty/damage
                          // (and raises an issue if it's actually off) inside
                          // this subform, opened deliberately.
                          <Pressable
                            onPress={() => setExpandedIdx(0)}
                            style={[
                              styles.raiseIssueBox,
                              {
                                backgroundColor: hasIssue ? tokens.rag.red.soft : tokens.card,
                                borderColor: hasIssue ? tokens.rag.red.border : tokens.border,
                                borderRadius: tokens.radius.lg,
                              },
                            ]}
                          >
                            <Ionicons name={hasIssue ? 'flag' : 'create-outline'} size={18} color={hasIssue ? tokens.rag.red.strong : tokens.mutedForeground} />
                            <Text
                              style={{
                                color: hasIssue ? tokens.rag.red.strong : tokens.foreground,
                                fontWeight: tokens.fontWeight.bold,
                                fontSize: tokens.text.sm,
                                flex: 1,
                              }}
                            >
                              {hasIssue ? 'Quantity/Damage issue found — tap to review' : 'Enter actual quantity & damage found'}
                            </Text>
                          </Pressable>
                        )}
                      </>
                    );
                  })()
                ) : null}
              </ScrollView>
            )}
            {manualMode ? (
              // Raise Issue (inside SkuLineCard above) already saves and
              // advances — the outer footer only needs a plain way out.
              <View style={[styles.skuPanelFooter, { borderTopColor: tokens.border }]}>
                <Pressable onPress={() => setSkuPanelOpen(false)} style={[styles.outlineBtn, { flex: 1, backgroundColor: tokens.muted, borderColor: tokens.border, borderRadius: tokens.radius.lg }]}>
                  <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.semibold, fontSize: tokens.text.sm }}>Cancel</Text>
                </Pressable>
              </View>
            ) : expandedIdx !== null ? (
              // Editing a matched line's qty/condition — Back returns to the
              // main view without advancing, Save commits just that edit.
              <View style={[styles.skuPanelFooter, { borderTopColor: tokens.border }]}>
                <Pressable onPress={() => setExpandedIdx(null)} style={[styles.outlineBtn, { flex: 1, borderColor: tokens.border, borderRadius: tokens.radius.lg }]}>
                  <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.semibold, fontSize: tokens.text.sm }}>Back</Text>
                </Pressable>
                <Pressable onPress={handleSaveSkuPanel} style={[styles.primaryBtn, { flex: 1, backgroundColor: tokens.primary, borderRadius: tokens.radius.lg }]}>
                  <Text style={{ color: tokens.primaryForeground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm }}>Save</Text>
                </Pressable>
              </View>
            ) : (
              <View style={[styles.skuPanelFooter, { borderTopColor: tokens.border }]}>
                <Pressable onPress={() => setSkuPanelOpen(false)} style={[styles.outlineBtn, { flex: 1, backgroundColor: tokens.muted, borderColor: tokens.border, borderRadius: tokens.radius.lg }]}>
                  <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.semibold, fontSize: tokens.text.sm }}>Cancel</Text>
                </Pressable>
                <Pressable
                  onPress={() => handleToggleNoScannerFound(true)}
                  style={[styles.outlineBtn, { flex: 1, backgroundColor: tokens.muted, borderColor: tokens.border, borderRadius: tokens.radius.lg }]}
                >
                  <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.semibold, fontSize: tokens.text.sm }}>Empty</Text>
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
        visible={scannerOpen === 'pallet'}
        title="Scan Pallet LPN"
        hint="Point at the Pallet LPN QR code"
        onScanned={handleRealPalletScanned}
        onUseSimulated={() => {
          setScannerOpen(null);
          handleSimulatedPalletScan();
        }}
        onClose={() => setScannerOpen(null)}
      />
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
          if (attachmentTarget === -1) {
            updateManualEvidence({ images: [...ensureLineEvidence(manualLine).images, image] });
            return;
          }
          const idx = attachmentTarget;
          updateLineEvidence(idx, { images: [...ensureLineEvidence(scanLines[idx]).images, image] });
        }}
      />
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
          },
          animatedStyle,
        ]}
      />
      {flagged ? <View style={styles.flagDot} /> : null}
    </Pressable>
  );
}

function DetailRow({ label, value, tokens }: { label: string; value: string; tokens: ReturnType<typeof useTheme>['tokens'] }) {
  return (
    <View style={styles.detailRow}>
      <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xs }}>{label}</Text>
      <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.semibold, fontSize: tokens.text.sm }}>{value}</Text>
    </View>
  );
}

function ToolbarField({ label, fixed, tag, open, onPress }: { label: string; fixed?: boolean; tag?: string; open?: boolean; onPress?: () => void }) {
  const { tokens } = useTheme();
  const content = (
    <View
      style={[
        styles.toolbarField,
        !fixed ? styles.toolbarFieldDropdown : null,
        { backgroundColor: fixed ? tokens.muted : tokens.card, borderColor: open ? tokens.primary : tokens.border, borderRadius: tokens.radius.lg },
      ]}
    >
      <Text style={{ color: tokens.foreground, fontSize: tokens.text.xs }} numberOfLines={1}>
        {label}
      </Text>
      {tag ? <Pill label={tag} tone={STATUS_TONE[tag as keyof typeof STATUS_TONE] ?? 'To Do'} /> : null}
      {!fixed ? <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={14} color="#667085" /> : null}
    </View>
  );
  return fixed ? content : <Pressable onPress={onPress}>{content}</Pressable>;
}

// Anchored right under the field that opened it — a web-style dropdown
// instead of BottomSheetPicker's slide-up-from-the-bottom sheet. Only used
// here (Rack View is tablet-only); phone's Count Sheet keeps the bottom
// sheet, per no-shared-device-behavior-changes.
function InlineDropdown({ options, selectedValue, onSelect }: { options: SheetOption[]; selectedValue: string; onSelect: (value: string) => void }) {
  const { tokens } = useTheme();
  return (
    <View style={[styles.inlineDropdown, { backgroundColor: tokens.popover, borderColor: tokens.border, borderRadius: tokens.radius.lg }]}>
      <ScrollView style={{ maxHeight: 260 }}>
        {options.map((o) => {
          const selected = o.value === selectedValue;
          return (
            <Pressable
              key={o.value}
              onPress={() => onSelect(o.value)}
              style={[styles.inlineDropdownItem, { borderBottomColor: tokens.border }, selected ? { backgroundColor: tokens.muted } : null]}
            >
              <Text style={{ color: tokens.popoverForeground, fontSize: tokens.text.sm }} numberOfLines={1}>
                {o.label}
              </Text>
              {selected ? <Ionicons name="checkmark" size={16} color={tokens.primary} /> : null}
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  toolbar: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  toolbarField: { flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: 1, paddingHorizontal: 10, height: 36, minWidth: 70 },
  toolbarFieldDropdown: { width: 118, justifyContent: 'space-between' },
  scanIconBtn: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  manualModeToggle: { flexDirection: 'row', alignItems: 'center', gap: 6, height: 36, paddingHorizontal: 12, borderWidth: 1 },
  manualModeBanner: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, paddingVertical: 8, borderBottomWidth: 1 },
  inlineDropdown: { position: 'absolute', top: 40, left: 0, width: 160, borderWidth: 1, zIndex: 30, elevation: 30 },
  inlineDropdownItem: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, paddingHorizontal: 12, paddingVertical: 11, borderBottomWidth: StyleSheet.hairlineWidth },
  body: { flex: 1, padding: 16 },
  singleRow: { flex: 1 },
  splitRow: { flex: 1, flexDirection: 'row', gap: 16 },
  diagramHeadRow: { paddingHorizontal: 14, paddingVertical: 12, borderBottomWidth: 1 },
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
  cellEmpty: { borderStyle: 'dashed', opacity: 0.4 },
  outlineBtn: { flex: 1, height: 44, alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
  primaryBtn: { flex: 1, flexDirection: 'row', height: 44, alignItems: 'center', justifyContent: 'center', gap: 6 },
  footerRow: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 16 },
  footerBtn: { flex: 0, paddingHorizontal: 18 },
  skuPanel: { flex: 1 },
  skuPanelHead: { marginBottom: 12 },
  divider: { height: StyleSheet.hairlineWidth, marginBottom: 14 },
  locDetailsBox: { gap: 8, marginBottom: 16 },
  detailRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  scanDottedBox: { flex: 1, minHeight: 160, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderStyle: 'dashed', paddingVertical: 32, marginBottom: 10 },
  scanDottedIconWrap: { width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center' },
  compareRow: { flexDirection: 'row', gap: 10 },
  compareCol: { flex: 1, borderWidth: 1, padding: 12 },
  noScannerRow: { flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, padding: 12 },
  raiseIssueBox: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, padding: 12, marginTop: 4 },
  statusPillRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 8 },
  editStatusPill: { alignSelf: 'flex-start', borderWidth: 1, paddingHorizontal: 10, paddingVertical: 5 },
  skuPanelFooter: { flexDirection: 'row', gap: 10, marginTop: 12, paddingTop: 12, borderTopWidth: StyleSheet.hairlineWidth },
});
