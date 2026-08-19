import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import { AppHeader } from '@/components/AppHeader';
import { BarcodeScannerModal } from '@/components/BarcodeScannerModal';
import { Card } from '@/components/Card';
import type { SheetOption } from '@/components/BottomSheetPicker';
import { InlineDropdown, ToolbarField } from '@/components/ToolbarDropdownField';
import { useAuditProgressMap } from '@/hooks/useLocationsTree';
import { expectedZoneForSku, FLOOR_AREAS, INVENTORY_POOL, ZONE_EXPECTED_SKUS } from '@/lib/mockData';
import { CONDITIONS, type Condition } from '@/lib/types';
import { useTheme } from '@/theme/ThemeProvider';
import { useAudits } from '../dashboard/hooks';

// Every physical pallet's QR carries its own unique label (a real print
// job never puts the exact same code on two different boxes) even though
// many pallets share the same SKU/name — so "how many SKU-1001s have
// actually been found" has to count distinct labels, not raw scan events.
// Scanning the same physical QR ten times in a row is still one pallet.
type ZoneScanLine = { sku: string; name: string; label: string; qty: number; condition: Condition };
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
  const [listModalOpen, setListModalOpen] = useState(false);
  const [skuScanCount, setSkuScanCount] = useState(0);

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

  const pickZone = (id: string) => {
    const zone = FLOOR_AREAS.find((z) => z.id === id);
    if (!zone || !inScope(zone.label)) return;
    setSelectedZoneId(id);
    setSkuPanelOpen(true);
    setCurrentLine(null);
    setZoneField(false);
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

  // A full page, not a modal sheet — a zone can genuinely rack up a long
  // scan history, and a cramped sheet doesn't give that room to breathe.
  // Back arrow just returns to the canvas+form, same list state intact.
  if (listModalOpen && selectedZone) {
    const pickList = ZONE_EXPECTED_SKUS[selectedZone.label] ?? [];
    const pickListRows = pickList.map((expected) => {
      // Distinct labels only — re-scanning the same physical pallet's QR
      // any number of times still counts as one.
      const found = new Set(zoneScans.filter((l) => l.sku === expected.sku).map((l) => l.label)).size;
      return { ...expected, found, complete: found >= expected.expectedCount };
    });
    const skusComplete = pickListRows.filter((r) => r.complete).length;

    // Every distinct SKU found here that ISN'T on this zone's pick list —
    // whether it's expected somewhere else (Location Mismatch), has no
    // expectation on record anywhere, or isn't even in the inventory
    // catalog at all (Unlisted SKU).
    const expectedCodes = new Set(pickList.map((e) => e.sku));
    const otherMap = new Map<string, { sku: string; name: string; labels: Set<string> }>();
    zoneScans.forEach((l) => {
      if (expectedCodes.has(l.sku)) return;
      if (!otherMap.has(l.sku)) otherMap.set(l.sku, { sku: l.sku, name: l.name, labels: new Set() });
      otherMap.get(l.sku)!.labels.add(l.label);
    });
    const others = Array.from(otherMap.values());
    const mismatchCount = others.filter((o) => !!expectedZoneForSku(o.sku)).length;

    return (
      <View style={{ flex: 1, backgroundColor: tokens.muted }}>
        <AppHeader title={`Scanned in ${selectedZone.label}`} sub={`${zoneScans.length} scan${zoneScans.length === 1 ? '' : 's'}`} showBack onBack={() => setListModalOpen(false)} />
        <ScrollView contentContainerStyle={styles.listPageBody}>
          {/* Overall snapshot — how far along the pick list is, and
              whether anything unexpected turned up, before scrolling into
              the per-SKU detail below. */}
          {pickList.length ? (
            <View style={styles.summaryHeadRow}>
              <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.extrabold, fontSize: tokens.text.base }}>
                {skusComplete} of {pickList.length} SKUs Complete
              </Text>
              {mismatchCount ? <StatusBadge label={`${mismatchCount} Mismatch${mismatchCount === 1 ? '' : 'es'}`} ragKey="red" /> : null}
            </View>
          ) : null}

          {/* Pick list progress — just how many scans of each expected SKU
              have actually landed in this zone so far (not the expected
              count itself, that's only relevant to the admin app's pick
              list). Simple hug-content chips, not full-width cards — this
              is a quick tally, not detail worth a whole card each. */}
          {pickListRows.length ? (
            <View style={{ gap: 8 }}>
              <Text style={styles.sheetSectionLabel}>Pick List Progress</Text>
              <View style={styles.chipRow}>
                {pickListRows.map((row) => (
                  <View
                    key={row.sku}
                    style={[
                      styles.pickChip,
                      { borderColor: row.complete ? tokens.rag.green.border : tokens.rag.amber.border, backgroundColor: row.complete ? tokens.rag.green.soft : tokens.rag.amber.soft },
                    ]}
                  >
                    <Text style={{ color: row.complete ? tokens.rag.green.strong : tokens.rag.amber.strong, fontWeight: tokens.fontWeight.semibold, fontSize: tokens.text.xs }}>
                      {row.sku}
                    </Text>
                    <Text style={{ color: row.complete ? tokens.rag.green.strong : tokens.rag.amber.strong, fontWeight: tokens.fontWeight.extrabold, fontSize: tokens.text.sm }}>
                      {String(row.found).padStart(2, '0')}
                    </Text>
                  </View>
                ))}
              </View>
            </View>
          ) : null}

          {others.length ? (
            <View style={{ gap: 8 }}>
              <Text style={styles.sheetSectionLabel}>Other SKUs Found (Not on Pick List)</Text>
              <View style={styles.cardGrid}>
                {others.map((o) => {
                  const homeZone = expectedZoneForSku(o.sku);
                  const isUnlisted = !INVENTORY_POOL.some((p) => p.sku === o.sku);
                  const tag = homeZone ? `Belongs in ${homeZone}` : isUnlisted ? 'Unlisted SKU' : 'No Expectation on Record';
                  return (
                    <View key={o.sku} style={[styles.miniCard, { backgroundColor: tokens.card, borderColor: tokens.border, borderRadius: tokens.radius.lg }]}>
                      <View style={[styles.miniHeadRow, { backgroundColor: '#EEF3FF', borderTopLeftRadius: tokens.radius.lg, borderTopRightRadius: tokens.radius.lg }]}>
                        <View style={styles.miniHeadLeft}>
                          <Ionicons name={homeZone ? 'swap-horizontal-outline' : 'help-circle-outline'} size={12} color={tokens.primary} />
                          <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.xs }} numberOfLines={1}>{o.sku}</Text>
                        </View>
                        <StatusBadge label={homeZone ? 'Mismatch' : isUnlisted ? 'Unlisted' : 'No Record'} ragKey={homeZone ? 'red' : 'amber'} compact />
                      </View>
                      <View style={styles.miniBody}>
                        <Text style={{ color: tokens.accentBlue.strong, fontWeight: tokens.fontWeight.semibold, fontSize: tokens.text.xxs, marginBottom: 6 }} numberOfLines={1}>
                          {o.name}
                        </Text>
                        <View style={styles.miniGrid}>
                          <MiniField label="Found" value={String(o.labels.size)} />
                          <MiniField label="Status" value={tag} />
                        </View>
                      </View>
                    </View>
                  );
                })}
              </View>
            </View>
          ) : null}

          <View style={{ gap: 8 }}>
            <Text style={styles.sheetSectionLabel}>All Scans</Text>
            {zoneScans.length ? (
              <View style={styles.cardGrid}>
                {zoneScans.map((line, i) => {
                  const lineExpectedZone = expectedZoneForSku(line.sku);
                  const lineMismatch = !!lineExpectedZone && lineExpectedZone !== selectedZone.label;
                  // Same physical pallet's QR scanned again — a repeat of an
                  // earlier entry with the same label, not a new box found.
                  const isDuplicate = zoneScans.findIndex((l) => l.label === line.label) !== i;
                  const badge = lineMismatch
                    ? { label: 'Mismatch', ragKey: 'red' as const }
                    : isDuplicate
                      ? { label: 'Duplicate', ragKey: 'amber' as const }
                      : { label: 'Matched', ragKey: 'green' as const };
                  return (
                    <View key={i} style={[styles.miniCard, { backgroundColor: tokens.card, borderColor: tokens.border, borderRadius: tokens.radius.lg }]}>
                      <View style={[styles.miniHeadRow, { backgroundColor: '#EEF3FF', borderTopLeftRadius: tokens.radius.lg, borderTopRightRadius: tokens.radius.lg }]}>
                        <View style={styles.miniHeadLeft}>
                          <Ionicons name="pricetag-outline" size={12} color={tokens.primary} />
                          <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.xs }} numberOfLines={1}>{line.label}</Text>
                        </View>
                        <StatusBadge label={badge.label} ragKey={badge.ragKey} compact />
                      </View>
                      <View style={styles.miniBody}>
                        <Text style={{ color: tokens.accentBlue.strong, fontWeight: tokens.fontWeight.semibold, fontSize: tokens.text.xxs, marginBottom: 6 }} numberOfLines={1}>
                          {line.sku} · {line.name}
                        </Text>
                        <View style={styles.miniGrid}>
                          <MiniField label="Qty" value={String(line.qty)} />
                          <MiniField label="Condition" value={line.condition} />
                        </View>
                        {lineMismatch ? (
                          <View style={[styles.miniLocationRow, { borderTopColor: tokens.border }]}>
                            <MiniField label="Location" value={`Belongs in ${lineExpectedZone}`} tone={tokens.rag.red.strong} />
                          </View>
                        ) : null}
                      </View>
                    </View>
                  );
                })}
              </View>
            ) : (
              <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.sm, textAlign: 'center', paddingVertical: 20 }}>Nothing scanned here yet.</Text>
            )}
          </View>
        </ScrollView>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: tokens.muted }}>
      <AppHeader title="Zone Scan" sub={`${audit.audit_id} · ${audit.audit_name}`} showBack />

      <View style={[styles.toolbar, { backgroundColor: tokens.card, borderBottomColor: tokens.border }]}>
        <View>
          <ToolbarField label={selectedZone ? selectedZone.label : 'Select Zone'} open={zoneField} onPress={() => setZoneField((v) => !v)} />
          {zoneField ? (
            <>
              <Pressable style={StyleSheet.absoluteFill} onPress={() => setZoneField(false)} />
              <InlineDropdown options={zoneOptions} selectedValue={selectedZoneId ?? ''} onSelect={pickZone} />
            </>
          ) : null}
        </View>
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
                        <Ionicons name="ellipse-outline" size={12} color={tokens.mutedForeground} />
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
                              <Ionicons name="ellipse-outline" size={20} color={selected ? '#1D4ED8' : active ? tokens.foreground : tokens.mutedForeground} />
                              <Text
                                style={{
                                  color: selected ? '#1D4ED8' : active ? tokens.foreground : tokens.mutedForeground,
                                  fontWeight: tokens.fontWeight.bold,
                                  fontSize: tokens.text.sm,
                                  marginTop: 6,
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
                <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm }}>Zone Scan — {selectedZone.label}</Text>
                <Pressable onPress={() => setListModalOpen(true)} hitSlop={8} style={[styles.listIconBtn, { backgroundColor: tokens.muted, borderRadius: tokens.radius.lg }]}>
                  <Ionicons name="list-outline" size={18} color={tokens.foreground} />
                  {zoneScans.length ? (
                    <View style={[styles.listCountDot, { backgroundColor: tokens.primary }]}>
                      <Text style={{ color: tokens.primaryForeground, fontSize: 9, fontWeight: tokens.fontWeight.bold }}>{zoneScans.length}</Text>
                    </View>
                  ) : null}
                </Pressable>
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
                      <Text style={{ color: tokens.mutedForeground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.xxs, textTransform: 'uppercase', marginTop: 6 }}>
                        Quantity
                      </Text>
                      <TextInput
                        value={qtyText}
                        onChangeText={setQtyText}
                        keyboardType="number-pad"
                        placeholderTextColor={tokens.slate400}
                        style={[styles.qtyInput, { color: tokens.foreground, borderColor: tokens.border, backgroundColor: tokens.inputBackground, borderRadius: tokens.radius.lg }]}
                      />
                      <Text style={{ color: tokens.mutedForeground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.xxs, textTransform: 'uppercase', marginTop: 6 }}>
                        Condition
                      </Text>
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
                    </View>
                  </View>
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
  listIconBtn: { width: 34, height: 34, alignItems: 'center', justifyContent: 'center' },
  listCountDot: { position: 'absolute', top: -4, right: -4, minWidth: 16, height: 16, borderRadius: 8, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 3 },
  scanDottedBox: { minHeight: 160, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderStyle: 'dashed', paddingVertical: 32, marginBottom: 10 },
  scanDottedIconWrap: { width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center' },
  fieldCard: { borderWidth: 1, overflow: 'hidden', borderRadius: 12 },
  fieldCardBody: { padding: 14, gap: 6 },
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
  sheetSectionLabel: { fontSize: 11, fontWeight: '700', color: '#8A94A3', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 6 },
  summaryHeadRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  statusBadge: { paddingHorizontal: 10, paddingVertical: 5 },
  statusBadgeCompact: { paddingHorizontal: 6, paddingVertical: 3 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  pickChip: { alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: 1, borderRadius: 20, paddingHorizontal: 8, paddingVertical: 6 },
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
  miniCard: { flexGrow: 1, flexBasis: 150, maxWidth: '48%', borderWidth: 1, overflow: 'hidden' },
  miniHeadRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 4, paddingHorizontal: 8, paddingVertical: 6 },
  miniHeadLeft: { flexDirection: 'row', alignItems: 'center', gap: 4, flexShrink: 1 },
  miniBody: { padding: 8 },
  miniGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  miniField: { gap: 1, flexShrink: 1, minWidth: 60 },
  miniLocationRow: { borderTopWidth: 1, borderTopColor: 'transparent', paddingTop: 6, marginTop: 6 },
});
