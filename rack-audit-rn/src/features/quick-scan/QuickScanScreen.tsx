import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { AppHeader } from '@/components/AppHeader';
import { Card } from '@/components/Card';
import { Pill } from '@/components/Pill';
import { mine, uiStatus } from '@/lib/auditLogic';
import { useDeviceClass } from '@/hooks/useDeviceClass';
import { useAuditProgressMap } from '@/hooks/useLocationsTree';
import { QUICK_SCAN_POOL } from '@/lib/mockData';
import type { QrPayload, QuickScanEntry } from '@/lib/types';
import { useTheme } from '@/theme/ThemeProvider';
import { useAudits } from '../dashboard/hooks';

// Ports renderQuickScan() (rack-audit-app.html ~3926-3989) — the global
// "Scan" tab. A real camera scan can't know the code's location scope in
// advance, so a matched location is checked against every one of the
// inspector's non-completed assigned audits (In Progress ones preferred),
// same as findAuditForScan(). Non-location codes (pallet/SKU) only make
// sense inside an already-open count sheet, so they're rejected here with a
// shortcut back to wherever counting was last in progress, if anywhere.
function openAuditLocation(isTablet: boolean, loc: { auditId: string; layout: string; rack: string; bay: string; loc: string }) {
  if (isTablet) {
    router.push({
      pathname: '/audit/[auditId]/rack/[rackId]',
      params: { auditId: loc.auditId, rackId: loc.rack, layout: loc.layout, bay: loc.bay, loc: loc.loc },
    } as never);
  } else {
    router.push({
      pathname: '/audit/[auditId]/count-sheet',
      params: { auditId: loc.auditId, layout: loc.layout, rack: loc.rack, bay: loc.bay, loc: loc.loc },
    } as never);
  }
}

