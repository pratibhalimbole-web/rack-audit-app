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
import { generateWaveformBars, INVENTORY_POOL } from '@/lib/mockData';
import type { CountLine, Evidence } from '@/lib/types';
import { useTheme } from '@/theme/ThemeProvider';
import { useAudits } from '../dashboard/hooks';
import { useCountSheetMutations } from '../count-sheet/mutations';
import { buildBayDiagram } from './buildBayDiagram';

type Params = { auditId: string; layout: string; rackId: string; bay: string };

const STATUS_TONE = { 'Not Started': 'To Do', 'In Progress': 'In Progress', Completed: 'Completed' } as const;

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
  const [pickerField, setPickerField] = useState<'rack' | 'bay' | null>(null);
  const [selectedLoc, setSelectedLoc] = useState<string | null>(null);
  const [scanCycle, setScanCycle] = useState(0);
  const [skuPanelOpen, setSkuPanelOpen] = useState(false);
  const [scanLines, setScanLines] = useState<CountLine[]>([]);
  const [scanPallet, setScanPallet] = useState<string | null>(null);
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);
  const [skuScanCount, setSkuScanCount] = useState(0);
  const [scannerOpen, setScannerOpen] = useState<'pallet' | 'sku' | null>(null);
  const [attachmentTarget, setAttachmentTarget] = useState<number | null>(null);
  const confirm = useConfirmDialog();

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
  const seedKeyRef = useRef<string | null>(null);
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

  if (!audit || isLoading || !tree) {
    return (
      <View style={[styles.loading, { backgroundColor: tokens.muted }]}>
        <ActivityIndicator color={tokens.primary} />
      </View>
    );
  }

  const layoutObj = findLayoutIn(tree, layout);
  const rackObj = findRackIn(tree, layout, rackCode);
  const bayObj = rackObj?.bays.find((b) => b.code === bayCode);

  if (!layoutObj || !rackObj || !bayObj) {
    return (
      <View style={[styles.loading, { backgroundColor: tokens.muted }]}>
        <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.sm }}>That bay isn't in your assigned scope.</Text>
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

  const handleStartAudit = () => {
    if (!selectedLocObj) return;
    const existing = selectedLocObj.pallets.find((p) => !p.saved) ?? null;
    const base = existing ? existing.lines.map((l) => ({ ...l })) : [];
    setScanPallet(existing ? existing.pallet : null);
    setScanLines(base);
    setExpandedIdx(null);
    setSkuPanelOpen(true);
    applySkuPick(INVENTORY_POOL[skuScanCount % INVENTORY_POOL.length], base);
    setSkuScanCount((c) => c + 1);
  };

  const applySkuPick = (pick: { sku: string; name: string; lot: string }, base?: CountLine[]) => {
    const lines = base ?? scanLines;
    const dupIdx = lines.findIndex((l) => l.sku === pick.sku);
    if (dupIdx !== -1) {
      const next = lines.slice();
      next[dupIdx] = { ...next[dupIdx], qty: next[dupIdx].qty + 1 };
      setScanLines(next);
      setExpandedIdx(dupIdx);
    } else {
      const next = [...lines, { sku: pick.sku, name: pick.name, lot: pick.lot, qty: 1, condition: 'Good' as const }];
      setScanLines(next);
      setExpandedIdx(next.length - 1);
    }
  };

  const handleSimulatedSkuScan = () => {
    applySkuPick(INVENTORY_POOL[skuScanCount % INVENTORY_POOL.length]);
    setSkuScanCount((c) => c + 1);
  };

  const handleRealSkuScanned = (data: string) => {
    setScannerOpen(null);
    const code = data.trim();
    const pick = INVENTORY_POOL.find((p) => p.sku === code) ?? { sku: code, name: 'Unlisted SKU', lot: '—' };
    applySkuPick(pick);
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
        <ToolbarField
          label={selectedLocObj ? (selectedLocObj.slot != null ? `Pallet ${String(selectedLocObj.slot).padStart(2, '0')}` : selectedLocObj.code) : '—'}
          fixed
          tag={selectedLocObj?.status}
        />
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
                            const bg = cell.status === 'Completed' ? tokens.rag.green.soft : cell.status === 'In Progress' ? tokens.accentPurple.soft : tokens.muted;
                            const border = selected ? tokens.primary : cell.status === 'Completed' ? tokens.rag.green.border : tokens.border;
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

      <Modal visible={skuPanelOpen} transparent animationType="fade" onRequestClose={() => setSkuPanelOpen(false)}>
        <Pressable style={[styles.backdrop, { backgroundColor: tokens.scrim }]} onPress={() => setSkuPanelOpen(false)}>
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
              <Pressable onPress={() => setScannerOpen('sku')} style={[styles.scanIconBtn, { backgroundColor: tokens.muted, borderRadius: tokens.radius.lg }]}>
                <Ionicons name="qr-code-outline" size={18} color={tokens.foreground} />
              </Pressable>
            </View>
            <ScrollView style={{ flex: 1 }} contentContainerStyle={{ gap: 10, paddingBottom: 10 }}>
              {scanLines.map((line, idx) => (
                <SkuLineCard
                  key={idx}
                  line={line}
                  active={idx === (expandedIdx ?? scanLines.length - 1)}
                  onQtyChange={(qty) => {
                    const next = scanLines.slice();
                    next[idx] = { ...next[idx], qty };
                    setScanLines(next);
                  }}
                  onConditionChange={(condition) => {
                    const next = scanLines.slice();
                    next[idx] = { ...next[idx], condition };
                    setScanLines(next);
                  }}
                  onSave={() => setExpandedIdx(-1)}
                  onDelete={() =>
                    confirm.ask(`Remove ${line.sku} from this record?`, () => {
                      setScanLines(scanLines.filter((_, i) => i !== idx));
                      setExpandedIdx(null);
                    })
                  }
                  onEdit={() => setExpandedIdx(idx)}
                  evidenceSlot={
                    <EvidenceBlock
                      evidence={ensureLineEvidence(line)}
                      onOpenNote={() => updateLineEvidence(idx, { noteOpen: true })}
                      onChangeNote={(note) => updateLineEvidence(idx, { note })}
                      onRecordAudio={() => updateLineEvidence(idx, { audio: { durationSec: 20, playing: false, bars: generateWaveformBars() } })}
                      onToggleAudioPlay={() => {
                        const ev = ensureLineEvidence(line);
                        if (!ev.audio) return;
                        updateLineEvidence(idx, { audio: { ...ev.audio, playing: !ev.audio.playing } });
                      }}
                      onRemoveAudio={() => updateLineEvidence(idx, { audio: null })}
                      onAddImage={() => setAttachmentTarget(idx)}
                      onRemoveImage={(i) => updateLineEvidence(idx, { images: ensureLineEvidence(line).images.filter((_, ii) => ii !== i) })}
                      onAddVideo={() => updateLineEvidence(idx, { videos: [...ensureLineEvidence(line).videos, { durationSec: 20 }] })}
                      onRemoveVideo={(i) => updateLineEvidence(idx, { videos: ensureLineEvidence(line).videos.filter((_, ii) => ii !== i) })}
                    />
                  }
                />
              ))}
            </ScrollView>
            <View style={styles.skuPanelFooter}>
              <Pressable onPress={() => setSkuPanelOpen(false)} style={[styles.outlineBtn, { flex: 1, borderColor: tokens.border, borderRadius: tokens.radius.lg }]}>
                <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.semibold, fontSize: tokens.text.sm }}>Cancel</Text>
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
        hint="Point at the SKU code"
        onScanned={handleRealSkuScanned}
        onUseSimulated={() => {
          setScannerOpen(null);
          handleSimulatedSkuScan();
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
    <View style={[styles.toolbarField, { backgroundColor: fixed ? tokens.muted : tokens.card, borderColor: open ? tokens.primary : tokens.border, borderRadius: tokens.radius.lg }]}>
      <Text style={{ color: tokens.foreground, fontSize: tokens.text.xs }} numberOfLines={1}>
        {label}
      </Text>
      {tag ? <Pill label={tag} tone={STATUS_TONE[tag as keyof typeof STATUS_TONE] ?? 'To Do'} /> : null}
      {!fixed ? <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={14} color={tokens.mutedForeground} /> : null}
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
  scanIconBtn: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  inlineDropdown: { position: 'absolute', top: 40, left: 0, minWidth: 160, borderWidth: 1, zIndex: 30, elevation: 30 },
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
  backdrop: { flex: 1, flexDirection: 'row', justifyContent: 'flex-end' },
  skuPanelSlide: { height: '100%' },
  skuPanel: { width: 420, maxWidth: '90%', height: '100%', padding: 16 },
  skuPanelHead: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 14 },
  skuPanelFooter: { flexDirection: 'row', gap: 10, marginTop: 12 },
});
