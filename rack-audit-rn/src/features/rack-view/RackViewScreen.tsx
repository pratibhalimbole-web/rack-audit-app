import { Ionicons } from '@expo/vector-icons';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Image, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
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
import { useLocationsTree } from '@/hooks/useLocationsTree';
import { findLayoutIn, findRackIn } from '@/lib/locationsRepo';
import { EXPECTED_SKUS, generateWaveformBars, INVENTORY_POOL } from '@/lib/mockData';
import type { Condition, Evidence, EvidenceImage, LocationNode } from '@/lib/types';
import { useTheme } from '@/theme/ThemeProvider';
import { useAudits } from '../dashboard/hooks';
import { useCountSheetMutations } from '../count-sheet/mutations';
import { buildBayDiagram } from './buildBayDiagram';

type Params = { auditId: string; layout: string; rackId: string; bay: string; loc?: string };

const STATUS_TONE = { 'Not Started': 'To Do', 'In Progress': 'In Progress', Completed: 'Completed' } as const;

// A single scanned SKU during a Start Audit session. Unlike variation-2's
// original one-pallet-at-a-time flow, an inspector now scans freely across
// the whole physical rack — each scan is looked up by SKU against
// EXPECTED_SKUS to resolve which (if any) not-yet-scanned location it
// belongs to, since there's no pre-selected pallet to key off.
type SessionScan = {
  id: string;
  locCode: string | null;
  locLabel: string | null;
  sku: string;
  name: string;
  lot: string;
  qty: number;
  condition: Condition;
  status: 'matched' | 'mismatch' | 'missing';
  issueRaised: boolean;
  evidence?: Evidence;
};

// Pallet ID shown to the inspector — level + pallet number on that level,
// e.g. level 5 / pallet 1 -> "P-0501" — distinct from the location's
// internal `code` (rack/bay-scoped) used for lookups and saving records.
function palletIdFor(loc: { level?: number; slot?: number; code: string }): string {
  return loc.level != null && loc.slot != null ? `P-${String(loc.level).padStart(2, '0')}${String(loc.slot).padStart(2, '0')}` : loc.code;
}