export function QuickScanScreen() {
  const { tokens } = useTheme();
  const device = useDeviceClass();
  const isTablet = device === 'tablet';
  const { data: audits = [] } = useAudits();
  const [scanCount, setScanCount] = useState(0);
  const [code, setCode] = useState<QrPayload | null>(null);
  const [matchedAuditId, setMatchedAuditId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [wrongKind, setWrongKind] = useState<'pallet' | 'sku' | null>(null);
  const [wrongLabel, setWrongLabel] = useState<string | null>(null);

  const candidates = useMemo(
    () => mine(audits).filter((a) => !['Submitted', 'Reconciled', 'Closed'].includes(a.status)),
    [audits],
  );
  const { map } = useAuditProgressMap(candidates.map((a) => a.audit_id));
  const ongoing = candidates.find((a) => a.status === 'In Progress');
  const ongoingLastSaved = ongoing ? map[ongoing.audit_id]?.lastSaved : null;

  const matched = matchedAuditId ? audits.find((a) => a.audit_id === matchedAuditId) : null;

  const findAuditForScan = (qrCode: QrPayload): string | null => {
    const inProgress = candidates.filter((a) => a.status === 'In Progress');
    const rest = candidates.filter((a) => a.status !== 'In Progress');
    for (const list of [inProgress, rest]) {
      const hit = list.find((a) =>
        map[a.audit_id]?.allLocations.some((x) => x.layout === qrCode.layout && x.rack === qrCode.rack && x.bay === qrCode.bay && x.loc.code === qrCode.loc),
      );
      if (hit) return hit.audit_id;
    }
    return null;
  };

  const handleScan = () => {
    const item: QuickScanEntry = QUICK_SCAN_POOL[scanCount % QUICK_SCAN_POOL.length];
    setScanCount((c) => c + 1);

    if (item.kind !== 'location') {
      setCode(null);
      setMatchedAuditId(null);
      setError(null);
      setWrongKind(item.kind);
      setWrongLabel(item.kind === 'pallet' ? item.code : `${item.code.sku} · ${item.code.name}`);
      return;
    }

    setWrongKind(null);
    setWrongLabel(null);
    const qrCode = item.code;
    const auditId = findAuditForScan(qrCode);
    if (auditId) {
      setCode(qrCode);
      setError(null);
      setMatchedAuditId(auditId);
    } else {
      setCode(null);
      setMatchedAuditId(null);
      setError(`No assigned audit covers ${qrCode.layout} · Rack ${qrCode.rack} · Bay ${qrCode.bay}. It may be outside your scope.`);
    }
  };

  let body: React.ReactNode;
  if (code && matched) {
    const uis = uiStatus(matched);
    body = (
      <View style={{ gap: 14 }}>
        <Card style={{ borderColor: tokens.rag.green.border, backgroundColor: tokens.rag.green.soft }}>
          <View style={styles.cardTitleRow}>
            <Text style={{ color: tokens.rag.green.strong, fontWeight: tokens.fontWeight.extrabold, fontSize: tokens.text.base }}>Scanned Location</Text>
            <Ionicons name="checkmark-circle" size={20} color={tokens.rag.green.strong} />
          </View>
          <KvRow label="Layout" value={code.layout} />
          <KvRow label="Rack" value={code.rack} />
          <KvRow label="Bay" value={code.bay} />
          <KvRow label="Storage Location" value={code.loc} last />
        </Card>
        <Card>
          <View style={styles.cardTitleRow}>
            <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.extrabold, fontSize: tokens.text.base }}>Matched Audit</Text>
            <Pill label={uis} tone={uis} />
          </View>
          <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.base }}>{matched.audit_name}</Text>
          <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xs, marginTop: 2 }}>{matched.audit_id}</Text>
        </Card>
        <Pressable
          onPress={() => openAuditLocation(isTablet, { auditId: matched.audit_id, layout: code.layout, rack: code.rack, bay: code.bay, loc: code.loc })}
          style={[styles.primaryBtn, { backgroundColor: tokens.primary, borderRadius: tokens.radius.xxl }]}
        >
          <Text style={{ color: tokens.primaryForeground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm }}>
            {isTablet ? 'Open Rack View' : 'Open Count Sheet'}
          </Text>
          <Ionicons name="chevron-forward" size={16} color={tokens.primaryForeground} />
        </Pressable>
        <Pressable onPress={handleScan} style={[styles.outlineBtn, { borderColor: tokens.border, borderRadius: tokens.radius.lg }]}>
          <Ionicons name="scan-outline" size={16} color={tokens.foreground} />
          <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.semibold, fontSize: tokens.text.sm }}>Scan Another Location</Text>
        </Pressable>
      </View>
    );
  } else if (wrongKind) {
    body = (
      <View style={{ gap: 14 }}>
        <Card style={{ borderColor: tokens.rag.amber.border, backgroundColor: tokens.rag.amber.soft }}>
          <View style={styles.cardTitleRow}>
            <Text style={{ color: tokens.rag.amber.strong, fontWeight: tokens.fontWeight.extrabold, fontSize: tokens.text.base }}>Wrong Code Type</Text>
            <Ionicons name="close-circle" size={20} color={tokens.rag.amber.strong} />
          </View>
          <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.base, marginBottom: 4 }}>
            This is a {wrongKind === 'pallet' ? 'Pallet' : 'SKU'} code, not a storage location.
          </Text>
          <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xs }}>{wrongLabel}</Text>
        </Card>
        <View style={[styles.banner, { backgroundColor: tokens.accentBlue.soft, borderColor: tokens.accentBlue.border }]}>
          <Text style={{ color: tokens.accentBlue.strong, fontSize: tokens.text.sm }}>
            Pallet and SKU codes only make sense inside an already-open location's count sheet. Scan the storage location QR first.
          </Text>
        </View>
        {ongoing && ongoingLastSaved ? (
          <Pressable
            onPress={() =>
              openAuditLocation(isTablet, {
                auditId: ongoing.audit_id,
                layout: ongoingLastSaved.layout,
                rack: ongoingLastSaved.rack,
                bay: ongoingLastSaved.bay,
                loc: ongoingLastSaved.loc.code,
              })
            }
            style={[styles.primaryBtn, { backgroundColor: tokens.primary, borderRadius: tokens.radius.xxl }]}
          >
            <Text style={{ color: tokens.primaryForeground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm }}>
              Continue at {ongoingLastSaved.loc.code}
            </Text>
            <Ionicons name="chevron-forward" size={16} color={tokens.primaryForeground} />
          </Pressable>
        ) : null}
        <Pressable onPress={handleScan} style={[styles.outlineBtn, { borderColor: tokens.border, borderRadius: tokens.radius.lg }]}>
          <Ionicons name="scan-outline" size={16} color={tokens.foreground} />
          <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.semibold, fontSize: tokens.text.sm }}>Scan Again</Text>
        </Pressable>
      </View>
    );
  } else {
    body = (
      <View style={styles.centeredEmpty}>
        <View style={[styles.scanBlock, { borderColor: tokens.border, borderRadius: tokens.radius.lg }]}>
          <View style={[styles.glyphCircle, { backgroundColor: tokens.muted }]}>
            <Ionicons name="camera-outline" size={26} color="#667085" />
          </View>
          <Pressable onPress={handleScan} style={[styles.primarySmallBtn, { backgroundColor: tokens.primary, borderRadius: tokens.radius.lg }]}>
            <Text style={{ color: tokens.primaryForeground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm }}>Scan Location QR</Text>
          </Pressable>
        </View>
        <View
          style={[
            styles.banner,
            { marginTop: 14 },
            error ? { backgroundColor: tokens.rag.amber.soft, borderColor: tokens.rag.amber.border } : { backgroundColor: tokens.accentBlue.soft, borderColor: tokens.accentBlue.border },
          ]}
        >
          <Text style={{ color: error ? tokens.rag.amber.strong : tokens.accentBlue.strong, fontSize: tokens.text.sm }}>
            {error ?? 'Scan any storage location QR to jump straight to its count sheet — checked against all of your assigned audits.'}
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: tokens.muted }}>
      <AppHeader title="Quick Scan" sub="Jump to any assigned location" showBack menuItems={[{ label: 'Sync Now', onPress: () => {} }]} />
      <ScrollView contentContainerStyle={styles.body}>{body}</ScrollView>
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
  body: { flexGrow: 1, padding: 16 },
  cardTitleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  kvRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 8 },
  primaryBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, height: 48 },
  outlineBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, height: 44, borderWidth: 1 },
  banner: { borderWidth: 1, borderRadius: 10, padding: 12 },
  centeredEmpty: { flex: 1, justifyContent: 'center' },
  scanBlock: { alignItems: 'center', justifyContent: 'center', gap: 10, borderWidth: 1, borderStyle: 'dashed', padding: 22 },
  glyphCircle: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center' },
  primarySmallBtn: { paddingHorizontal: 20, height: 40, alignItems: 'center', justifyContent: 'center' },
});
