import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { AppHeader } from '@/components/AppHeader';
import { BarcodeScannerModal } from '@/components/BarcodeScannerModal';
import { Card } from '@/components/Card';
import { INVENTORY_POOL, SKU_ZONE_EXPECTATIONS } from '@/lib/mockData';
import { useQuickScanPinStore } from '@/store/useQuickScanPinStore';
import type { SkuScanCode } from '@/lib/types';
import { useTheme } from '@/theme/ThemeProvider';

function zoneLabel(zone: string): string {
  return zone.replace('Layout', 'Zone');
}

// A real scan is timestamped the moment the device's camera fires it —
// same as any handheld scanner or POS terminal — so this is just the
// device clock at scan time, not a simulated value.
function formatScanTime(ts: number): string {
  const d = new Date(ts);
  return `${d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })} · ${d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}`;
}

// Quick Scan — an inspector scans a SKU wherever it's actually found, on the
// open floor or inside a rack, and the app checks it against the WMS's
// expected zone for that SKU (SKU_ZONE_EXPECTATIONS). Neither a rack find
// nor a floor find reveals its location up front, even though a rack find's
// QR code already carries rack/bay/loc evidence — the inspector must always
// tap "Pin Exact Location" and mark it on the warehouse map themselves;
// only once pinned does the card reveal the location and whether it's a
// match (no issue) or a mismatch (issue raised). `inRack` is classification
// only (drives the card's "Rack Find"/"Floor Find" label and icon), never
// what's shown as the location.
type ScannedSku = {
  id: string;
  sku: string;
  name: string;
  inRack: boolean;
  expectedZone: string | null;
  matched: boolean | null; // null until pinned — either awaiting its pin, or pinned with no WMS expectation on record
  pinnedZone?: string;
  pinnedRack?: string;
  pinnedBay?: string;
  pinnedLoc?: string;
  pinnedAisle?: boolean;
  pinnedFloorAreaId?: string;
  issueRaised?: boolean;
  scannedAt: number; // device clock at the moment the camera scan fired
  pinnedAt?: number; // device clock at the moment the map pin was confirmed
};

