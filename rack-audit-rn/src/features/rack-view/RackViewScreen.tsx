import { Ionicons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { SlideInRight, SlideOutRight, useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
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
import type { CountLine, Evidence } from '@/lib/types';
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

// Ports renderRackView() + buildBayDiagram + renderRackViewSkuPanel
// (rack-audit-app.html ~2820-3223) — the tablet-only schematic elevation of
// a bay (levels stacked bottom-up), reached from an Audit Details bay pill,
// so an inspector sees where a Pallet LPN physically sits before counting.
// Only Layout/Rack/Bay and the tapped cell can change here — the counting
// itself reuses the same SkuLineCard as Count Sheet. Evidence (photo
// annotation/audio/video) on scanned lines lands in step 8; this pass covers
// the qty/condition editing contract Count Sheet already established.
export function RackViewScreen() {
  const { tokens } = useTheme();
  const params = useLocalSearchParams<Params>();
  const { auditId, layout } = params;
  const { data: audits } = useAudits();
  const audit = audits?.find((a) => a.audit_id === auditId);
  const { data: tree, isLoading } = useLocationsTree(auditId);
  const { saveRecord } = useCountSheetMutations(auditId);

  const [rackCode, setRackCode] = useState(params.rackId);
  const [bayCode, setBayCode] = useState(params.bay);
  const [pickerField, setPickerField] = useState<'rack' | 'bay' | 'pallet' | null>(null);
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
  const [attachmentTarget, setAttachmentTarget] = useState<number | null>(null);
  const confirm = useConfirmDialog();

  // Variation 2: exactly one SKU is expected per pallet, and exactly one
  // scan is on record for it (a new scan replaces the previous one rather
  // than accumulating a checklist). The SKU identity check happens first —
  // if the wrong item was scanned, that's "Misplaced" and there's nothing
  // to reconcile at this location for it. Only once the right SKU is
  // confirmed does the qty/condition form appear; Matched vs. Mismatch is
  // then decided by what the inspector records there.
  const expectedSku = expectedSkus[0] ?? null;
  const scannedLine = scanLines[0] ?? null;
  const skuMatched = !!scannedLine && !!expectedSku && scannedLine.sku === expectedSku.sku;
  const misplaced = !!scannedLine && !skuMatched;

  // Drives the bay canvas cell colors: green once a pallet's scan resolves
  // to a clean match, red for any kind of mismatch (wrong SKU, wrong qty,
  // wrong condition), gray for anything not yet scanned this session.
  const [locationStatus, setLocationStatus] = useState<Record<string, 'matched' | 'mismatch'>>({});

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

  const seedKey = `${auditId}|${layout}|${rackCode}|${bayCode}`;
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

  // The requested layout/rack/bay (from route params or a stale picker
  // selection) may not exist in this audit's tree — rather than dead-ending
  // on an error, fall back to the first rack/bay so Rack View for this
  // task always renders something the inspector can act on.
  const fallbackLayoutObj = tree ? (findLayoutIn(tree, layout) ?? tree.layouts[0]) : undefined;
  const fallbackRackObj = tree && fallbackLayoutObj ? (findRackIn(tree, fallbackLayoutObj.name, rackCode) ?? fallbackLayoutObj.racks[0]) : undefined;
  const fallbackBayObj = fallbackRackObj?.bays.find((b) => b.code === bayCode) ?? fallbackRackObj?.bays[0];

  useEffect(() => {
    if (fallbackRackObj && fallbackRackObj.code !== rackCode) setRackCode(fallbackRackObj.code);
    if (fallbackBayObj && fallbackBayObj.code !== bayCode) setBayCode(fallbackBayObj.code);
  }, [fallbackRackObj?.code, fallbackBayObj?.code]);

  if (!audit || isLoading || !tree) {
    return (
      <View style={[styles.loading, { backgroundColor: tokens.muted }]}>
        <ActivityIndicator color={tokens.primary} />
      </View>
    );
  }

  const layoutObj = fallbackLayoutObj;
  const rackObj = fallbackRackObj;
  const bayObj = fallbackBayObj;

  if (!layoutObj || !rackObj || !bayObj) {
    return (
      <View style={[styles.loading, { backgroundColor: tokens.muted }]}>
        <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.sm }}>No bays are in scope for this task yet.</Text>
        <Pressable onPress={() => router.back()} style={{ marginTop: 12 }}>
          <Text style={{ color: tokens.primary, fontWeight: tokens.fontWeight.semibold }}>Go back</Text>
        </Pressable>
      </View>
    );
  }

  const selectedLocObj = selectedLoc ? bayObj.locations.find((l) => l.code === selectedLoc) ?? null : null;
  const rows = buildBayDiagram(bayObj);

  const rackOptions: SheetOption[] = layoutObj.racks.map((r) => ({ value: r.code, label: `Rack ${r.code}` }));
  const bayOptions: SheetOption[] = rackObj.bays.map((b) => ({ value: b.code, label: `Bay ${b.code}` }));
  const palletOptions: SheetOption[] = bayObj.locations.map((l) => ({
    value: l.code,
    label: palletIdFor(l),
  }));

  const handlePickRack = (code: string) => {
    const nextRack = findRackIn(tree, layout, code);
    setRackCode(code);
    setBayCode(nextRack?.bays[0]?.code ?? '');
    setPickerField(null);
  };
  const handlePickBay = (code: string) => {
    setBayCode(code);
    setPickerField(null);
  };
  const handlePickPallet = (code: string) => {
    setSelectedLoc(code);
    setPickerField(null);
  };

  const handleSimulatedPalletScan = () => {
    if (!bayObj.locations.length) return;
    const loc = bayObj.locations[scanCycle % bayObj.locations.length];
    setScanCycle((c) => c + 1);
    setSelectedLoc(loc.code);
  };

  const handleRealPalletScanned = (data: string) => {
    setScannerOpen(null);
    const code = data.trim();
    const match = bayObj.locations.find((l) => l.code === code);
    if (match) setSelectedLoc(match.code);
  };

  // Drives the bay canvas cell colors: green once a pallet's scan resolves
  // to a clean match, red for any kind of mismatch (wrong SKU, wrong qty,
  // wrong condition), gray (the default, just omitted from the map) for
  // anything not yet scanned. Called from every place the scan/edit state
  // for the open pallet can change, so the canvas behind the panel always
  // reflects what's on screen right now.
  const applyLocationStatus = (locCode: string, line: CountLine | null, expected: ExpectedSkuLine | null) => {
    setLocationStatus((prev) => {
      if (!line) {
        if (!(locCode in prev)) return prev;
        const next = { ...prev };
        delete next[locCode];
        return next;
      }
      const matched = !!expected && line.sku === expected.sku && line.qty === expected.qty && line.condition === 'Good';
      const status: 'matched' | 'mismatch' = matched ? 'matched' : 'mismatch';
      return prev[locCode] === status ? prev : { ...prev, [locCode]: status };
    });
  };

  const handleStartAudit = () => {
    if (!selectedLocObj) return;
    const existing = selectedLocObj.pallets.find((p) => !p.saved) ?? null;
    // Single-SKU pallet: only the first line of any pre-seeded data applies.
    const base = existing ? existing.lines.slice(0, 1).map((l) => ({ ...l })) : [];
    const expected = (EXPECTED_SKUS[selectedLocObj.code] ?? []).slice(0, 1);
    setScanPallet(existing ? existing.pallet : null);
    setScanLines(base);
    setExpandedIdx(base.length ? 0 : null);
    setExpectedSkus(expected);
    setSkuPanelOpen(true);
    applyLocationStatus(selectedLocObj.code, base[0] ?? null, expected[0] ?? null);
  };

  // One scan per pallet — a new scan replaces whatever was scanned before,
  // it doesn't accumulate into a list. The SKU identity check decides what
  // happens next: right SKU opens the qty/condition form, wrong SKU is
  // "Misplaced" with nothing further to fill in.
  const applySkuScan = (pick: { sku: string; name: string; lot: string }) => {
    const line: CountLine = { sku: pick.sku, name: pick.name, lot: pick.lot, qty: 1, condition: 'Good' };
    setScanLines([line]);
    const matchesExpected = !!expectedSkus[0] && expectedSkus[0].sku === pick.sku;
    setExpandedIdx(matchesExpected ? 0 : null);
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

  const updateLineEvidence = (idx: number, patch: Partial<Evidence>) => {
    const next = scanLines.slice();
    next[idx] = { ...next[idx], evidence: { ...ensureLineEvidence(next[idx]), ...patch } };
    setScanLines(next);
  };

  const handleSaveSkuPanel = async () => {
    if (selectedLocObj && scanLines.length) {
      await saveRecord(tree, { auditId, layout, rack: rackCode, bay: bayCode, loc: selectedLocObj.code }, scanLines);
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
          <ToolbarField label={`Bay ${bayObj.code}`} open={pickerField === 'bay'} onPress={() => setPickerField(pickerField === 'bay' ? null : 'bay')} />
          {pickerField === 'bay' ? (
            <>
              <Pressable style={StyleSheet.absoluteFill} onPress={() => setPickerField(null)} />
              <InlineDropdown options={bayOptions} selectedValue={bayCode} onSelect={handlePickBay} />
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
      </View>

      <View style={styles.body}>
        <Card style={{ padding: 0, overflow: 'hidden', flex: 1 }}>
          <View style={[styles.diagramHeadRow, { backgroundColor: '#F7F8FA', borderBottomColor: tokens.border }]}>
            <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm }}>Front View</Text>
          </View>
          <View style={styles.diagramBody}>
            <GestureDetector gesture={canvasGesture}>
              <View style={styles.diagramCenter}>
                <Animated.View style={canvasAnimatedStyle}>
                  <View style={styles.diagram}>
                    {rows.map((row) => (
                      <View key={row.level} style={styles.diagramRow}>
                        <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xs, width: 30 }}>L{row.level}</Text>
                        <View style={styles.diagramCells}>
                          {row.cells.map((cell, i) => {
                            if (!cell) return <View key={i} style={[styles.cell, styles.cellEmpty, { borderColor: tokens.border }]} />;
                            const selected = cell.code === selectedLoc;
                            const status = locationStatus[cell.code];
                            const bg = status === 'matched' ? tokens.rag.green.soft : status === 'mismatch' ? tokens.rag.red.soft : tokens.muted;
                            const border = selected ? tokens.primary : status === 'matched' ? tokens.rag.green.border : status === 'mismatch' ? tokens.rag.red.border : tokens.border;
                            return (
                              <Pressable
                                key={cell.code}
                                onPress={() => setSelectedLoc(cell.code)}
                                style={[styles.cell, { backgroundColor: bg, borderColor: border, borderWidth: selected ? 2 : 1 }]}
                              />
                            );
                          })}
                        </View>
                      </View>
                    ))}
                  </View>
                  <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xs, textAlign: 'center', marginTop: 10 }}>Bay {bayObj.code}</Text>
                </Animated.View>
              </View>
            </GestureDetector>
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
          </View>
        </Card>
      </View>

      <Modal visible={skuPanelOpen} transparent statusBarTranslucent animationType="fade" onRequestClose={() => setSkuPanelOpen(false)}>
        <Pressable style={[styles.backdrop, { backgroundColor: 'rgba(0,0,0,0.7)' }]} onPress={() => setSkuPanelOpen(false)}>
          <Animated.View entering={SlideInRight.duration(250)} exiting={SlideOutRight.duration(200)} style={styles.skuPanelSlide}>
            <Pressable
              style={[styles.skuPanel, { backgroundColor: tokens.card, borderTopLeftRadius: tokens.radius.xxl, borderBottomLeftRadius: tokens.radius.xxl }]}
              onPress={(e) => e.stopPropagation()}
            >
            <View style={styles.skuPanelHead}>
              <View>
                <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.extrabold, fontSize: tokens.text.base }}>Reconciliation Form</Text>
                <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xs, marginTop: 2 }}>
                  {selectedLocObj?.code} · {scanPallet ?? 'New Pallet'}
                </Text>
              </View>
            </View>

            {expandedIdx !== null && scannedLine && skuMatched && expectedSku ? (
              // The SKU form only appears once the identity check passes —
              // a misplaced scan (wrong SKU for this pallet) has nothing to
              // fill in, it's handled by the view below instead. Status here
              // is only ever Quantity/Condition mismatch or a clean Matched,
              // since "wrong SKU" can't happen in this branch.
              <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 10 }}>
                {(() => {
                  const line = scannedLine;
                  const qtyMismatch = line.qty !== expectedSku.qty;
                  const conditionFlagged = line.condition !== 'Good';
                  const editStatus = qtyMismatch
                    ? { label: 'Quantity Mismatch', rag: tokens.rag.amber }
                    : conditionFlagged
                      ? { label: 'Condition Mismatch', rag: tokens.rag.amber }
                      : { label: 'Matched', rag: tokens.rag.green };
                  const raised = issuesRaised.has(line.sku);
                  return (
                    <>
                      <View style={[styles.editStatusPill, { backgroundColor: editStatus.rag.soft, borderColor: editStatus.rag.border, borderRadius: tokens.radius.lg }]}>
                        <Text style={{ color: editStatus.rag.strong, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.xs }}>{editStatus.label}</Text>
                      </View>
                      {qtyMismatch || conditionFlagged ? (
                        <Pressable
                          disabled={raised}
                          onPress={() => setIssuesRaised((prev) => new Set(prev).add(line.sku))}
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
                                : `Raise Issue — condition: ${line.condition}`}
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
              <ScrollView style={{ flex: 1 }} contentContainerStyle={{ gap: 10, paddingBottom: 10 }}>
                {expectedSku ? (
                  <View style={[styles.expectedBox, { backgroundColor: tokens.card, borderColor: tokens.border, borderRadius: tokens.radius.xl }]}>
                    <View style={styles.expectedHeadRow}>
                      <Ionicons name="clipboard-outline" size={16} color={tokens.mutedForeground} />
                      <Text style={{ flex: 1, color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm }}>
                        Expected on this Pallet
                      </Text>
                    </View>
                    <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm }}>{expectedSku.sku}</Text>
                    <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xs, marginTop: 1 }}>{expectedSku.name}</Text>
                    <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xs, marginTop: 5 }}>Expected qty {expectedSku.qty}</Text>
                  </View>
                ) : (
                  <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.sm, textAlign: 'center', paddingVertical: 12 }}>
                    No SKU is expected at this location.
                  </Text>
                )}

                {misplaced && scannedLine ? (
                  <View style={[styles.expectedBox, { backgroundColor: tokens.card, borderColor: tokens.border, borderRadius: tokens.radius.xl }]}>
                    <View style={[styles.editStatusPill, { backgroundColor: tokens.rag.amber.soft, borderColor: tokens.rag.amber.border, borderRadius: tokens.radius.lg }]}>
                      <Text style={{ color: tokens.rag.amber.strong, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.xs }}>Misplaced</Text>
                    </View>
                    <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm }}>{scannedLine.sku}</Text>
                    <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xs, marginTop: 1 }}>{scannedLine.name}</Text>
                    <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xs, marginTop: 8 }}>
                      {expectedSku ? `This isn't ${expectedSku.sku}, which is what's expected here.` : "This SKU isn't expected at this location at all."}
                    </Text>
                    {(() => {
                      const raised = issuesRaised.has(scannedLine.sku);
                      return (
                        <Pressable
                          disabled={raised}
                          onPress={() => setIssuesRaised((prev) => new Set(prev).add(scannedLine.sku))}
                          style={[
                            styles.raiseIssueBox,
                            {
                              marginTop: 12,
                              marginBottom: 0,
                              backgroundColor: raised ? tokens.rag.green.soft : tokens.card,
                              borderColor: raised ? tokens.rag.green.border : tokens.border,
                              borderRadius: tokens.radius.lg,
                            },
                          ]}
                        >
                          <Ionicons name={raised ? 'checkmark-circle' : 'flag'} size={18} color={raised ? tokens.rag.green.strong : tokens.mutedForeground} />
                          <Text style={{ color: raised ? tokens.rag.green.strong : tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm, flex: 1 }}>
                            {raised ? 'Issue raised for this SKU' : 'Raise Issue — wrong item scanned'}
                          </Text>
                          {!raised ? <Text style={{ color: tokens.mutedForeground, fontWeight: tokens.fontWeight.semibold, fontSize: tokens.text.xs }}>Tap to raise</Text> : null}
                        </Pressable>
                      );
                    })()}
                  </View>
                ) : null}

                {!expectedSku && !scannedLine ? (
                  <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.sm, textAlign: 'center', paddingVertical: 20 }}>
                    No SKU scanned yet — use the scanner below.
                  </Text>
                ) : null}
              </ScrollView>
            )}
            {expandedIdx === null ? (
              <Pressable onPress={() => setScannerOpen('sku')} style={[styles.batchScanBtn, { backgroundColor: tokens.primary, borderRadius: tokens.radius.lg }]}>
                <Ionicons name="qr-code-outline" size={18} color={tokens.primaryForeground} />
                <Text style={{ color: tokens.primaryForeground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm }}>
                  {scannedLine ? 'Scan Again' : 'Scan SKU'}
                </Text>
              </Pressable>
            ) : null}
            <View style={styles.skuPanelFooter}>
              <Pressable
                onPress={() => (expandedIdx !== null ? setExpandedIdx(null) : setSkuPanelOpen(false))}
                style={[styles.outlineBtn, { flex: 1, borderColor: tokens.border, borderRadius: tokens.radius.lg }]}
              >
                <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.semibold, fontSize: tokens.text.sm }}>
                  {expandedIdx !== null ? 'Back' : 'Cancel'}
                </Text>
              </Pressable>
              <Pressable onPress={handleSaveSkuPanel} style={[styles.primaryBtn, { flex: 1, backgroundColor: tokens.primary, borderRadius: tokens.radius.lg }]}>
                <Text style={{ color: tokens.primaryForeground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm }}>Save</Text>
              </Pressable>
            </View>
            </Pressable>
          </Animated.View>
        </Pressable>
      </Modal>

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
          const idx = attachmentTarget;
          updateLineEvidence(idx, { images: [...ensureLineEvidence(scanLines[idx]).images, image] });
        }}
      />
      {confirm.element}
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
  inlineDropdown: { position: 'absolute', top: 40, left: 0, width: 160, borderWidth: 1, zIndex: 30, elevation: 30 },
  inlineDropdownItem: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, paddingHorizontal: 12, paddingVertical: 11, borderBottomWidth: StyleSheet.hairlineWidth },
  body: { flex: 1, padding: 16 },
  diagramHeadRow: { paddingHorizontal: 14, paddingVertical: 12, borderBottomWidth: 1 },
  diagramBody: { flex: 1, padding: 14 },
  diagramCenter: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  diagram: { gap: 6 },
  diagramRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  diagramCells: { flexDirection: 'row', gap: 8 },
  cell: { width: 38, height: 26, borderWidth: 1, borderRadius: 4 },
  cellEmpty: { borderStyle: 'dashed', opacity: 0.4 },
  outlineBtn: { flex: 1, height: 44, alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
  primaryBtn: { flex: 1, flexDirection: 'row', height: 44, alignItems: 'center', justifyContent: 'center', gap: 6 },
  footerRow: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 16 },
  footerBtn: { flex: 0, paddingHorizontal: 18 },
  backdrop: { flex: 1, width: '100%', height: '100%', flexDirection: 'row', justifyContent: 'flex-end' },
  skuPanelSlide: { width: 530, maxWidth: '90%', height: '100%' },
  skuPanel: { width: '100%', height: '100%', padding: 16 },
  skuPanelHead: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 14 },
  expectedBox: { borderWidth: 1, padding: 14, marginBottom: 12 },
  expectedHeadRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 12 },
  batchScanBtn: { flexDirection: 'row', gap: 8, height: 46, alignItems: 'center', justifyContent: 'center', marginTop: 4 },
  raiseIssueBox: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, padding: 12, marginBottom: 12 },
  editStatusPill: { alignSelf: 'flex-start', borderWidth: 1, paddingHorizontal: 10, paddingVertical: 5, marginBottom: 10 },
  skuPanelFooter: { flexDirection: 'row', gap: 10, marginTop: 12 },
});
