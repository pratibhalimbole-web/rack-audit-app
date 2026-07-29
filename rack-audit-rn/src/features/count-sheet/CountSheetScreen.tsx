import { Ionicons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { AppHeader } from '@/components/AppHeader';
import { BarcodeScannerModal } from '@/components/BarcodeScannerModal';
import { Card } from '@/components/Card';
import { SkuLineCard } from '@/components/SkuLineCard';
import { useDeviceClass } from '@/hooks/useDeviceClass';
import { useLocationsTree } from '@/hooks/useLocationsTree';
import { nextPending } from '@/lib/auditLogic';
import { findLocIn } from '@/lib/locationsRepo';
import { INVENTORY_POOL, QR_POOL } from '@/lib/mockData';
import type { Condition, CountLine, QrPayload } from '@/lib/types';
import { useAuthStore } from '@/store/useAuthStore';
import { useTheme } from '@/theme/ThemeProvider';
import { useConfirmDialog } from '@/hooks/useConfirmDialog';
import { useAudits } from '../dashboard/hooks';
import { useCountSheetMutations } from './mutations';
import { initLocSelect, applyFieldChange, type LocSelect } from './locationSelectLogic';
import { LocationPickerFields } from './LocationPickerFields';

type Params = { auditId: string; layout?: string; rack?: string; bay?: string; loc?: string };

function validateScanCode(tree: ReturnType<typeof useLocationsTree>['data'], code: QrPayload): { ok: boolean; reason?: string } {
  if (!tree) return { ok: false, reason: 'Location data is still loading.' };
  const layoutObj = tree.layouts.find((l) => l.name === code.layout);
  if (!layoutObj) {
    const assigned = tree.layouts.map((l) => l.name).join(', ') || 'no layout';
    return { ok: false, reason: `This code is for ${code.layout}, which isn't part of your assigned scope (${assigned}).` };
  }
  const rackObj = layoutObj.racks.find((r) => r.code === code.rack);
  if (!rackObj) return { ok: false, reason: `Rack ${code.rack} is not part of your assigned scope in ${code.layout}.` };
  const bayObj = rackObj.bays.find((b) => b.code === code.bay);
  if (!bayObj) return { ok: false, reason: `Bay ${code.bay} was not found under Rack ${code.rack} in your scope.` };
  const locObj = bayObj.locations.find((l) => l.code === code.loc);
  if (!locObj) return { ok: false, reason: `Storage Location ${code.loc} was not found under Bay ${code.bay}.` };
  return { ok: true };
}

// Ports renderCountSheet() (rack-audit-app.html ~3610-3797): the always-on
// location picker (manual fields or a simulated QR scan) followed by the
// scanning/counting tools once a location resolves. Real camera scanning is
// deferred to step 8 — both "scan" entry points here cycle a fixture pool,
// the same fallback the source itself used for its desktop-preview build.
export function CountSheetScreen() {
  const { tokens } = useTheme();
  const params = useLocalSearchParams<Params>();
  const { auditId, layout, rack, bay, loc } = params;
  const device = useDeviceClass();
  const isTablet = device === 'tablet';
  const inspector = useAuthStore((s) => s.inspector);
  const { data: audits } = useAudits();
  const audit = audits?.find((a) => a.audit_id === auditId);
  const { data: tree, isLoading } = useLocationsTree(auditId);
  const { saveRecord, completeLocation, deleteRecord, updateSavedLine } = useCountSheetMutations(auditId);

  const [locMode, setLocMode] = useState<'manual' | 'scan'>('manual');
  const [sel, setSel] = useState<LocSelect>({ layout: layout ?? null, rack: rack ?? null, bay: bay ?? null, loc: loc ?? null });
  const [scanCode, setScanCode] = useState<QrPayload | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [scanCycle, setScanCycle] = useState(0);
  const [scannerOpen, setScannerOpen] = useState<'location' | 'sku' | null>(null);
  const confirm = useConfirmDialog();

  const paramSeedKey = layout ? `${auditId}|${layout}|${rack}|${bay}|${loc}` : null;
  const seedKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (paramSeedKey && seedKeyRef.current !== paramSeedKey) {
      seedKeyRef.current = paramSeedKey;
      setSel({ layout: layout ?? null, rack: rack ?? null, bay: bay ?? null, loc: loc ?? null });
      setLocMode('manual');
      setScanCode(null);
      setScanError(null);
    }
  }, [paramSeedKey, layout, rack, bay, loc]);
  useEffect(() => {
    if (!tree || paramSeedKey) return;
    setSel((prev) => (prev.layout ? prev : initLocSelect(tree)));
  }, [tree, paramSeedKey]);

  const activeLoc: LocSelect | null =
    locMode === 'scan' ? (scanCode as LocSelect | null) : sel.layout && sel.rack && sel.bay && sel.loc ? sel : null;

  const locObj =
    tree && activeLoc && activeLoc.layout && activeLoc.rack && activeLoc.bay && activeLoc.loc
      ? findLocIn(tree, activeLoc.layout, activeLoc.rack, activeLoc.bay, activeLoc.loc)
      : undefined;

  const locKey = locObj && activeLoc ? `${activeLoc.layout}|${activeLoc.rack}|${activeLoc.bay}|${activeLoc.loc}` : null;
  const scanKeyRef = useRef<string | null>(null);
  const [scanPallet, setScanPallet] = useState<string | null>(null);
  const [scanLines, setScanLines] = useState<CountLine[]>([]);
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);
  const [skuScanCount, setSkuScanCount] = useState(0);
  const [expandedSavedPallet, setExpandedSavedPallet] = useState<string | null>(null);

  useEffect(() => {
    if (!locKey || !locObj) return;
    if (scanKeyRef.current === locKey) return;
    scanKeyRef.current = locKey;
    const existing = locObj.pallets.find((p) => !p.saved) ?? null;
    setScanPallet(existing ? existing.pallet : null);
    setScanLines(existing ? existing.lines.map((l) => ({ ...l })) : []);
    setExpandedIdx(null);
    setExpandedSavedPallet(null);
  }, [locKey, locObj]);

  if (!audit || isLoading || !tree) {
    return (
      <View style={[styles.loading, { backgroundColor: tokens.muted }]}>
        <ActivityIndicator color={tokens.primary} />
      </View>
    );
  }

  const scanManualToggle = (
    <View style={[styles.segmented, { borderColor: tokens.border, borderRadius: tokens.radius.lg }]}>
      <Pressable
        onPress={() => setLocMode('manual')}
        style={[styles.segmentBtn, locMode === 'manual' ? { backgroundColor: tokens.primary } : null]}
      >
        <Text style={{ color: locMode === 'manual' ? tokens.primaryForeground : tokens.foreground, fontSize: tokens.text.sm, fontWeight: tokens.fontWeight.semibold }}>
          Select Manually
        </Text>
      </Pressable>
      <Pressable
        onPress={() => setLocMode('scan')}
        style={[styles.segmentBtn, locMode === 'scan' ? { backgroundColor: tokens.primary } : null]}
      >
        <Text style={{ color: locMode === 'scan' ? tokens.primaryForeground : tokens.foreground, fontSize: tokens.text.sm, fontWeight: tokens.fontWeight.semibold }}>
          Scan QR Code
        </Text>
      </Pressable>
    </View>
  );

  const applyScannedLocationCode = (code: QrPayload) => {
    const result = validateScanCode(tree, code);
    if (result.ok) {
      setScanCode(code);
      setScanError(null);
    } else {
      setScanError(result.reason ?? 'Scan rejected.');
    }
  };

  const handleSimulatedLocationScan = () => {
    const code = QR_POOL[scanCycle % QR_POOL.length];
    setScanCycle((c) => c + 1);
    applyScannedLocationCode(code);
  };

  const handleRealLocationScanned = (data: string) => {
    setScannerOpen(null);
    let code: QrPayload | null = null;
    try {
      code = JSON.parse(data);
    } catch {
      code = null;
    }
    if (!code || !code.layout || !code.rack || !code.bay || !code.loc) {
      setScanError("That QR isn't a valid location code — expected JSON with layout/rack/bay/loc.");
      return;
    }
    applyScannedLocationCode(code);
  };

  const scanBlock =
    locMode === 'scan' ? (
      scanCode ? (
        <Card style={{ borderColor: tokens.rag.green.border, backgroundColor: tokens.rag.green.soft }}>
          <View style={styles.scannedHeadRow}>
            <Text style={{ color: tokens.rag.green.strong, fontWeight: tokens.fontWeight.extrabold, fontSize: tokens.text.base }}>Scanned Location</Text>
            <Ionicons name="checkmark-circle" size={20} color={tokens.rag.green.strong} />
          </View>
          <KvRow label="Layout" value={scanCode.layout} />
          <KvRow label="Rack" value={scanCode.rack} />
          <KvRow label="Bay" value={scanCode.bay} />
          <KvRow label="Storage Location" value={scanCode.loc} last />
          <Pressable onPress={() => setScannerOpen('location')} style={[styles.outlineBtn, { borderColor: tokens.border, borderRadius: tokens.radius.lg }]}>
            <Ionicons name="camera-outline" size={16} color={tokens.foreground} />
            <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.semibold, fontSize: tokens.text.sm }}>Scan Again / Rescan</Text>
          </Pressable>
        </Card>
      ) : (
        <View style={{ gap: 10 }}>
          <View style={[styles.scanBlock, { borderColor: tokens.border, borderRadius: tokens.radius.lg }]}>
            <View style={[styles.glyphCircle, { backgroundColor: tokens.muted }]}>
              <Ionicons name="camera-outline" size={22} color={tokens.mutedForeground} />
            </View>
            <Pressable onPress={() => setScannerOpen('location')} style={[styles.primarySmallBtn, { backgroundColor: tokens.primary, borderRadius: tokens.radius.lg }]}>
              <Text style={{ color: tokens.primaryForeground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm }}>Scan Location QR</Text>
            </Pressable>
          </View>
          {scanError ? (
            <View style={[styles.banner, { backgroundColor: tokens.rag.amber.soft, borderColor: tokens.rag.amber.border }]}>
              <Text style={{ color: tokens.rag.amber.strong, fontSize: tokens.text.sm }}>{scanError} Scan again with a code inside your assigned scope.</Text>
            </View>
          ) : (
            <View style={[styles.banner, { backgroundColor: tokens.accentBlue.soft, borderColor: tokens.accentBlue.border }]}>
              <Text style={{ color: tokens.accentBlue.strong, fontSize: tokens.text.sm }}>
                One QR on the storage location identifies its Layout, Rack, Bay and Storage Location all at once.
              </Text>
            </View>
          )}
        </View>
      )
    ) : (
      <LocationPickerFields tree={tree} sel={sel} onChange={setSel} />
    );

  const locationCard = (
    <Card>
      <View style={[styles.cardTitleRow, { borderBottomColor: tokens.border }]}>
        <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.extrabold, fontSize: tokens.text.base }}>Location</Text>
      </View>
      {scanManualToggle}
      {scanBlock}
    </Card>
  );

  if (!activeLoc) {
    return (
      <View style={{ flex: 1, backgroundColor: tokens.muted }}>
        <AppHeader
          title={audit.audit_name}
          sub={`${audit.audit_id} · Select a location to begin`}
          showBack
          menuItems={[{ label: 'Sync Now', onPress: () => {} }]}
        />
        <ScrollView contentContainerStyle={styles.body}>
          {locationCard}
          <View style={styles.emptyState}>
            <Ionicons name="location-outline" size={28} color={tokens.slate400} />
            <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.sm, textAlign: 'center' }}>
              Scanning and counting tools appear here once a location is picked.
            </Text>
          </View>
        </ScrollView>
      </View>
    );
  }

  if (!locObj) {
    return (
      <View style={{ flex: 1, backgroundColor: tokens.muted }}>
        <AppHeader
          title={audit.audit_name}
          sub={`${audit.audit_id} · Select a location to begin`}
          showBack
          menuItems={[{ label: 'Sync Now', onPress: () => {} }]}
        />
        <ScrollView contentContainerStyle={styles.body}>
          <View style={[styles.banner, { backgroundColor: tokens.rag.amber.soft, borderColor: tokens.rag.amber.border }]}>
            <Text style={{ color: tokens.rag.amber.strong, fontSize: tokens.text.sm }}>
              That location isn't in your assigned scope. Pick a different one below.
            </Text>
          </View>
          {locationCard}
        </ScrollView>
      </View>
    );
  }

  const readOnly = locObj.status === 'Completed';
  const savedPallets = locObj.pallets.filter((p) => p.saved);
  const canSave = scanLines.length > 0;
  const canComplete = scanLines.length === 0 && savedPallets.length > 0;
  const activeIdx = expandedIdx === -1 ? -1 : scanLines.length ? Math.min(expandedIdx ?? scanLines.length - 1, scanLines.length - 1) : -1;

  const ref = { auditId, layout: activeLoc.layout as string, rack: activeLoc.rack as string, bay: activeLoc.bay as string, loc: activeLoc.loc as string };

  const applyScannedSku = (pick: { sku: string; name: string; lot: string }) => {
    const dupIdx = scanLines.findIndex((l) => l.sku === pick.sku);
    if (dupIdx !== -1) {
      const next = scanLines.slice();
      next[dupIdx] = { ...next[dupIdx], qty: next[dupIdx].qty + 1 };
      setScanLines(next);
      setExpandedIdx(dupIdx);
    } else {
      setScanLines([...scanLines, { sku: pick.sku, name: pick.name, lot: pick.lot, qty: 1, condition: 'Good' }]);
      setExpandedIdx(scanLines.length);
    }
  };

  const handleSimulatedSkuScan = () => {
    const pick = INVENTORY_POOL[skuScanCount % INVENTORY_POOL.length];
    setSkuScanCount((c) => c + 1);
    applyScannedSku(pick);
  };

  const handleRealSkuScanned = (data: string) => {
    setScannerOpen(null);
    const code = data.trim();
    const pick = INVENTORY_POOL.find((p) => p.sku === code) ?? { sku: code, name: 'Unlisted SKU', lot: '—' };
    applyScannedSku(pick);
  };

  const handleRemoveLine = (idx: number) => {
    confirm.ask(`Remove ${scanLines[idx].sku} from this record?`, () => {
      setScanLines(scanLines.filter((_, i) => i !== idx));
      setExpandedIdx(null);
    });
  };

  const handleSaveRecord = async () => {
    await saveRecord(tree, ref, scanLines);
    setScanPallet(null);
    setScanLines([]);
    setExpandedIdx(null);
  };

  const handleCompleteLocation = async () => {
    await completeLocation(tree, ref);
    const next = nextPending(tree);
    if (next) {
      router.push({
        pathname: '/audit/[auditId]/count-sheet',
        params: { auditId, layout: next.layout, rack: next.rack, bay: next.bay, loc: next.loc.code },
      } as never);
    } else {
      router.push({ pathname: '/audit/[auditId]/summary', params: { auditId } } as never);
    }
  };

  const handleDeleteRecord = (pallet: string) => {
    confirm.ask(`Delete record ${pallet}? This can't be undone.`, () => deleteRecord(tree, ref, pallet));
  };

  return (
    <View style={{ flex: 1, backgroundColor: tokens.muted }}>
      <AppHeader title={locObj.code} sub={`${activeLoc.layout} · Rack ${activeLoc.rack} · Bay ${activeLoc.bay} · Blind Count`} showBack menuItems={[{ label: 'Sync Now', onPress: () => {} }]} />
      <ScrollView contentContainerStyle={styles.body}>
        {locationCard}

        {savedPallets.length ? (
          <Card>
            <View style={styles.savedHeadRow}>
              <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.extrabold, fontSize: tokens.text.base }}>Counted at This Location</Text>
              <View style={[styles.countBadge, { backgroundColor: tokens.rag.green.soft, borderRadius: tokens.radius.sm }]}>
                <Text style={{ color: tokens.rag.green.strong, fontSize: tokens.text.xxs, fontWeight: tokens.fontWeight.bold }}>
                  {savedPallets.length} record{savedPallets.length === 1 ? '' : 's'}
                </Text>
              </View>
            </View>
            <View style={{ gap: 8 }}>
              {savedPallets.map((p) => {
                const isOpen = expandedSavedPallet === p.pallet;
                return (
                  <View key={p.pallet} style={{ gap: 8 }}>
                    <Pressable
                      onPress={() => setExpandedSavedPallet(isOpen ? null : p.pallet)}
                      style={[styles.savedRow, { borderColor: tokens.border, borderRadius: tokens.radius.lg }]}
                    >
                      <Ionicons name="cube-outline" size={18} color={tokens.mutedForeground} />
                      <View style={{ flex: 1 }}>
                        <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm }}>{p.pallet}</Text>
                        <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xs }}>
                          {p.lines.length} SKU{p.lines.length === 1 ? '' : 's'}
                        </Text>
                      </View>
                      <Text style={{ color: tokens.primary, fontSize: tokens.text.xs, fontWeight: tokens.fontWeight.semibold }}>
                        {isOpen ? 'Done' : 'Edit'}
                      </Text>
                    </Pressable>
                    {isOpen
                      ? p.lines.map((line, li) => (
                          <SkuLineCard
                            key={li}
                            line={line}
                            active
                            disabled={readOnly}
                            onQtyChange={(qty) => updateSavedLine(tree, ref, p.pallet, li, { qty })}
                            onConditionChange={(condition: Condition) => updateSavedLine(tree, ref, p.pallet, li, { condition })}
                            onSave={() => setExpandedSavedPallet(null)}
                            onDelete={() => handleDeleteRecord(p.pallet)}
                            onEdit={() => {}}
                          />
                        ))
                      : null}
                  </View>
                );
              })}
            </View>
          </Card>
        ) : null}

        {readOnly ? (
          <View style={[styles.banner, { backgroundColor: tokens.rag.green.soft, borderColor: tokens.rag.green.border }]}>
            <Text style={{ color: tokens.rag.green.strong, fontSize: tokens.text.sm }}>This location is completed — read-only view.</Text>
          </View>
        ) : (
          <>
            {scanLines.length ? (
              <Card>
                <View style={styles.savedHeadRow}>
                  <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm }}>SKU / Lot Details</Text>
                  <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xs }}>{scanLines.length} scanned</Text>
                </View>
                <View style={{ gap: 10 }}>
                  {scanLines.map((line, idx) => (
                    <SkuLineCard
                      key={idx}
                      line={line}
                      active={idx === activeIdx}
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
                      onDelete={() => handleRemoveLine(idx)}
                      onEdit={() => setExpandedIdx(idx)}
                    />
                  ))}
                </View>
              </Card>
            ) : null}
            <View style={[styles.scanBlock, { borderColor: tokens.border, borderRadius: tokens.radius.lg }]}>
              <View style={[styles.glyphCircle, { backgroundColor: tokens.muted }]}>
                <Ionicons name="camera-outline" size={22} color={tokens.mutedForeground} />
              </View>
              <Pressable onPress={() => setScannerOpen('sku')} style={[styles.primarySmallBtn, { backgroundColor: tokens.primary, borderRadius: tokens.radius.lg }]}>
                <Text style={{ color: tokens.primaryForeground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm }}>Scan SKU</Text>
              </Pressable>
            </View>
          </>
        )}
      </ScrollView>
      <View style={[styles.footerBar, { backgroundColor: tokens.card, borderTopColor: tokens.border }]}>
        <Pressable
          onPress={() => router.push({ pathname: '/audit/[auditId]/progress', params: { auditId } } as never)}
          style={[styles.footerOutlineBtn, { borderColor: tokens.border, borderRadius: tokens.radius.lg }]}
        >
          <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.semibold, fontSize: tokens.text.sm }}>View Progress</Text>
        </Pressable>
        {scanLines.length ? (
          <Pressable disabled={!canSave} onPress={handleSaveRecord} style={[styles.footerPrimaryBtn, { backgroundColor: tokens.primary, borderRadius: tokens.radius.lg, opacity: canSave ? 1 : 0.5 }]}>
            <Text style={{ color: tokens.primaryForeground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm }}>Save Record</Text>
          </Pressable>
        ) : (
          <Pressable
            disabled={!canComplete}
            onPress={handleCompleteLocation}
            style={[styles.footerPrimaryBtn, { backgroundColor: tokens.primary, borderRadius: tokens.radius.lg, opacity: canComplete ? 1 : 0.5 }]}
          >
            <Text style={{ color: tokens.primaryForeground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm }}>Mark Complete</Text>
          </Pressable>
        )}
      </View>
      <BarcodeScannerModal
        visible={scannerOpen === 'location'}
        title="Scan Storage Location"
        hint="Point at the location QR code (Layout / Rack / Bay / Storage Location)"
        onScanned={handleRealLocationScanned}
        onUseSimulated={() => {
          setScannerOpen(null);
          handleSimulatedLocationScan();
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
      {confirm.element}
    </View>
  );
}