export function QuickScanScreen() {
  const { tokens } = useTheme();
  const [items, setItems] = useState<ScannedSku[]>([]);
  const [scannerOpen, setScannerOpen] = useState(false);
  const idRef = useRef(0);
  const nextId = () => `s${idRef.current++}`;
  const openPin = useQuickScanPinStore((s) => s.openPin);
  const pinResult = useQuickScanPinStore((s) => s.result);
  const clearPin = useQuickScanPinStore((s) => s.clear);

  const processSkuCode = (code: SkuScanCode) => {
    const expectation = SKU_ZONE_EXPECTATIONS.find((e) => e.sku === code.sku);
    const inv = INVENTORY_POOL.find((p) => p.sku === code.sku);
    const name = expectation?.name ?? inv?.name ?? code.sku;
    const expectedZone = expectation?.expectedZone ?? null;
    setItems((prev) => [
      {
        id: nextId(),
        sku: code.sku,
        name,
        inRack: !!(code.rack || code.bay || code.loc),
        expectedZone,
        matched: null,
        scannedAt: Date.now(),
      },
      ...prev,
    ]);
  };

  // Real camera scan — a SKU's QR encodes JSON {sku} (plus zone) when found
  // on the open floor, or {sku,zone,rack,bay,loc} when found inside a rack.
  const handleRealScanned = (data: string) => {
    setScannerOpen(false);
    let parsed: Partial<SkuScanCode> | null = null;
    try {
      parsed = JSON.parse(data.trim());
    } catch {
      parsed = null;
    }
    if (!parsed || !parsed.sku) return;
    processSkuCode(parsed as SkuScanCode);
  };

  // "Pin Exact Location" now opens a full screen (dropdowns + a 3D-style
  // warehouse map), not a popup — the picked location comes back through
  // useQuickScanPinStore rather than a callback, since router.push() has
  // no return-value mechanism of its own.
  const handlePin = (item: ScannedSku) => {
    const scannedZoneCounts: Record<string, number> = {};
    items.forEach((it) => {
      if (it.pinnedZone) scannedZoneCounts[it.pinnedZone] = (scannedZoneCounts[it.pinnedZone] ?? 0) + 1;
    });
    openPin({ itemId: item.id, skuLabel: `${item.sku} · ${item.name}`, expectedZone: item.expectedZone, scannedZoneCounts });
    router.push('/pin-location');
  };

  // The pin is the ground truth itself, for a rack find and a floor find
  // alike — the zone/rack/bay the inspector picked (or tapped on the map)
  // is compared straight against the WMS's expected zone to decide match
  // (no issue) vs mismatch (issue raised).
  useEffect(() => {
    if (!pinResult) return;
    setItems((prev) =>
      prev.map((it) => {
        if (it.id !== pinResult.itemId) return it;
        const matched = it.expectedZone ? it.expectedZone === pinResult.zone : null;
        return {
          ...it,
          pinnedZone: pinResult.zone,
          pinnedRack: pinResult.rack,
          pinnedBay: pinResult.bay,
          pinnedLoc: pinResult.loc,
          pinnedAisle: pinResult.aisle,
          pinnedFloorAreaId: pinResult.floorAreaId,
          matched,
          issueRaised: matched === false,
          pinnedAt: Date.now(),
        };
      }),
    );
    clearPin();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pinResult]);

  return (
    <View style={{ flex: 1, backgroundColor: tokens.muted }}>
      <AppHeader title="Quick Scan" sub="Check any SKU against its expected zone" showBack menuItems={[{ label: 'Sync Now', onPress: () => {} }]} />

      {/* Compact scan bar, not a half-page panel — its only job is
          launching the camera, so it doesn't need to compete for space
          with the actual scanned records below it. */}
      <View style={[styles.scanBar, { backgroundColor: tokens.card, borderColor: tokens.border, borderRadius: tokens.radius.lg }]}>
        <View style={[styles.scanBarGlyph, { backgroundColor: tokens.muted }]}>
          <Ionicons name="camera-outline" size={18} color="#667085" />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm }}>Scan SKU</Text>
          <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xxs, marginTop: 1 }}>
            Check any SKU's floor or rack location against its expected zone
          </Text>
        </View>
        <Pressable onPress={() => setScannerOpen(true)} style={[styles.scanBarBtn, { backgroundColor: tokens.primary, borderRadius: tokens.radius.lg }]}>
          <Text style={{ color: tokens.primaryForeground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.xs }}>Scan</Text>
        </Pressable>
      </View>

      <View style={[styles.sectionHeadRow, { borderBottomColor: tokens.border, marginHorizontal: 16 }]}>
        <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.extrabold, fontSize: tokens.text.base }}>Scanned SKUs</Text>
        {items.length ? (
          <View style={[styles.countBadge, { backgroundColor: tokens.rag.green.soft, borderRadius: tokens.radius.sm }]}>
            <Text style={{ color: tokens.rag.green.strong, fontSize: tokens.text.xxs, fontWeight: tokens.fontWeight.bold }}>{items.length}</Text>
          </View>
        ) : null}
      </View>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.cardListContent}>
        {items.length ? (
          items.map((item) => <ScannedSkuCard key={item.id} item={item} onPin={() => handlePin(item)} />)
        ) : (
          <View style={styles.emptyState}>
            <Ionicons name="scan-outline" size={26} color="#667085" />
            <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.sm, textAlign: 'center' }}>Scanned SKUs will appear here.</Text>
          </View>
        )}
      </ScrollView>
      <BarcodeScannerModal
        visible={scannerOpen}
        title="Scan SKU"
        hint="Point at a SKU's zone or rack-location QR code"
        onScanned={handleRealScanned}
        onClose={() => setScannerOpen(false)}
      />
    </View>
  );
}