// Ports renderRackView() + buildBayDiagram (rack-audit-app.html ~2820-3223)
// — the tablet-only schematic elevation of a bay (levels stacked bottom-up).
// Start Audit opens a live scanning session split side-by-side with the
// canvas: the inspector scans whatever pallet they physically reach, in any
// order, and the canvas reflects matched/mismatch/missing status live as
// scans land — no pre-selecting a single pallet first.
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
  const [scannerOpen, setScannerOpen] = useState<'pallet' | null>(null);
  // Dev/demo aid, not an inspector-facing feature: a printable sheet of every
  // one of Rack A-21's 38 target-SKU pallet codes, viewable in-app as an
  // overlay so it can be held up to a second device's camera to exercise the
  // Live Scan session without a physically printed page.
  const [testSheetOpen, setTestSheetOpen] = useState(false);

  // The live scan session opened by "Start Audit" — no pallet needs to be
  // pre-selected, it covers the whole rack (or, with a target_sku, whatever
  // subset of it is in scope). Split side-by-side with the canvas rather
  // than a small overlay, so both stay big and readable at once.
  const [sessionOpen, setSessionOpen] = useState(false);
  // Whether the camera itself is actively scanning right now. "Done" only
  // stops the camera — it doesn't close the split panel — so the inspector
  // lands on a review state showing canvas + the scanned list together
  // (camera area replaced by a "Resume Scanning" prompt) before deciding to
  // Save Audit. Kept separate from `sessionOpen` so canvas/list stay mounted
  // and visible the whole time regardless of camera state.
  const [cameraActive, setCameraActive] = useState(true);
  // Whether Start Audit has ever been tapped this visit — drives the
  // canvas's dashed "missing" state, which should stay visible on the
  // canvas even after the session panel is fully closed (so progress is
  // still readable at a glance), not just while a session is active.
  const [auditStarted, setAuditStarted] = useState(false);
  const [sessionScans, setSessionScans] = useState<SessionScan[]>([]);
  // Two physical codes scanned in quick succession (fast panning across the
  // rack) can both reach nextUnclaimedLocation before React has re-rendered
  // with the first one's result — component state is a snapshot from the
  // last completed render, so both calls would see the same "next
  // unclaimed" location and double-claim it (this was the 38-codes-become-
  // 39-scans bug). A ref updates synchronously and is read fresh on every
  // call, so it's the sole source of truth for resolution — the canvas and
  // the "N matched" counter both derive from `sessionScans` instead, which
  // already triggers a re-render on every scan, so no separate state copy
  // of this set is needed.
  const scannedLocsRef = useRef<Set<string>>(new Set());
  const [expandedScanId, setExpandedScanId] = useState<string | null>(null);
  // Which scan's Raise Issue accordion is currently adding a photo — routes
  // NewAttachmentModal's saved annotation back to the right scan's evidence.
  const [attachmentTarget, setAttachmentTarget] = useState<string | null>(null);
  const [simCount, setSimCount] = useState(0);
  const scanIdRef = useRef(0);

  // Which pallet is blinking on the canvas right now — set for a few
  // seconds whenever the inspector raises an issue, so it's obvious at a
  // glance which physical pallet that issue belongs to.
  const [blinkLoc, setBlinkLoc] = useState<string | null>(null);
  const blinkTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (blinkTimeoutRef.current) clearTimeout(blinkTimeoutRef.current);
  }, []);

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
      setSessionOpen(false);
      setCameraActive(true);
      setAuditStarted(false);
      setSessionScans([]);
      scannedLocsRef.current = new Set();
      setExpandedScanId(null);
      setAttachmentTarget(null);
      setBlinkLoc(null);
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
  // used for selection lookup, the Pallet picker, and scan resolution,
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
  // picker, and ignored by the scan session. Without a target_sku every
  // pallet in the rack stays selectable, same as before.
  const matchesTargetSku = (locCode: string) => !!audit.target_sku && (EXPECTED_SKUS[locCode] ?? []).some((l) => l.sku === audit.target_sku);
  const isLocSelectable = (locCode: string) => !audit.target_sku || matchesTargetSku(locCode);
  // Canvas highlight color: with a target_sku, only the matching pallets are
  // highlighted dark; without one, any pallet that has an assigned SKU is
  // (as before) — this is purely cosmetic and separate from selectability.
  const isLocHighlighted = (locCode: string) => (audit.target_sku ? matchesTargetSku(locCode) : (EXPECTED_SKUS[locCode]?.length ?? 0) > 0);
  const scannableLocations = rackLocations.filter((l) => isLocSelectable(l.code));
  const totalTargets = scannableLocations.filter((l) => (EXPECTED_SKUS[l.code]?.length ?? 0) > 0).length;

  const rackOptions: SheetOption[] = layoutObj.racks.map((r) => ({ value: r.code, label: `Rack ${r.code}` }));
  const palletOptions: SheetOption[] = scannableLocations.map((l) => ({
    value: l.code,
    label: palletIdFor(l),
  }));

  const handlePickRack = (code: string) => {
    setRackCode(code);
    setPickerField(null);
  };
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

  const handleStartAudit = () => {
    setSessionOpen(true);
    setCameraActive(true);
    setAuditStarted(true);
  };
  // "Done" (in the scan panel's camera area) only stops the camera — the
  // split panel stays open, landing the inspector on canvas + the scanned
  // list together so they can review what was found before deciding to
  // save. Scanning can be resumed from that review state at any time.
  // Stopping the camera is also the moment "still not scanned" becomes
  // "confirmed missing" — anything expected in scope that never resolved
  // gets its own list entry (no code exists for it, so it can never be
  // scanned) rather than just fading into the background. Each one is
  // still selectable/highlightable on the canvas and can have evidence
  // (photo of the empty slot, a note, etc.) attached, same as a raised
  // issue. Locations already added this way are excluded from future
  // scan resolution too — the scan is genuinely over for them.
  const handleStopCamera = () => {
    setCameraActive(false);
    setExpandedScanId(null);
    const missingLocs = scannableLocations.filter((l) => !scannedLocsRef.current.has(l.code) && (EXPECTED_SKUS[l.code]?.length ?? 0) > 0);
    if (missingLocs.length) {
      const missingEntries: SessionScan[] = missingLocs.map((loc) => {
        scannedLocsRef.current.add(loc.code);
        return {
          id: String(scanIdRef.current++),
          locCode: loc.code,
          locLabel: `Bay ${bayCodeForLoc(loc.code)} · ${palletIdFor(loc)}`,
          sku: EXPECTED_SKUS[loc.code]?.[0]?.sku ?? '—',
          name: 'No scanner code found at this pallet',
          lot: '—',
          qty: 0,
          condition: 'Good',
          status: 'missing',
          issueRaised: false,
        };
      });
      setSessionScans((prev) => [...missingEntries, ...prev]);
    }
  };
  const handleResumeCamera = () => setCameraActive(true);
  // Every match/mismatch scan already auto-saves the moment it resolves
  // (and Raise Issue saves its own correction), so there's no batch of
  // unsaved data waiting here — Save Audit is the inspector's explicit
  // "I'm done with this rack" action, closing the whole session back to
  // the plain canvas.
  const handleSaveAudit = () => {
    setSessionOpen(false);
    setCameraActive(true);
    setExpandedScanId(null);
  };

  // Every scan claims a real physical location, whether it matches or not —
  // the inspector is standing at some specific pallet when they scan it, so
  // even a wrong item found there still belongs to that pallet. Claims the
  // next not-yet-visited in-scope location in canvas order (rather than
  // trying to guess a location purely from the scanned SKU, which can't
  // work for a mismatch — nothing expects that SKU anywhere by definition).
  const nextUnclaimedLocation = (): LocationNode | null => scannableLocations.find((l) => !scannedLocsRef.current.has(l.code)) ?? null;

  const handleSessionScan = async (code: string) => {
    const sku = code.trim();
    if (!sku) return;
    const target = nextUnclaimedLocation();
    // Claim the location synchronously, before any await, so a second scan
    // arriving a few milliseconds later (same tick, before React re-renders)
    // sees it as already taken instead of racing to the same "next
    // unclaimed" result.
    if (target) scannedLocsRef.current.add(target.code);
    const expectedLine = target ? (EXPECTED_SKUS[target.code] ?? []).find((l) => l.sku === sku) : undefined;
    const known = INVENTORY_POOL.find((p) => p.sku === sku);
    const entry: SessionScan = {
      id: String(scanIdRef.current++),
      locCode: target?.code ?? null,
      locLabel: target ? `Bay ${bayCodeForLoc(target.code)} · ${palletIdFor(target)}` : null,
      sku,
      name: expectedLine?.name ?? known?.name ?? 'Unlisted SKU',
      lot: expectedLine?.lot ?? known?.lot ?? '—',
      qty: expectedLine?.qty ?? 1,
      condition: 'Good',
      status: expectedLine ? 'matched' : 'mismatch',
      issueRaised: false,
    };
    setSessionScans((prev) => [entry, ...prev]);
    if (target) {
      await saveRecord(tree, { auditId, layout, rack: rackCode, bay: bayCodeForLoc(target.code), loc: target.code }, [
        { sku: entry.sku, name: entry.name, lot: entry.lot, qty: entry.qty, condition: entry.condition },
      ]);
    }
  };

  const handleSessionSimulate = () => {
    // Mostly resolve an actual in-scope, not-yet-scanned expected SKU (the
    // common "found it" case); occasionally simulate an unrelated SKU to
    // demo the mismatch path too.
    const next = nextUnclaimedLocation();
    const nextExpected = next ? EXPECTED_SKUS[next.code]?.[0] : undefined;
    const useMatch = !!nextExpected && simCount % 3 !== 0;
    const sku = useMatch && nextExpected ? nextExpected.sku : INVENTORY_POOL[simCount % INVENTORY_POOL.length].sku;
    setSimCount((c) => c + 1);
    handleSessionScan(sku);
  };

  const updateScan = (id: string, patch: Partial<SessionScan>) => setSessionScans((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));

  const ensureScanEvidence = (scan: SessionScan): Evidence => scan.evidence ?? { note: '', noteOpen: false, audio: null, images: [], videos: [] };
  const updateScanEvidence = (id: string, patch: Partial<Evidence>) =>
    setSessionScans((prev) => prev.map((s) => (s.id === id ? { ...s, evidence: { ...ensureScanEvidence(s), ...patch } } : s)));
  const handleAddEvidenceImage = (image: EvidenceImage) => {
    if (!attachmentTarget) return;
    const id = attachmentTarget;
    setSessionScans((prev) => prev.map((s) => (s.id === id ? { ...s, evidence: { ...ensureScanEvidence(s), images: [...ensureScanEvidence(s).images, image] } } : s)));
    setAttachmentTarget(null);
  };

  // Raising an issue on an already-matched scan opens its accordion (Qty +
  // Condition, reusing Count Sheet's SkuLineCard); saving it persists the
  // correction and blinks the pallet on the canvas for a few seconds so
  // it's obvious which physical pallet the issue belongs to.
  const handleSaveIssue = async (id: string) => {
    const scan = sessionScans.find((s) => s.id === id);
    setExpandedScanId(null);
    if (!scan) return;
    updateScan(id, { issueRaised: true });
    if (scan.locCode) {
      await saveRecord(tree, { auditId, layout, rack: rackCode, bay: bayCodeForLoc(scan.locCode), loc: scan.locCode }, [
        { sku: scan.sku, name: scan.name, lot: scan.lot, qty: scan.qty, condition: scan.condition, evidence: scan.evidence },
      ]);
      if (blinkTimeoutRef.current) clearTimeout(blinkTimeoutRef.current);
      setBlinkLoc(scan.locCode);
      blinkTimeoutRef.current = setTimeout(() => setBlinkLoc(null), 2400);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: tokens.muted }}>
      <AppHeader
        title={audit.audit_name}
        sub={audit.audit_id}
        showBack
        menuItems={[
          { label: 'Sync Now', onPress: () => {} },
          ...(rackCode === 'A-21' && audit.target_sku ? [{ label: 'Test Scan Sheet (Rack A-21)', onPress: () => setTestSheetOpen(true) }] : []),
        ]}
        backgroundColor="#F7F8FA"
      />

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
        <Pressable onPress={() => setScannerOpen('pallet')} style={[styles.scanIconBtn, { backgroundColor: tokens.muted, borderRadius: tokens.radius.lg }]}>
          <Ionicons name="qr-code-outline" size={18} color={tokens.foreground} />
        </Pressable>
        {/* Always available while Rack View is open, not just before the
            first Start Audit tap, so the Live Scan overlay can be reopened
            any time without going back through the footer button. */}
        <Pressable
          onPress={handleStartAudit}
          style={[styles.scanIconBtn, { backgroundColor: sessionOpen ? tokens.primary : tokens.muted, borderRadius: tokens.radius.lg }]}
        >
          <Ionicons name="camera-outline" size={18} color={sessionOpen ? tokens.primaryForeground : tokens.foreground} />
        </Pressable>
      </View>

      <View style={styles.body}>
        {/* Canvas and the Live Scan panel sit side by side, both big, once a
            session is open — not a small overlay — so status on the canvas
            and the scanned list are readable together at all times. */}
        <View style={sessionOpen ? styles.splitRow : styles.singleRow}>
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
                                      const selected = cell.code === selectedLoc;
                                      const status = sessionScans.find((s) => s.locCode === cell.code)?.status;
                                      const highlighted = isLocHighlighted(cell.code);
                                      const selectable = isLocSelectable(cell.code);
                                      // Two different "not resolved yet"
                                      // looks: lightly highlighted + dashed
                                      // while the session's still running
                                      // (pending — might still get scanned),
                                      // vs. a noticeably darker gray + dashed
                                      // once Done has confirmed no code was
                                      // ever found for it (status:'missing').
                                      const isPending = auditStarted && highlighted && !status;
                                      const isMissing = status === 'missing' || isPending;
                                      const bg =
                                        status === 'matched'
                                          ? tokens.rag.green.soft
                                          : status === 'mismatch'
                                            ? tokens.rag.amber.soft
                                            : status === 'missing'
                                              ? tokens.slate400
                                              : highlighted
                                                ? tokens.slate300
                                                : tokens.muted;
                                      const border = selected
                                        ? tokens.primary
                                        : status === 'matched'
                                          ? tokens.rag.green.border
                                          : status === 'mismatch'
                                            ? tokens.rag.amber.border
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
                                          dashed={isMissing}
                                          blinking={blinkLoc === cell.code}
                                          flagged={sessionScans.some((s) => s.locCode === cell.code && s.issueRaised)}
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
              {!sessionOpen ? (
                <View style={styles.footerRow}>
                  <Pressable onPress={() => setSelectedLoc(null)} style={[styles.outlineBtn, styles.footerBtn, { borderColor: tokens.border, borderRadius: tokens.radius.lg }]}>
                    <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.semibold, fontSize: tokens.text.sm }}>Cancel</Text>
                  </Pressable>
                  <Pressable
                    onPress={handleStartAudit}
                    style={[styles.primaryBtn, styles.footerBtn, { backgroundColor: tokens.primary, borderRadius: tokens.radius.lg }]}
                  >
                    <Text style={{ color: tokens.primaryForeground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm }}>Start Audit</Text>
                    <Ionicons name="chevron-forward" size={16} color={tokens.primaryForeground} />
                  </Pressable>
                </View>
              ) : null}
            </View>
          </Card>

          {sessionOpen ? (
            <ScanSessionPanel
              scans={sessionScans}
              expandedId={expandedScanId}
              matchedCount={sessionScans.filter((s) => s.status === 'matched').length}
              totalCount={totalTargets}
              cameraActive={cameraActive}
              selectedLocCode={selectedLoc}
              onScanCode={handleSessionScan}
              onSimulate={handleSessionSimulate}
              onRaiseIssue={(id) => setExpandedScanId(id)}
              onCollapse={() => setExpandedScanId(null)}
              onQtyChange={(id, qty) => updateScan(id, { qty })}
              onConditionChange={(id, condition) => updateScan(id, { condition })}
              onSaveIssue={handleSaveIssue}
              onUpdateEvidence={updateScanEvidence}
              onRequestImage={setAttachmentTarget}
              onSelectLocation={setSelectedLoc}
              onStopCamera={handleStopCamera}
              onResumeCamera={handleResumeCamera}
              onSaveAudit={handleSaveAudit}
            />
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

      <NewAttachmentModal visible={attachmentTarget !== null} onClose={() => setAttachmentTarget(null)} onSave={handleAddEvidenceImage} />

      <Modal visible={testSheetOpen} animationType="fade" onRequestClose={() => setTestSheetOpen(false)}>
        <View style={styles.testSheetContainer}>
          <View style={styles.testSheetHead}>
            <Text style={styles.testSheetTitle}>Rack A-21 — Test Scan Sheet</Text>
            <Pressable onPress={() => setTestSheetOpen(false)} hitSlop={10}>
              <Ionicons name="close" size={26} color="#fff" />
            </Pressable>
          </View>
          <Text style={styles.testSheetHint}>Hold this up to a second device's camera during a Live Scan session — pinch to zoom.</Text>
          <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={styles.testSheetScrollContent}
            minimumZoomScale={1}
            maximumZoomScale={4}
          >
            {/* eslint-disable-next-line @typescript-eslint/no-require-imports */}
            <Image source={require('../../../assets/images/test-sheets/rack-a21-scan-sheet.png')} style={styles.testSheetImage} resizeMode="contain" />
          </ScrollView>
        </View>
      </Modal>
    </View>
  );
}

