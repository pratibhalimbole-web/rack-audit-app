import { Ionicons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { AppHeader } from '@/components/AppHeader';
import { BarcodeScannerModal } from '@/components/BarcodeScannerModal';
import { Card } from '@/components/Card';
import { EvidenceBlock } from '@/components/EvidenceBlock';
import { NewAttachmentModal } from '@/components/NewAttachmentModal';
import { Pill } from '@/components/Pill';
import { SkuLineCard } from '@/components/SkuLineCard';
import { BottomSheetPicker, type SheetOption } from '@/components/BottomSheetPicker';
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

  const seedKey = `${auditId}|${layout}|${rackCode}|${bayCode}`;
  const seedKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (seedKeyRef.current !== seedKey) {
      seedKeyRef.current = seedKey;
      setSelectedLoc(null);
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
      <AppHeader title={audit.audit_name} sub={audit.audit_id} showBack menuItems={[{ label: 'Sync Now', onPress: () => {} }]} />

      <View style={[styles.toolbar, { backgroundColor: tokens.card, borderBottomColor: tokens.border }]}>
        <ToolbarField label={layoutObj.name} fixed />
        <ToolbarField label={`Rack ${rackObj.code}`} onPress={() => setPickerField('rack')} />
        <ToolbarField label={`Bay ${bayObj.code}`} onPress={() => setPickerField('bay')} />
        <ToolbarField
          label={selectedLocObj ? (selectedLocObj.slot != null ? `Pallet ${String(selectedLocObj.slot).padStart(2, '0')}` : selectedLocObj.code) : '—'}
          fixed
          tag={selectedLocObj?.status}
        />
        <Pressable onPress={() => setScannerOpen('pallet')} style={[styles.scanIconBtn, { backgroundColor: tokens.muted, borderRadius: tokens.radius.lg }]}>
          <Ionicons name="qr-code-outline" size={18} color={tokens.foreground} />
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={styles.body}>
        <Card>
          <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm, marginBottom: 12 }}>Front View</Text>
          <View style={styles.diagram}>
            {rows.map((row) => (
              <View key={row.level} style={styles.diagramRow}>
                <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xxs, width: 26 }}>L{row.level}</Text>
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
          <View style={styles.diagramActions}>
            <Pressable onPress={() => setSelectedLoc(null)} style={[styles.outlineBtn, { borderColor: tokens.border, borderRadius: tokens.radius.lg }]}>
              <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.semibold, fontSize: tokens.text.sm }}>Cancel</Text>
            </Pressable>
            <Pressable
              disabled={!selectedLoc}
              onPress={handleStartAudit}
              style={[styles.primaryBtn, { backgroundColor: tokens.primary, borderRadius: tokens.radius.lg, opacity: selectedLoc ? 1 : 0.5 }]}
            >
              <Text style={{ color: tokens.primaryForeground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm }}>Start Audit</Text>
              <Ionicons name="chevron-forward" size={16} color={tokens.primaryForeground} />
            </Pressable>
          </View>
        </Card>
      </ScrollView>

      {pickerField ? (
        <BottomSheetPicker
          visible
          title={pickerField === 'rack' ? 'Select Rack' : 'Select Bay'}
          options={pickerField === 'rack' ? rackOptions : bayOptions}
          selectedValue={pickerField === 'rack' ? rackCode : bayCode}
          onSelect={(v) => (pickerField === 'rack' ? handlePickRack(v) : handlePickBay(v))}
          onClose={() => setPickerField(null)}
        />
      ) : null}

      <Modal visible={skuPanelOpen} transparent animationType="slide" onRequestClose={() => setSkuPanelOpen(false)}>
        <Pressable style={[styles.backdrop, { backgroundColor: tokens.scrim }]} onPress={() => setSkuPanelOpen(false)}>
          <Pressable
            style={[styles.skuPanel, { backgroundColor: tokens.card, borderTopLeftRadius: tokens.radius.xxl, borderTopRightRadius: tokens.radius.xxl }]}
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
            <ScrollView style={{ maxHeight: 360 }} contentContainerStyle={{ gap: 10, paddingBottom: 10 }}>
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

function ToolbarField({ label, fixed, tag, onPress }: { label: string; fixed?: boolean; tag?: string; onPress?: () => void }) {
  const { tokens } = useTheme();
  const content = (
    <View style={[styles.toolbarField, { backgroundColor: fixed ? tokens.muted : tokens.card, borderColor: tokens.border, borderRadius: tokens.radius.lg }]}>
      <Text style={{ color: tokens.foreground, fontSize: tokens.text.xs }} numberOfLines={1}>
        {label}
      </Text>
      {tag ? <Pill label={tag} tone={STATUS_TONE[tag as keyof typeof STATUS_TONE] ?? 'To Do'} /> : null}
      {!fixed ? <Ionicons name="chevron-down" size={14} color={tokens.mutedForeground} /> : null}
    </View>
  );
  return fixed ? content : <Pressable onPress={onPress}>{content}</Pressable>;
}

const styles = StyleSheet.create({
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  toolbar: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  toolbarField: { flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: 1, paddingHorizontal: 10, height: 36, minWidth: 70 },
  scanIconBtn: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  body: { padding: 16 },
  diagram: { gap: 4 },
  diagramRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  diagramCells: { flexDirection: 'row', gap: 6, flex: 1 },
  cell: { width: 26, height: 18, borderWidth: 1, borderRadius: 3 },
  cellEmpty: { borderStyle: 'dashed', opacity: 0.4 },
  diagramActions: { flexDirection: 'row', gap: 10, marginTop: 16 },
  outlineBtn: { flex: 1, height: 44, alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
  primaryBtn: { flex: 1, flexDirection: 'row', height: 44, alignItems: 'center', justifyContent: 'center', gap: 6 },
  backdrop: { flex: 1, justifyContent: 'flex-end' },
  skuPanel: { maxHeight: '80%', padding: 16 },
  skuPanelHead: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 14 },
  skuPanelFooter: { flexDirection: 'row', gap: 10, marginTop: 12 },
});