function ScannedSkuCard({ item, onPin }: { item: ScannedSku; onPin: () => void }) {
  const { tokens } = useTheme();
  const hasExpectation = item.expectedZone !== null;
  const resolved = item.matched !== null;
  const tone = !resolved ? tokens.accentBlue : item.matched ? tokens.rag.green : tokens.rag.amber;

  return (
    <Card>
      <View style={styles.cardTitleRow}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Ionicons name={item.inRack ? 'grid-outline' : 'cube-outline'} size={16} color={tokens.mutedForeground} />
          <Text style={{ color: tokens.mutedForeground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.xs }}>{item.inRack ? 'Rack Find' : 'Floor Find'}</Text>
        </View>
        <View style={[styles.statusBadge, { backgroundColor: tone.soft, borderRadius: tokens.radius.xl }]}>
          <Text style={{ color: tone.strong, fontSize: tokens.text.xs, fontWeight: tokens.fontWeight.bold }}>
            {!item.pinnedAt ? 'Pin Required' : !resolved ? 'No Expectation on Record' : item.matched ? 'Zone Matched' : 'Location Mismatch'}
          </Text>
        </View>
      </View>
      <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.base }}>{item.sku}</Text>
      <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xs, marginBottom: 4 }}>{item.name}</Text>
      <View style={styles.fieldGrid}>
        <Field label="Scanned" value={formatScanTime(item.scannedAt)} />
        {item.pinnedAt ? <Field label="Pinned" value={formatScanTime(item.pinnedAt)} /> : null}
        {hasExpectation ? <Field label="Expected Zone" value={zoneLabel(item.expectedZone as string)} /> : null}
        {/* Every location field stays hidden — for a rack find and a floor
            find alike — until the inspector pins it themselves; the card
            never hands over what the scan itself already knew. */}
        {item.pinnedFloorAreaId ? <Field label="Pinned Floor Area" value={item.pinnedZone ?? item.pinnedFloorAreaId} /> : null}
        {!item.pinnedFloorAreaId && item.pinnedZone ? <Field label="Pinned Zone" value={zoneLabel(item.pinnedZone)} /> : null}
        {item.pinnedRack ? <Field label="Pinned Rack" value={item.pinnedRack} /> : null}
        {item.pinnedAisle ? <Field label="Pinned Aisle" value={`Near Rack ${item.pinnedRack}`} /> : null}
        {item.pinnedBay ? <Field label="Pinned Bay" value={item.pinnedBay} /> : null}
        {item.pinnedLoc ? <Field label="Pinned Pallet" value={item.pinnedLoc} /> : null}
      </View>

      {/* Always offered until pinned, since the pin is what determines
          match/mismatch in the first place — for a rack find and a floor
          find alike. */}
      {!item.pinnedAt ? (
        <Pressable onPress={onPin} style={[styles.outlineBtn, { borderColor: tokens.border, borderRadius: tokens.radius.lg, marginTop: 10 }]}>
          <Ionicons name="location-outline" size={16} color={tokens.foreground} />
          <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.semibold, fontSize: tokens.text.sm }}>Pin Exact Location</Text>
        </Pressable>
      ) : null}
      {item.issueRaised && item.pinnedZone ? (
        <View style={[styles.pinnedBanner, { borderColor: tokens.border, marginTop: 10 }]}>
          <Ionicons name="alert-circle" size={16} color={tokens.rag.amber.strong} />
          <Text style={{ color: tokens.foreground, fontSize: tokens.text.xs, flex: 1 }}>
            Issue raised — found in{' '}
            <Text style={{ fontWeight: tokens.fontWeight.bold }}>
              {[
                zoneLabel(item.pinnedZone),
                item.pinnedRack ? `Rack ${item.pinnedRack}` : null,
                item.pinnedAisle ? 'Aisle' : item.pinnedBay ? `Bay ${item.pinnedBay}` : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </Text>
          </Text>
        </View>
      ) : null}
    </Card>
  );
}

function Field({ label, value, full }: { label: string; value: string; full?: boolean }) {
  const { tokens } = useTheme();
  return (
    <View style={full ? styles.fieldFull : styles.field}>
      <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xxs, marginBottom: 2 }}>{label}</Text>
      <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.semibold, fontSize: tokens.text.sm }} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  scanBar: { flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, padding: 10, margin: 16, marginBottom: 12 },
  scanBarGlyph: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  scanBarBtn: { paddingHorizontal: 16, height: 34, alignItems: 'center', justifyContent: 'center' },
  cardListContent: { padding: 16, paddingTop: 0, gap: 14, flexGrow: 1 },
  cardTitleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  sectionHeadRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingBottom: 12, marginBottom: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  countBadge: { paddingHorizontal: 8, paddingVertical: 2, minWidth: 22, alignItems: 'center' },
  fieldGrid: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 2 },
  field: { width: '50%', marginBottom: 8, paddingRight: 8 },
  fieldFull: { width: '100%', marginBottom: 8 },
  outlineBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, height: 44, borderWidth: 1 },
  banner: { borderWidth: 1, borderRadius: 10, padding: 12 },
  pinnedBanner: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderRadius: 10, padding: 10 },
  emptyState: { alignItems: 'center', justifyContent: 'center', gap: 10, paddingVertical: 40 },
  statusBadge: { paddingHorizontal: 10, paddingVertical: 4 },
});