// Split half-and-half with the canvas once Start Audit is tapped: camera on
// top, running list of what's been scanned this session below it. Matched
// entries can have "Raise Issue" tapped to expand an inline accordion (the
// same SkuLineCard Count Sheet uses) for correcting qty/condition.
function ScanSessionPanel({
  scans,
  expandedId,
  matchedCount,
  totalCount,
  cameraActive,
  selectedLocCode,
  onScanCode,
  onSimulate,
  onRaiseIssue,
  onCollapse,
  onQtyChange,
  onConditionChange,
  onSaveIssue,
  onUpdateEvidence,
  onRequestImage,
  onSelectLocation,
  onStopCamera,
  onResumeCamera,
  onSaveAudit,
}: {
  scans: SessionScan[];
  expandedId: string | null;
  matchedCount: number;
  totalCount: number;
  cameraActive: boolean;
  selectedLocCode: string | null;
  onScanCode: (code: string) => void;
  onSimulate: () => void;
  onRaiseIssue: (id: string) => void;
  onCollapse: () => void;
  onQtyChange: (id: string, qty: number) => void;
  onConditionChange: (id: string, condition: Condition) => void;
  onSaveIssue: (id: string) => void;
  onUpdateEvidence: (id: string, patch: Partial<Evidence>) => void;
  onRequestImage: (id: string) => void;
  onSelectLocation: (locCode: string) => void;
  onStopCamera: () => void;
  onResumeCamera: () => void;
  onSaveAudit: () => void;
}) {
  const { tokens } = useTheme();
  const [permission, requestPermission] = useCameraPermissions();
  const handledRef = useRef(false);
  // expo-camera calls onBarcodeScanned on every frame a code is decoded in
  // view. Two things need to both be true at once: (1) holding on the SAME
  // physical label too long must not double-count it (was: 38 codes
  // registering as 39), and (2) panning across a dense sheet of codes must
  // NOT get stuck after the first one — a naive "reset once nothing's been
  // seen for 700ms" fails (2) whenever another code is continuously in
  // view, since the idle window never actually opens. So: track which
  // code's currently "claimed" — a different code arriving is processed
  // immediately regardless of timing (the camera plainly moved to a new
  // label), while the SAME code repeating only re-arms after it's been
  // genuinely out of view for a bit.
  const lastDataRef = useRef<string | null>(null);
  const lastSeenRef = useRef(0);

  useEffect(() => {
    const id = setInterval(() => {
      if (handledRef.current && Date.now() - lastSeenRef.current > 700) {
        handledRef.current = false;
        lastDataRef.current = null;
      }
    }, 150);
    return () => clearInterval(id);
  }, []);

  // Immediate visual confirmation on every scan — matched or mismatch —
  // since a mismatch never resolves to a canvas cell (there's no location
  // to attribute it to), so without this the only feedback for that path
  // was the list scrolling, easy to miss while looking at the camera.
  const [flash, setFlash] = useState<{ tone: 'matched' | 'mismatch' } | null>(null);
  const flashTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastFlashedIdRef = useRef<string | null>(null);
  useEffect(() => {
    const latest = scans[0];
    if (!latest || latest.id === lastFlashedIdRef.current) return;
    lastFlashedIdRef.current = latest.id;
    // Only real-time camera scans flash — "missing" entries are added in
    // bulk once the camera's already stopped, so there's no live moment to
    // flash for.
    if (latest.status === 'missing') return;
    setFlash({ tone: latest.status });
    if (flashTimeoutRef.current) clearTimeout(flashTimeoutRef.current);
    flashTimeoutRef.current = setTimeout(() => setFlash(null), 650);
  }, [scans]);
  useEffect(
    () => () => {
      if (flashTimeoutRef.current) clearTimeout(flashTimeoutRef.current);
    },
    [],
  );

  const handleBarcodeScanned = ({ data }: { data: string }) => {
    const now = Date.now();
    if (handledRef.current && data === lastDataRef.current) {
      // Same code still sitting in frame — note it's still visible, but
      // don't reprocess it.
      lastSeenRef.current = now;
      return;
    }
    handledRef.current = true;
    lastDataRef.current = data;
    lastSeenRef.current = now;
    onScanCode(data);
  };

  return (
    <Card style={{ padding: 0, overflow: 'hidden', flex: 1 }}>
      <View style={[styles.diagramHeadRow, styles.sessionHeadRow, { backgroundColor: '#F7F8FA', borderBottomColor: tokens.border }]}>
        <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm }}>
          Live Scan — {matchedCount}/{totalCount} matched
        </Text>
        {cameraActive ? (
          <Pressable onPress={onStopCamera} style={[styles.sessionDoneBtn, { backgroundColor: tokens.primary, borderRadius: tokens.radius.lg }]}>
            <Text style={{ color: tokens.primaryForeground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.xs }}>Done</Text>
          </Pressable>
        ) : (
          <Pressable onPress={onResumeCamera} style={[styles.sessionDoneBtn, { borderWidth: 1, borderColor: tokens.primary, borderRadius: tokens.radius.lg }]}>
            <Text style={{ color: tokens.primary, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.xs }}>Scan</Text>
          </Pressable>
        )}
      </View>

      {/* Done just closes this camera box — nothing else changes. The list
          below is always there; with the camera closed it simply gets the
          full remaining height instead of sharing it. */}
      {cameraActive ? (
        <View style={styles.sessionCameraBox}>
          {permission?.granted ? (
            <CameraView style={StyleSheet.absoluteFill} barcodeScannerSettings={{ barcodeTypes: ['qr'] }} onBarcodeScanned={handleBarcodeScanned} />
          ) : (
            <View style={styles.sessionPermissionWrap}>
              <Ionicons name="camera-outline" size={26} color="#fff" />
              <Text style={styles.sessionPermissionText}>Camera access is needed to scan SKU codes.</Text>
              <Pressable onPress={requestPermission} style={styles.sessionGrantBtn}>
                <Text style={styles.sessionGrantBtnText}>Grant Camera Access</Text>
              </Pressable>
            </View>
          )}
          <View style={styles.sessionCountBadge}>
            <Text style={styles.sessionCountText}>{scans.length} scanned</Text>
          </View>
          {flash ? (
            <View pointerEvents="none" style={StyleSheet.absoluteFill}>
              <View
                style={[
                  StyleSheet.absoluteFillObject,
                  { borderWidth: 6, borderColor: flash.tone === 'matched' ? tokens.rag.green.strong : tokens.rag.amber.strong },
                ]}
              />
              <View
                style={[
                  styles.sessionFlashBanner,
                  { backgroundColor: flash.tone === 'matched' ? tokens.rag.green.strong : tokens.rag.amber.strong },
                ]}
              >
                <Text style={styles.sessionFlashText}>{flash.tone === 'matched' ? 'Matched' : 'Mismatch'}</Text>
              </View>
            </View>
          ) : null}
          <Pressable onPress={onSimulate} style={styles.sessionSimBtn}>
            <Text style={styles.sessionSimBtnText}>Use test scan</Text>
          </Pressable>
        </View>
      ) : null}

      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 12, gap: 10 }}>
        {scans.length === 0 ? (
          <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.sm, textAlign: 'center', paddingVertical: 20 }}>
            No SKUs scanned yet — point the camera at a pallet's SKU code.
          </Text>
        ) : null}
        {scans.map((scan) =>
          expandedId === scan.id ? (
            <SkuLineCard
              key={scan.id}
              line={scan}
              active
              onQtyChange={(qty) => onQtyChange(scan.id, qty)}
              onConditionChange={(condition) => onConditionChange(scan.id, condition)}
              onSave={() => onSaveIssue(scan.id)}
              onDelete={onCollapse}
              onEdit={() => {}}
              evidenceSlot={
                <EvidenceBlock
                  evidence={scan.evidence ?? { note: '', noteOpen: false, audio: null, images: [], videos: [] }}
                  onOpenNote={() => onUpdateEvidence(scan.id, { noteOpen: true })}
                  onChangeNote={(note) => onUpdateEvidence(scan.id, { note })}
                  onRecordAudio={() => onUpdateEvidence(scan.id, { audio: { durationSec: 20, playing: false, bars: generateWaveformBars() } })}
                  onToggleAudioPlay={() => {
                    const audio = scan.evidence?.audio;
                    if (!audio) return;
                    onUpdateEvidence(scan.id, { audio: { ...audio, playing: !audio.playing } });
                  }}
                  onRemoveAudio={() => onUpdateEvidence(scan.id, { audio: null })}
                  onAddImage={() => onRequestImage(scan.id)}
                  onRemoveImage={(i) => onUpdateEvidence(scan.id, { images: (scan.evidence?.images ?? []).filter((_, ii) => ii !== i) })}
                  onAddVideo={() => onUpdateEvidence(scan.id, { videos: [...(scan.evidence?.videos ?? []), { durationSec: 20 }] })}
                  onRemoveVideo={(i) => onUpdateEvidence(scan.id, { videos: (scan.evidence?.videos ?? []).filter((_, ii) => ii !== i) })}
                />
              }
            />
          ) : (
            <ScanRow
              key={scan.id}
              scan={scan}
              selected={!!scan.locCode && scan.locCode === selectedLocCode}
              onRaiseIssue={() => onRaiseIssue(scan.id)}
              onSelect={() => scan.locCode && onSelectLocation(scan.locCode)}
            />
          ),
        )}
      </ScrollView>

      <View style={[styles.sessionSaveRow, { borderTopColor: tokens.border }]}>
        <Pressable onPress={onSaveAudit} style={[styles.sessionSaveBtn, { backgroundColor: tokens.primary, borderRadius: tokens.radius.lg }]}>
          <Ionicons name="checkmark-circle-outline" size={18} color={tokens.primaryForeground} />
          <Text style={{ color: tokens.primaryForeground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm }}>Save Audit</Text>
        </Pressable>
      </View>
    </Card>
  );
}

