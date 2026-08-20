import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import { AppHeader } from '@/components/AppHeader';
import { BarcodeScannerModal } from '@/components/BarcodeScannerModal';
import { Card } from '@/components/Card';
import { EvidenceBlock } from '@/components/EvidenceBlock';
import { NewAttachmentModal } from '@/components/NewAttachmentModal';
import type { SheetOption } from '@/components/BottomSheetPicker';
import { InlineDropdown, ToolbarField } from '@/components/ToolbarDropdownField';
import { useAuditProgressMap } from '@/hooks/useLocationsTree';
import { expectedZoneForSku, FLOOR_AREAS, generateWaveformBars, INVENTORY_POOL } from '@/lib/mockData';
import { CONDITIONS, type Condition, type Evidence } from '@/lib/types';
import { useTheme } from '@/theme/ThemeProvider';
import { useAudits } from '../dashboard/hooks';

// Every physical pallet's QR carries its own unique label (a real print
// job never puts the exact same code on two different boxes) even though
// many pallets share the same SKU/name — so "how many SKU-1001s have
// actually been found" has to count distinct labels, not raw scan events.
// Scanning the same physical QR ten times in a row is still one pallet.
// qtyIssueRaised/conditionIssueRaised + their Evidence mirror Rack View's
// Reconciliation Form field-by-field structure (per-field Raise Issue,
// per-field Evidence) rather than one combined issue for the whole line.
type ZoneScanLine = {
  sku: string;
  name: string;
  label: string;
  qty: number;
  condition: Condition;
  palletConditionGood?: boolean | null;
  qtyIssueRaised?: boolean;
  conditionIssueRaised?: boolean;
  locationIssueRaised?: boolean;
  qtyEvidence?: Evidence;
  conditionEvidence?: Evidence;
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
  const { auditId } = useLocalSearchParams<{ auditId: string }>();
  const { data: audits = [] } = useAudits();
  const audit = audits.find((a) => a.audit_id === auditId);
  const { map } = useAuditProgressMap(audits.map((a) => a.audit_id));

  const [selectedZoneId, setSelectedZoneId] = useState<string | null>(null);
  const [skuPanelOpen, setSkuPanelOpen] = useState(false);
  const [zoneField, setZoneField] = useState(false);
  const [scannedByZone, setScannedByZone] = useState<Record<string, ZoneScanLine[]>>({});
  const [currentLine, setCurrentLine] = useState<ZoneScanLine | null>(null);
  const [qtyText, setQtyText] = useState('1');
  const [scannerOpen, setScannerOpen] = useState(false);
  // 'all' = the tabbed Scanned Records page (every zone, opened from the
  // top toolbar); 'zone' = the Reconciliation Form's own list, locked to
  // whichever zone is currently selected — no tab switching there, since
  // it's meant to answer "what have I found here", not "everywhere".
  const [listView, setListView] = useState<'all' | 'zone' | null>(null);
  const [skuScanCount, setSkuScanCount] = useState(0);
  const [duplicateLabel, setDuplicateLabel] = useState<string | null>(null);
  const [attachmentTarget, setAttachmentTarget] = useState<'qty' | 'condition' | null>(null);

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

  const inScope = (label: string) => audit.scope_values.includes(label);
  const selectedZone = selectedZoneId ? FLOOR_AREAS.find((z) => z.id === selectedZoneId) : null;
  const zoneOptions: SheetOption[] = FLOOR_AREAS.filter((z) => inScope(z.label)).map((z) => ({ value: z.id, label: z.label }));
  // Combined total across every zone this audit covers (e.g. Zone A +
  // Staging Area) — badges the toolbar's "all zones" list icon and drives
  // the Scanned Records page's own combined line.
  const allZonesTotal = zoneOptions.reduce((sum, opt) => sum + (scannedByZone[opt.value]?.length ?? 0), 0);
  const allZonesLabel = zoneOptions.map((opt) => opt.label).join(' + ');

  const pickZone = (id: string) => {
    const zone = FLOOR_AREAS.find((z) => z.id === id);
    if (!zone || !inScope(zone.label)) return;
    setSelectedZoneId(id);
    setSkuPanelOpen(true);
    setCurrentLine(null);
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

  const applyScan = (pick: { sku: string; name: string }, label: string) => {
    setCurrentLine({ sku: pick.sku, name: pick.name, label, qty: 1, condition: 'Good' });
    setQtyText('1');
  };
  // A real pallet QR is "<sku>::<unique label>" — the sku identifies what
  // it is, the label identifies this one specific physical box. A QR with
  // no "::" (an older single-sku code) falls back to the raw scanned text
  // as its own label, so it still behaves as one distinct box rather than
  // crashing or silently losing the dedup entirely.
  const handleScanned = (data: string) => {
    setScannerOpen(false);
    const raw = data.trim();
    const [skuPart, labelPart] = raw.includes('::') ? raw.split('::') : [raw, raw];
    // Catch the re-scan at intake, before it ever reaches the zone's list —
    // a duplicate never gets a chance to inflate a count or need its own
    // bucket on the list page, it's just refused with a way to retry.
    const existing = selectedZoneId ? (scannedByZone[selectedZoneId] ?? []) : [];
    if (existing.some((l) => l.label === labelPart)) {
      setDuplicateLabel(labelPart);
      return;
    }
    const pick = INVENTORY_POOL.find((p) => p.sku === skuPart) ?? { sku: skuPart, name: 'Unlisted SKU' };
    applyScan(pick, labelPart);
  };
  const handleSimulated = () => {
    setScannerOpen(false);
    applyScan(INVENTORY_POOL[skuScanCount % INVENTORY_POOL.length], `SIM-${skuScanCount}`);
    setSkuScanCount((c) => c + 1);
  };

  // Saves the current scan onto this zone's list and immediately clears
  // the scan target so the inspector can go straight into the next one —
  // same "Save & Scan Next" rhythm as Rack View, just accumulating into a
  // list instead of moving to a different pallet each time.
  const handleSaveAndScanNext = () => {
    if (!currentLine || !selectedZoneId) return;
    const n = parseInt(qtyText, 10);
    const qty = Number.isNaN(n) ? 1 : Math.max(1, n);
    setScannedByZone((prev) => ({ ...prev, [selectedZoneId]: [...(prev[selectedZoneId] ?? []), { ...currentLine, qty }] }));
    setCurrentLine(null);
    setQtyText('1');
  };

  const zoneScans = selectedZoneId ? (scannedByZone[selectedZoneId] ?? []) : [];

  // Where this scanned SKU is actually supposed to be, per the admin app's
  // per-zone pick list — a scan that doesn't match the zone currently
  // selected is a location mismatch regardless of the SKU's identity/name
  // being perfectly legible; it just belongs somewhere else.
  const currentExpectedZone = currentLine ? expectedZoneForSku(currentLine.sku) : null;
  const currentMismatch = !!currentExpectedZone && !!selectedZone && currentExpectedZone !== selectedZone.label;

  // Quantity and Pallet Condition are independent findings on a box —
  // same split as Rack View's Reconciliation Form (qtyEvidence/
  // damageEvidence kept separately on the live line, not one shared blob).
  const ensureFieldEvidence = (field: 'qtyEvidence' | 'conditionEvidence'): Evidence =>
    currentLine?.[field] ?? { note: '', noteOpen: false, audio: null, images: [], videos: [] };
  const updateFieldEvidence = (field: 'qtyEvidence' | 'conditionEvidence', patch: Partial<Evidence>) => {
    if (!currentLine) return;
    setCurrentLine({ ...currentLine, [field]: { ...ensureFieldEvidence(field), ...patch } });
  };
  const raiseFieldIssue = (field: 'qtyIssueRaised' | 'conditionIssueRaised' | 'locationIssueRaised') => {
    if (!currentLine) return;
    setCurrentLine({ ...currentLine, [field]: true });
  };

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
    const foundBoxes = zoneScans.map((line) => {
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
      // Default per box is qty 1 / condition Good — anything else means
      // the inspector actually typed something in for this specific box.
      const qtyEntered = line.qty !== 1;
      const damageEntered = line.condition !== 'Good';
      return { ...line, homeZone, group, badge, tag, qtyEntered, damageEntered };
    });
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
            sub={`${zoneScans.length} scan${zoneScans.length === 1 ? '' : 's'} in this zone`}
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
                const zoneCount = (scannedByZone[opt.value] ?? []).length;
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
                              pretend otherwise with a name or a box/qty line.
                              Qty/Damage only appear if the inspector actually
                              entered something beyond the plain default. */}
                          {s.group === 'No Record' ? (
                            s.qtyEntered || s.damageEntered ? (
                              <View style={styles.miniBody}>
                                <View style={styles.miniGrid}>
                                  {s.qtyEntered ? <MiniField label="Qty" value={String(s.qty)} /> : null}
                                  {s.damageEntered ? <MiniField label="Damage" value={s.condition} tone={tokens.rag.amber.strong} /> : null}
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
                                <MiniField label="Qty" value={String(s.qty)} />
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

  return (
    <View style={{ flex: 1, backgroundColor: tokens.muted }}>
      <AppHeader title="Zone Scan" sub={`${audit.audit_id} · ${audit.audit_name}`} showBack />

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
                          const count = scannedByZone[zone.id]?.length ?? 0;
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
            <Card style={styles.formCard}>
              <View style={[styles.formHead, { backgroundColor: '#F7F8FA', borderBottomColor: tokens.border }]}>
                <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm }}>Reconciliation Form</Text>
                <Pressable onPress={() => setListView('zone')} hitSlop={8} style={[styles.listIconBtn, { backgroundColor: tokens.card, borderColor: tokens.border, borderRadius: tokens.radius.lg }]}>
                  <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.semibold, fontSize: tokens.text.xs }}>Scanned List</Text>
                  <View style={{ position: 'relative' }}>
                    <Ionicons name="list-outline" size={16} color={tokens.foreground} />
                    {zoneScans.length ? (
                      <View style={[styles.listCountDot, { backgroundColor: tokens.primary }]}>
                        <Text style={{ color: tokens.primaryForeground, fontSize: 9, fontWeight: tokens.fontWeight.bold }}>{zoneScans.length}</Text>
                      </View>
                    ) : null}
                  </View>
                </Pressable>
              </View>

              {/* The zone name used to live in the header ("Zone Scan — Zone
                  A"); now that the form has one fixed title, it's a field
                  inside the form body instead, visible whether or not a
                  box is currently being scanned. */}
              <View style={[styles.locationFieldRow, { borderBottomColor: tokens.border }]}>
                <Ionicons name="location-outline" size={14} color={tokens.mutedForeground} />
                <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xs }}>Location</Text>
                <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm }}>{selectedZone.label}</Text>
              </View>

              <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 14, gap: 10 }}>
                {!currentLine ? (
                  <>
                    <Pressable
                      onPress={() => setScannerOpen(true)}
                      style={[styles.scanDottedBox, { borderColor: tokens.mutedForeground, borderRadius: tokens.radius.xl }]}
                    >
                      <View style={[styles.scanDottedIconWrap, { backgroundColor: tokens.primary }]}>
                        <Ionicons name="qr-code-outline" size={26} color={tokens.primaryForeground} />
                      </View>
                      <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.semibold, fontSize: tokens.text.sm, marginTop: 10 }}>Tap to Scan SKU</Text>
                    </Pressable>
                    <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xs, textAlign: 'center' }}>
                      Scans whatever pallet is actually sitting in this zone — there's no specific pallet expected here.
                    </Text>
                  </>
                ) : (
                  <>
                    <View style={[styles.fieldCard, { backgroundColor: tokens.card, borderColor: tokens.border, borderRadius: tokens.radius.xl }]}>
                      <View style={styles.fieldCardBody}>
                        <View style={styles.statusPillRow}>
                          <View
                            style={[
                              styles.editStatusPill,
                              {
                                backgroundColor: currentMismatch ? tokens.rag.red.soft : tokens.rag.green.soft,
                                borderColor: currentMismatch ? tokens.rag.red.border : tokens.rag.green.border,
                                borderRadius: tokens.radius.lg,
                              },
                            ]}
                          >
                            <Text style={{ color: currentMismatch ? tokens.rag.red.strong : tokens.rag.green.strong, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.xs }}>
                              {currentMismatch ? 'Location Mismatch' : currentExpectedZone ? 'Matched' : 'No Expectation on Record'}
                            </Text>
                          </View>
                        </View>
                        <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm }}>{currentLine.sku}</Text>
                        <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xs }}>{currentLine.name}</Text>
                        <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xxs, marginTop: 2 }}>Label: {currentLine.label}</Text>
                        <View style={styles.compareRow}>
                          <View style={[styles.compareCol, { backgroundColor: tokens.muted, borderColor: tokens.border }]}>
                            <Text style={{ color: tokens.mutedForeground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.xxs, textTransform: 'uppercase' }}>
                              Expected Zone
                            </Text>
                            <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm, marginTop: 4 }}>
                              {currentExpectedZone ?? 'Not on record'}
                            </Text>
                          </View>
                          <View style={[styles.compareCol, { backgroundColor: tokens.muted, borderColor: tokens.border }]}>
                            <Text style={{ color: tokens.mutedForeground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.xxs, textTransform: 'uppercase' }}>
                              Location
                            </Text>
                            <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm, marginTop: 4 }}>{selectedZone.label}</Text>
                          </View>
                        </View>
                      </View>
                    </View>

                    {currentMismatch ? (
                      // Wrong location is known the instant the scan
                      // resolves — nothing to enter, so this raises the
                      // issue directly rather than opening the qty/
                      // condition fields (same pattern as Rack View's
                      // misplaced-SKU case).
                      <Pressable
                        disabled={!!currentLine.locationIssueRaised}
                        onPress={() => raiseFieldIssue('locationIssueRaised')}
                        style={[
                          styles.raiseIssueBox,
                          {
                            backgroundColor: currentLine.locationIssueRaised ? tokens.rag.green.soft : tokens.rag.red.soft,
                            borderColor: currentLine.locationIssueRaised ? tokens.rag.green.border : tokens.rag.red.border,
                            borderRadius: tokens.radius.lg,
                          },
                        ]}
                      >
                        <Ionicons name={currentLine.locationIssueRaised ? 'checkmark-circle' : 'flag'} size={18} color={currentLine.locationIssueRaised ? tokens.rag.green.strong : tokens.rag.red.strong} />
                        <Text style={{ color: currentLine.locationIssueRaised ? tokens.rag.green.strong : tokens.rag.red.strong, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm, flex: 1 }}>
                          {currentLine.locationIssueRaised ? 'Issue raised for this box' : 'Raise Issue — wrong location'}
                        </Text>
                        {!currentLine.locationIssueRaised ? (
                          <Text style={{ color: tokens.rag.red.strong, fontWeight: tokens.fontWeight.semibold, fontSize: tokens.text.xs }}>Tap to raise</Text>
                        ) : null}
                      </Pressable>
                    ) : (
                      // Matched — same three-part Reconciliation Form as
                      // Rack View: a quick borderless Pallet Condition
                      // gate, then Quantity and Damage as two independent
                      // findings, each with its own entry, Raise Issue,
                      // and Evidence.
                      <>
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
                                const selected = currentLine.palletConditionGood === opt.value;
                                return (
                                  <Pressable
                                    key={opt.label}
                                    onPress={() => setCurrentLine((prev) => (prev ? { ...prev, palletConditionGood: opt.value } : prev))}
                                    style={styles.condChip}
                                  >
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

                        <View style={[styles.fieldCard, { backgroundColor: tokens.card, borderColor: tokens.border, borderRadius: tokens.radius.xl }]}>
                          <View style={[styles.fieldCardHead, { backgroundColor: '#F7F8FA', borderBottomColor: tokens.border }]}>
                            <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm }}>Issue For 1: Quantity</Text>
                          </View>
                          <View style={styles.fieldCardBody}>
                            <TextInput
                              value={qtyText}
                              onChangeText={setQtyText}
                              keyboardType="number-pad"
                              placeholderTextColor={tokens.slate400}
                              style={[styles.qtyInput, { color: tokens.foreground, borderColor: tokens.border, backgroundColor: tokens.inputBackground, borderRadius: tokens.radius.lg }]}
                            />
                            <Pressable
                              disabled={!!currentLine.qtyIssueRaised}
                              onPress={() => raiseFieldIssue('qtyIssueRaised')}
                              style={[
                                styles.raiseIssueBox,
                                {
                                  marginTop: 10,
                                  backgroundColor: currentLine.qtyIssueRaised ? tokens.rag.green.soft : tokens.rag.amber.soft,
                                  borderColor: currentLine.qtyIssueRaised ? tokens.rag.green.border : tokens.rag.amber.border,
                                  borderRadius: tokens.radius.lg,
                                },
                              ]}
                            >
                              <Ionicons name={currentLine.qtyIssueRaised ? 'checkmark-circle' : 'flag-outline'} size={16} color={currentLine.qtyIssueRaised ? tokens.rag.green.strong : tokens.rag.amber.strong} />
                              <Text style={{ color: currentLine.qtyIssueRaised ? tokens.rag.green.strong : tokens.rag.amber.strong, fontWeight: tokens.fontWeight.semibold, fontSize: tokens.text.xs, flex: 1 }}>
                                {currentLine.qtyIssueRaised ? 'Issue raised for quantity' : 'Raise Issue — quantity'}
                              </Text>
                            </Pressable>
                            <Text style={{ color: tokens.mutedForeground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.xxs, textTransform: 'uppercase', marginTop: 10 }}>
                              Evidence
                            </Text>
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
                          </View>
                          <View style={styles.fieldCardBody}>
                            <View style={styles.condGrid}>
                              {CONDITIONS.map((c) => {
                                const sel = currentLine.condition === c;
                                return (
                                  <Pressable key={c} onPress={() => setCurrentLine((prev) => (prev ? { ...prev, condition: c } : prev))} style={styles.condChip}>
                                    <View style={[styles.radioDot, { borderColor: sel ? tokens.primary : tokens.slate400 }]}>
                                      {sel ? <View style={[styles.radioDotFill, { backgroundColor: tokens.primary }]} /> : null}
                                    </View>
                                    <Text style={{ color: tokens.foreground, fontSize: tokens.text.xs }}>{c}</Text>
                                  </Pressable>
                                );
                              })}
                            </View>
                            <Pressable
                              disabled={!!currentLine.conditionIssueRaised}
                              onPress={() => raiseFieldIssue('conditionIssueRaised')}
                              style={[
                                styles.raiseIssueBox,
                                {
                                  marginTop: 10,
                                  backgroundColor: currentLine.conditionIssueRaised ? tokens.rag.green.soft : tokens.rag.amber.soft,
                                  borderColor: currentLine.conditionIssueRaised ? tokens.rag.green.border : tokens.rag.amber.border,
                                  borderRadius: tokens.radius.lg,
                                },
                              ]}
                            >
                              <Ionicons name={currentLine.conditionIssueRaised ? 'checkmark-circle' : 'flag-outline'} size={16} color={currentLine.conditionIssueRaised ? tokens.rag.green.strong : tokens.rag.amber.strong} />
                              <Text style={{ color: currentLine.conditionIssueRaised ? tokens.rag.green.strong : tokens.rag.amber.strong, fontWeight: tokens.fontWeight.semibold, fontSize: tokens.text.xs, flex: 1 }}>
                                {currentLine.conditionIssueRaised ? 'Issue raised for damage' : 'Raise Issue — damage'}
                              </Text>
                            </Pressable>
                            <Text style={{ color: tokens.mutedForeground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.xxs, textTransform: 'uppercase', marginTop: 10 }}>
                              Evidence
                            </Text>
                            <EvidenceBlock
                              evidence={ensureFieldEvidence('conditionEvidence')}
                              onOpenNote={() => updateFieldEvidence('conditionEvidence', { noteOpen: true })}
                              onChangeNote={(note) => updateFieldEvidence('conditionEvidence', { note })}
                              onRecordAudio={() => updateFieldEvidence('conditionEvidence', { audio: { durationSec: 20, playing: false, bars: generateWaveformBars() } })}
                              onToggleAudioPlay={() => {
                                const ev = ensureFieldEvidence('conditionEvidence');
                                if (!ev.audio) return;
                                updateFieldEvidence('conditionEvidence', { audio: { ...ev.audio, playing: !ev.audio.playing } });
                              }}
                              onRemoveAudio={() => updateFieldEvidence('conditionEvidence', { audio: null })}
                              onAddImage={() => setAttachmentTarget('condition')}
                              onRemoveImage={(i) => updateFieldEvidence('conditionEvidence', { images: ensureFieldEvidence('conditionEvidence').images.filter((_, ii) => ii !== i) })}
                              onAddVideo={() => updateFieldEvidence('conditionEvidence', { videos: [...ensureFieldEvidence('conditionEvidence').videos, { durationSec: 20 }] })}
                              onRemoveVideo={(i) => updateFieldEvidence('conditionEvidence', { videos: ensureFieldEvidence('conditionEvidence').videos.filter((_, ii) => ii !== i) })}
                            />
                          </View>
                        </View>
                      </>
                    )}
                  </>
                )}
              </ScrollView>

              <View style={[styles.formFooter, { borderTopColor: tokens.border }]}>
                <Pressable
                  onPress={() => {
                    setSkuPanelOpen(false);
                    setCurrentLine(null);
                  }}
                  style={[styles.outlineBtn, { backgroundColor: tokens.muted, borderColor: tokens.border, borderRadius: tokens.radius.lg }]}
                >
                  <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.semibold, fontSize: tokens.text.sm }}>Cancel</Text>
                </Pressable>
                <Pressable
                  disabled={!currentLine}
                  onPress={handleSaveAndScanNext}
                  style={[styles.primaryBtn, { backgroundColor: tokens.primary, borderRadius: tokens.radius.lg, opacity: currentLine ? 1 : 0.5 }]}
                >
                  <Text style={{ color: tokens.primaryForeground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm }}>Save & Scan Next</Text>
                </Pressable>
              </View>
            </Card>
          ) : null}
        </View>
      </View>

      <BarcodeScannerModal
        visible={scannerOpen}
        title="Scan SKU"
        hint="Point at the SKU QR code on the pallet"
        onScanned={handleScanned}
        onUseSimulated={handleSimulated}
        onClose={() => setScannerOpen(false)}
      />

      <NewAttachmentModal
        visible={attachmentTarget !== null}
        onClose={() => setAttachmentTarget(null)}
        onSave={(image) => {
          if (attachmentTarget === null) return;
          const field = attachmentTarget === 'qty' ? 'qtyEvidence' : 'conditionEvidence';
          updateFieldEvidence(field, { images: [...ensureFieldEvidence(field).images, image] });
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
  formCard: { flex: 1, padding: 0, overflow: 'hidden' },
  formHead: { minHeight: 52, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 14, paddingVertical: 12, borderBottomWidth: 1 },
  listIconBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, height: 34, paddingHorizontal: 10, borderWidth: 1 },
  listCountDot: { position: 'absolute', top: -4, right: -4, minWidth: 16, height: 16, borderRadius: 8, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 3 },
  scanDottedBox: { minHeight: 160, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderStyle: 'dashed', paddingVertical: 32, marginBottom: 10 },
  scanDottedIconWrap: { width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center' },
  fieldCard: { borderWidth: 1, overflow: 'hidden', borderRadius: 12 },
  fieldCardHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 14, paddingVertical: 10, borderBottomWidth: 1 },
  fieldCardBody: { padding: 14, gap: 6 },
  raiseIssueBox: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, padding: 12 },
  locationFieldRow: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, paddingVertical: 10, borderBottomWidth: 1 },
  statusPillRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 4 },
  editStatusPill: { alignSelf: 'flex-start', borderWidth: 1, paddingHorizontal: 10, paddingVertical: 5 },
  compareRow: { flexDirection: 'row', gap: 10, marginTop: 8 },
  compareCol: { flex: 1, borderWidth: 1, borderRadius: 12, padding: 10 },
  qtyInput: { height: 40, borderWidth: 1, paddingHorizontal: 12, fontSize: 14 },
  condGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  condChip: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 6 },
  radioDot: { width: 14, height: 14, borderRadius: 7, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  radioDotFill: { width: 7, height: 7, borderRadius: 3.5 },
  formFooter: { flexDirection: 'row', gap: 10, padding: 14, borderTopWidth: StyleSheet.hairlineWidth },
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
});
