import { Ionicons } from '@expo/vector-icons';
import { useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { AppHeader } from '@/components/AppHeader';
import { BarcodeScannerModal } from '@/components/BarcodeScannerModal';
import { Card } from '@/components/Card';
import { WarehouseMapModal } from '@/components/WarehouseMapModal';
import { INVENTORY_POOL, SKU_ZONE_EXPECTATIONS } from '@/lib/mockData';
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
// expected zone for that SKU (SKU_ZONE_EXPECTATIONS). A rack find already
// carries unambiguous evidence (rack/bay/loc), so its zone and match state
// show immediately. A floor find's zone is NOT shown up front — the
// inspector must tap "Pin Exact Location" and mark it on the warehouse map
// themselves; only once pinned does the card reveal the scanned zone and
// whether it's a match (no issue) or a mismatch (issue raised).
type ScannedSku = {
  id: string;
  sku: string;
  name: string;
  scannedZone?: string; // known immediately for a rack find; set only after pinning for a floor find
  rack?: string;
  bay?: string;
  loc?: string;
  expectedZone: string | null;
  matched: boolean | null; // null until determined — no WMS expectation, or a floor find awaiting its pin
  needsPin: boolean;
  pinnedZone?: string;
  issueRaised?: boolean;
  scannedAt: number; // device clock at the moment the camera scan fired
  pinnedAt?: number; // device clock at the moment the map pin was confirmed
};

export function QuickScanScreen() {
  const { tokens } = useTheme();
  const [items, setItems] = useState<ScannedSku[]>([]);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [mapTargetId, setMapTargetId] = useState<string | null>(null);
  const idRef = useRef(0);
  const nextId = () => `s${idRef.current++}`;

  const processSkuCode = (code: SkuScanCode) => {
    const expectation = SKU_ZONE_EXPECTATIONS.find((e) => e.sku === code.sku);
    const inv = INVENTORY_POOL.find((p) => p.sku === code.sku);
    const name = expectation?.name ?? inv?.name ?? code.sku;
    const expectedZone = expectation?.expectedZone ?? null;
    const inRack = !!(code.rack || code.bay || code.loc);
    setItems((prev) => [
      {
        id: nextId(),
        sku: code.sku,
        name,
        // A rack find's location is already unambiguous evidence, so reveal
        // it immediately; a floor find withholds it until the inspector
        // pins it themselves.
        scannedZone: inRack ? code.zone : undefined,
        rack: code.rack,
        bay: code.bay,
        loc: code.loc,
        expectedZone,
        matched: inRack ? (expectedZone && code.zone ? expectedZone === code.zone : null) : null,
        needsPin: !inRack,
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

  const mapTarget = mapTargetId ? items.find((it) => it.id === mapTargetId) : null;

  // A pin only ever applies to a floor find awaiting its zone — the
  // inspector's tap is the ground truth, compared straight against the
  // WMS's expected zone to decide match (no issue) vs mismatch (issue
  // raised), rather than trusting whatever the QR itself claimed.
  const handleConfirmPin = (zone: string) => {
    setItems((prev) =>
      prev.map((it) => {
        if (it.id !== mapTargetId) return it;
        const matched = it.expectedZone ? it.expectedZone === zone : null;
        return { ...it, scannedZone: zone, pinnedZone: zone, matched, needsPin: false, issueRaised: matched === false, pinnedAt: Date.now() };
      }),
    );
    setMapTargetId(null);
  };

  return (
    <View style={{ flex: 1, backgroundColor: tokens.muted }}>
      <AppHeader title="Quick Scan" sub="Check any SKU against its expected zone" showBack menuItems={[{ label: 'Sync Now', onPress: () => {} }]} />
      <View style={styles.splitRow}>
        <View style={styles.paneCol}>
          <Card style={{ flex: 1 }}>
            <View style={[styles.sectionHeadRow, { borderBottomColor: tokens.border }]}>
              <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.extrabold, fontSize: tokens.text.base }}>Scanned SKUs</Text>
              {items.length ? (
                <View style={[styles.countBadge, { backgroundColor: tokens.rag.green.soft, borderRadius: tokens.radius.sm }]}>
                  <Text style={{ color: tokens.rag.green.strong, fontSize: tokens.text.xxs, fontWeight: tokens.fontWeight.bold }}>{items.length}</Text>
                </View>
              ) : null}
            </View>
            <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.paneListContent}>
              {items.length ? (
                items.map((item) => <ScannedSkuCard key={item.id} item={item} onPin={() => setMapTargetId(item.id)} />)
              ) : (
                <View style={styles.emptyState}>
                  <Ionicons name="scan-outline" size={26} color="#667085" />
                  <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.sm, textAlign: 'center' }}>Scanned SKUs will appear here.</Text>
                </View>
              )}
            </ScrollView>
          </Card>
        </View>

        <View style={styles.paneCol}>
          <Card style={{ flex: 1 }}>
            <View style={[styles.sectionTitleRow, { borderBottomColor: tokens.border }]}>
              <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.extrabold, fontSize: tokens.text.base }}>Scan</Text>
            </View>
            <View style={[styles.scanBlock, { flex: 1, borderColor: tokens.border, borderRadius: tokens.radius.lg }]}>
              <View style={[styles.glyphCircle, { backgroundColor: tokens.muted }]}>
                <Ionicons name="camera-outline" size={22} color="#667085" />
              </View>
              <Pressable onPress={() => setScannerOpen(true)} style={[styles.primarySmallBtn, { backgroundColor: tokens.primary, borderRadius: tokens.radius.lg }]}>
                <Text style={{ color: tokens.primaryForeground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm }}>Scan SKU</Text>
              </Pressable>
            </View>
            <View style={[styles.banner, { marginTop: 10, backgroundColor: tokens.accentBlue.soft, borderColor: tokens.accentBlue.border }]}>
              <Text style={{ color: tokens.accentBlue.strong, fontSize: tokens.text.sm }}>
                Scan a SKU wherever it's found — on the open floor or inside a rack — to check it against its expected zone.
              </Text>
            </View>
          </Card>
        </View>
      </View>
      <BarcodeScannerModal
        visible={scannerOpen}
        title="Scan SKU"
        hint="Point at a SKU's zone or rack-location QR code"
        onScanned={handleRealScanned}
        onClose={() => setScannerOpen(false)}
      />
      <WarehouseMapModal
        visible={!!mapTarget}
        skuLabel={mapTarget ? `${mapTarget.sku} · ${mapTarget.name}` : ''}
        expectedZone={mapTarget?.expectedZone ?? ''}
        onConfirm={handleConfirmPin}
        onClose={() => setMapTargetId(null)}
      />
    </View>
  );
}