function KvRow({ label, value, last }: { label: string; value: string; last?: boolean }) {
  const { tokens } = useTheme();
  return (
    <View style={[styles.kvRow, last ? null : { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: tokens.rag.green.border }]}>
      <Text style={{ color: tokens.rag.green.strong, fontSize: tokens.text.xs }}>{label}</Text>
      <Text style={{ color: tokens.rag.green.strong, fontWeight: tokens.fontWeight.semibold, fontSize: tokens.text.sm }}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  body: { padding: 16, gap: 14, paddingBottom: 100 },
  cardTitleRow: { paddingBottom: 12, marginBottom: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  segmented: { flexDirection: 'row', borderWidth: 1, padding: 3, marginBottom: 14 },
  segmentBtn: { flex: 1, alignItems: 'center', justifyContent: 'center', height: 38, borderRadius: 6 },
  scanBlock: { alignItems: 'center', justifyContent: 'center', gap: 10, borderWidth: 1, borderStyle: 'dashed', padding: 20 },
  glyphCircle: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  primarySmallBtn: { paddingHorizontal: 20, height: 38, alignItems: 'center', justifyContent: 'center' },
  banner: { borderWidth: 1, borderRadius: 10, padding: 12 },
  scannedHeadRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  kvRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 8 },
  outlineBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, height: 40, borderWidth: 1, marginTop: 10 },
  emptyState: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, paddingVertical: 60 },
  savedHeadRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  countBadge: { paddingHorizontal: 10, paddingVertical: 3 },
  savedRow: { flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, padding: 12 },
  footerBar: { flexDirection: 'row', gap: 10, padding: 16, borderTopWidth: StyleSheet.hairlineWidth },
  footerOutlineBtn: { flex: 1, alignItems: 'center', justifyContent: 'center', height: 48, borderWidth: 1 },
  footerPrimaryBtn: { flex: 1, alignItems: 'center', justifyContent: 'center', height: 48 },
});