function ScanRow({ scan, selected, onRaiseIssue, onSelect }: { scan: SessionScan; selected: boolean; onRaiseIssue: () => void; onSelect: () => void }) {
  const { tokens } = useTheme();
  const missingTone = { strong: tokens.mutedForeground, soft: tokens.muted, border: tokens.border };
  const tone = scan.status === 'matched' ? tokens.rag.green : scan.status === 'mismatch' ? tokens.rag.amber : missingTone;
  const badgeLabel = scan.status === 'matched' ? 'Matched' : scan.status === 'mismatch' ? 'Mismatch' : 'Missing';
  return (
    <Pressable
      disabled={!scan.locCode}
      onPress={onSelect}
      style={[styles.scanRow, { borderColor: selected ? tokens.primary : tokens.border, borderWidth: selected ? 2 : 1, borderRadius: tokens.radius.lg, backgroundColor: tokens.card }]}
    >
      <View style={{ flex: 1 }}>
        <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm }}>{scan.sku}</Text>
        <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xxs, marginTop: 2 }} numberOfLines={1}>
          {scan.name} · {scan.locLabel ?? 'No pallet left to attribute this to'}
        </Text>
      </View>
      <View style={[styles.scanBadge, { backgroundColor: tone.soft, borderColor: tone.border, borderRadius: tokens.radius.sm }]}>
        <Text style={{ color: tone.strong, fontSize: tokens.text.xxs, fontWeight: tokens.fontWeight.semibold }}>{badgeLabel}</Text>
      </View>
      {scan.status === 'matched' || scan.status === 'missing' ? (
        scan.issueRaised ? (
          <View style={[styles.issuePill, { backgroundColor: tokens.rag.red.soft, borderRadius: tokens.radius.sm }]}>
            <Text style={{ color: tokens.rag.red.strong, fontSize: tokens.text.xxs, fontWeight: tokens.fontWeight.semibold }}>
              {scan.status === 'missing' ? 'Evidence Added' : 'Issue Raised'}
            </Text>
          </View>
        ) : (
          <Pressable onPress={onRaiseIssue} style={[styles.raiseBtn, { borderColor: tokens.rag.red.border, borderRadius: tokens.radius.sm }]}>
            {scan.status === 'missing' ? (
              <Ionicons name="camera-outline" size={14} color={tokens.rag.red.strong} />
            ) : (
              <Ionicons name="flag-outline" size={14} color={tokens.rag.red.strong} />
            )}
          </Pressable>
        )
      ) : null}
    </Pressable>
  );
}