function ScannedSkuCard({ item, onPin }: { item: ScannedSku; onPin: () => void }) {
  const { tokens } = useTheme();
  const hasExpectation = item.expectedZone !== null;
  const resolved = item.matched !== null;
  const tone = !resolved ? tokens.accentBlue : item.matched ? tokens.rag.green : tokens.rag.amber;
  const inRack = !!(item.rack || item.bay || item.loc);

  return (
    <Card>
      <View style={styles.cardTitleRow}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Ionicons name={inRack ? 'grid-outline' : 'cube-outline'} size={16} color={tokens.mutedForeground} />
          <Text style={{ color: tokens.mutedForeground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.xs }}>{inRack ? 'Rack Find' : 'Floor Find'}</Text>
        </View>
        <View style={[styles.statusBadge, { backgroundColor: tone.soft, borderRadius: tokens.radius.xl }]}>
          <Text style={{ color: tone.strong, fontSize: tokens.text.xs, fontWeight: tokens.fontWeight.bold }}>
            {item.needsPin ? 'Pin Required' : !resolved ? 'No Expectation on Record' : item.matched ? 'Zone Matched' : 'Location Mismatch'}
          </Text>
        </View>
      </View>
      <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.base }}>{item.sku}</Text>
      <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xs, marginBottom: 4 }}>{item.name}</Text>
      <View style={styles.fieldGrid}>
        <Field label="Scanned" value={formatScanTime(item.scannedAt)} />
        {item.pinnedAt ? <Field label="Pinned" value={formatScanTime(item.pinnedAt)} /> : null}
        {hasExpectation ? <Field label="Expected Zone" value={zoneLabel(item.expectedZone as string)} /> : null}
        {/* Scanned Zone stays hidden for a floor find until it's pinned —
            the inspector determines it, the card doesn't hand it to them. */}
        {item.scannedZone ? <Field label="Scanned Zone" value={zoneLabel(item.scannedZone)} /> : null}
        {inRack ? (
          <>
            {item.rack ? <Field label="Rack" value={item.rack} /> : null}
            {item.bay ? <Field label="Bay" value={item.bay} /> : null}
            {item.loc ? <Field label="Storage Location" value={item.loc} full /> : null}
          </>
        ) : null}
      </View>

      {item.needsPin ? (
        <Pressable onPress={onPin} style={[styles.outlineBtn, { borderColor: tokens.border, borderRadius: tokens.radius.lg, marginTop: 10 }]}>
          <Ionicons name="location-outline" size={16} color={tokens.foreground} />
          <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.semibold, fontSize: tokens.text.sm }}>Pin Exact Location</Text>
        </Pressable>
      ) : null}
      {item.issueRaised && item.pinnedZone ? (
        <View style={[styles.pinnedBanner, { borderColor: tokens.border, marginTop: 10 }]}>
          <Ionicons name="alert-circle" size={16} color={tokens.rag.amber.strong} />
          <Text style={{ color: tokens.foreground, fontSize: tokens.text.xs, flex: 1 }}>
            Issue raised — found in <Text style={{ fontWeight: tokens.fontWeight.bold }}>{zoneLabel(item.pinnedZone)}</Text>
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
  splitRow: { flex: 1, flexDirection: 'row', gap: 16, padding: 16 },
  paneCol: { flex: 1 },
  paneListContent: { gap: 14, flexGrow: 1 },
  cardTitleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  sectionTitleRow: { paddingBottom: 12, marginBottom: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  sectionHeadRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingBottom: 12, marginBottom: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  countBadge: { paddingHorizontal: 8, paddingVertical: 2, minWidth: 22, alignItems: 'center' },
  fieldGrid: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 2 },
  field: { width: '50%', marginBottom: 8, paddingRight: 8 },
  fieldFull: { width: '100%', marginBottom: 8 },
  outlineBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, height: 44, borderWidth: 1 },
  banner: { borderWidth: 1, borderRadius: 10, padding: 12 },
  scanBlock: { alignItems: 'center', justifyContent: 'center', gap: 10, borderWidth: 1, borderStyle: 'dashed', padding: 20 },
  glyphCircle: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  primarySmallBtn: { paddingHorizontal: 20, height: 38, alignItems: 'center', justifyContent: 'center' },
  pinnedBanner: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderRadius: 10, padding: 10 },
  emptyState: { alignItems: 'center', justifyContent: 'center', gap: 10, paddingVertical: 40 },
  statusBadge: { paddingHorizontal: 10, paddingVertical: 4 },
});