// A canvas cell owns its own blink animation (a repeating opacity pulse)
// rather than the parent, since starting/stopping a reanimated loop needs a
// hook tied to this specific cell's `blinking` prop.
function RackCell({
  bg,
  border,
  selected,
  selectable,
  dashed,
  blinking,
  flagged,
  onPress,
}: {
  bg: string;
  border: string;
  selected: boolean;
  selectable: boolean;
  dashed: boolean;
  blinking: boolean;
  flagged: boolean;
  onPress: () => void;
}) {
  const { tokens } = useTheme();
  const opacity = useSharedValue(selectable ? 1 : 0.45);

  useEffect(() => {
    if (blinking) {
      opacity.value = withRepeat(withSequence(withTiming(0.25, { duration: 350 }), withTiming(1, { duration: 350 })), -1, true);
    } else {
      cancelAnimation(opacity);
      opacity.value = withTiming(selectable ? 1 : 0.45, { duration: 150 });
    }
  }, [blinking, selectable]);

  const animatedStyle = useAnimatedStyle(() => ({ opacity: opacity.value }));

  return (
    <Animated.View
      style={[
        styles.cell,
        {
          backgroundColor: bg,
          borderColor: border,
          borderWidth: selected ? 2 : 1,
          // RN on Android drops dashes unevenly (especially at corners) when
          // borderStyle:'dashed' is combined with borderRadius — square the
          // corners for a dashed cell so the full dashed outline actually
          // renders, instead of a partial/broken-looking border.
          ...(dashed ? { borderStyle: 'dashed' as const, borderRadius: 0 } : { borderStyle: 'solid' as const }),
        },
        animatedStyle,
      ]}
    >
      <Pressable disabled={!selectable} onPress={onPress} style={StyleSheet.absoluteFill} />
      {flagged ? <View style={[styles.flagDot, { backgroundColor: tokens.rag.red.strong }]} /> : null}
    </Animated.View>
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
  cellEmpty: { borderStyle: 'dashed', opacity: 0.4 },
  outlineBtn: { flex: 1, height: 44, alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
  primaryBtn: { flex: 1, flexDirection: 'row', height: 44, alignItems: 'center', justifyContent: 'center', gap: 6 },
  footerRow: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 16 },
  footerBtn: { flex: 0, paddingHorizontal: 18 },
  sessionHeadRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sessionDoneBtn: { height: 30, paddingHorizontal: 14, alignItems: 'center', justifyContent: 'center' },
  sessionCameraBox: { height: 190, backgroundColor: '#000' },
  sessionPermissionWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8, padding: 16 },
  sessionPermissionText: { color: '#fff', fontSize: 12, textAlign: 'center' },
  sessionGrantBtn: { backgroundColor: '#1b59f8', paddingHorizontal: 16, height: 34, alignItems: 'center', justifyContent: 'center', borderRadius: 8 },
  sessionGrantBtnText: { color: '#fff', fontWeight: '700', fontSize: 12 },
  sessionCountBadge: { position: 'absolute', top: 10, alignSelf: 'center', backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: 14, paddingHorizontal: 12, paddingVertical: 5 },
  sessionCountText: { color: '#fff', fontWeight: '700', fontSize: 11 },
  sessionFlashBanner: { position: 'absolute', bottom: 50, alignSelf: 'center', borderRadius: 8, paddingHorizontal: 16, paddingVertical: 6 },
  sessionFlashText: { color: '#fff', fontWeight: '800', fontSize: 13 },
  sessionSimBtn: { position: 'absolute', bottom: 10, alignSelf: 'center', borderWidth: 1, borderColor: 'rgba(255,255,255,0.7)', borderRadius: 8, paddingHorizontal: 14, height: 32, alignItems: 'center', justifyContent: 'center' },
  sessionSimBtnText: { color: '#fff', fontWeight: '600', fontSize: 12 },
  sessionSaveRow: { padding: 12, borderTopWidth: 1 },
  sessionSaveBtn: { flexDirection: 'row', height: 44, alignItems: 'center', justifyContent: 'center', gap: 6 },
  scanRow: { flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, padding: 10 },
  scanBadge: { borderWidth: 1, paddingHorizontal: 8, paddingVertical: 4 },
  raiseBtn: { width: 30, height: 30, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  issuePill: { paddingHorizontal: 8, paddingVertical: 4 },
  flagDot: { position: 'absolute', top: -3, right: -3, width: 8, height: 8, borderRadius: 4, borderWidth: 1, borderColor: '#fff' },
  testSheetContainer: { flex: 1, backgroundColor: '#111' },
  testSheetHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: 56, paddingHorizontal: 20, paddingBottom: 8 },
  testSheetTitle: { color: '#fff', fontWeight: '700', fontSize: 16 },
  testSheetHint: { color: 'rgba(255,255,255,0.7)', fontSize: 12, paddingHorizontal: 20, paddingBottom: 12 },
  testSheetScrollContent: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', padding: 20 },
  testSheetImage: { width: '100%', height: 900 },
});
