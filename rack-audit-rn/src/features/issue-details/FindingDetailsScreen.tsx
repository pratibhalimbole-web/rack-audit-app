import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import { AppHeader } from '@/components/AppHeader';
import { Card } from '@/components/Card';
import { locLevelPosition } from '@/features/rack-view/buildBayDiagram';
import { useLocationsTree } from '@/hooks/useLocationsTree';
import { findLayoutIn, findRackIn } from '@/lib/locationsRepo';
import { buildFindings } from '@/lib/findings';
import { useTheme } from '@/theme/ThemeProvider';
import { useAudits } from '../dashboard/hooks';

const FINDING_BADGE: Record<string, 'red' | 'amber' | 'accentBlue'> = {
  'Mismatched SKU': 'amber',
  'Missing SKU': 'accentBlue',
  Damage: 'red',
  'Manual Report': 'amber',
};

// Reached from a Reconciliation Findings card — re-derives the exact same
// Finding list (src/lib/findings.ts) the board itself builds, then picks
// out the one matching the route's composite identity, same "recompute,
// don't pass the object through nav params" reasoning as the existing
// IssueDetailsScreen (Rack View's own flagged-line detail page).
export function FindingDetailsScreen() {
  const { tokens } = useTheme();
  const { findingId } = useLocalSearchParams<{ findingId: string }>();
  // Decode once here and match plain fields against the freshly-rebuilt
  // Finding list — comparing a re-encoded whole string against the raw
  // route param (as this used to) breaks the moment any field needs
  // encoding (e.g. "Mismatched SKU"'s own space), since expo-router may
  // already have decoded the incoming param by the time it reaches here.
  const [pAuditId, pFindingType, pLocCode, pPallet, pSku, pUnitId] = (findingId ?? '').split('~').map((s) => decodeURIComponent(s));
  const auditId = pAuditId;
  const { data: audits } = useAudits();
  const audit = audits?.find((a) => a.audit_id === auditId);
  const { data: tree, isLoading } = useLocationsTree(auditId);

  const finding = audit
    ? buildFindings([audit], { [auditId]: tree }, [], undefined, undefined).find(
        (f) => f.auditId === pAuditId && f.findingType === pFindingType && f.locCode === pLocCode && f.pallet === pPallet && f.sku === pSku && f.unitId === pUnitId,
      )
    : undefined;

  if (!audit || isLoading) {
    return (
      <View style={[styles.loading, { backgroundColor: tokens.muted }]}>
        <ActivityIndicator color={tokens.primary} />
      </View>
    );
  }

  if (!finding) {
    return (
      <View style={{ flex: 1, backgroundColor: tokens.muted }}>
        <AppHeader title="Issue Details" showBack />
        <View style={styles.loading}>
          <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.sm }}>This finding is no longer on record.</Text>
        </View>
      </View>
    );
  }

  const rackObj = tree ? findRackIn(tree, finding.layout, finding.rack) : undefined;
  const bayObj = rackObj?.bays.find((b) => b.code === finding.bay);
  const { level, position } = locLevelPosition(bayObj, finding.locCode);
  const badgeKey = FINDING_BADGE[finding.findingType] ?? 'amber';
  const badge = badgeKey === 'accentBlue' ? { bg: tokens.accentBlue.soft, fg: tokens.accentBlue.strong } : { bg: tokens.rag[badgeKey].soft, fg: tokens.rag[badgeKey].strong };
  const ev = finding.evidence;
  const images = ev?.images ?? [];
  const videos = ev?.videos ?? [];

  return (
    <View style={{ flex: 1, backgroundColor: tokens.muted }}>
      <AppHeader title="Issue Details" showBack menuItems={[{ label: 'Sync Now', onPress: () => {} }]} />
      <ScrollView contentContainerStyle={styles.body}>
        <Card>
          <View style={styles.sectionLabelRow}>
            <Ionicons name="search-outline" size={16} color={tokens.foreground} />
            <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.base }}>Issue Details</Text>
          </View>
          <View style={styles.grid}>
            <Field label="DISC-ID" value={finding.discId} />
            <Field label="Event Name & ID" value={`${finding.auditName} - ${finding.auditId}`} />
            <View style={styles.field}>
              <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm, marginBottom: 4 }}>Finding Type</Text>
              <View style={[styles.typeBadge, { backgroundColor: badge.bg, borderRadius: tokens.radius.lg }]}>
                <Text style={{ color: badge.fg, fontSize: tokens.text.xs, fontWeight: tokens.fontWeight.bold }}>{finding.findingType}</Text>
              </View>
            </View>
            <Field label="SKU" value={finding.sku} mono />
            <Field label="Inventory unit id" value={finding.unitId} mono />

            <Field label="Inspected on" value={finding.inspectedOn} />
            <Field label="Layout" value={finding.layout} />
            <Field label="Rack" value={finding.rack} />
            <Field label="Bay" value={finding.bay} />
            <Field label="Level" value={level != null ? `L-${String(level).padStart(2, '0')}` : '—'} />

            <Field label="Position" value={position != null ? `P${String(position).padStart(2, '0')}` : '—'} />
            <Field label="Pallet" value={finding.pallet} mono />
            <View style={styles.field}>
              <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm, marginBottom: 4 }}>Audio</Text>
              {ev?.audio ? (
                <Text style={{ color: tokens.primary, fontSize: tokens.text.sm, fontWeight: tokens.fontWeight.semibold }}>▶ Recording ({ev.audio.durationSec}s)</Text>
              ) : (
                <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.sm }}>NA</Text>
              )}
            </View>
            <Field label="Note" value={ev?.note || 'NA'} />
          </View>
        </Card>

        <Card>
          <EvidenceGroupHead icon="image-outline" label="Image Attachments" count={images.length} />
          {images.length ? (
            <View style={styles.thumbRow}>
              {images.map((_, i) => (
                <View key={i} style={[styles.thumb, { backgroundColor: tokens.muted, borderRadius: tokens.radius.lg }]}>
                  <Ionicons name="image-outline" size={20} color="#667085" />
                </View>
              ))}
            </View>
          ) : (
            <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.sm }}>No images attached</Text>
          )}
        </Card>

        <Card>
          <EvidenceGroupHead icon="videocam-outline" label="Video Attachments" count={videos.length} />
          {videos.length ? (
            <View style={styles.thumbRow}>
              {videos.map((v, i) => (
                <View key={i} style={[styles.thumb, { backgroundColor: tokens.muted, borderRadius: tokens.radius.lg }]}>
                  <Text style={{ color: tokens.mutedForeground, fontSize: 9 }}>00:{v.durationSec}s</Text>
                  <Ionicons name="play" size={16} color="#667085" />
                </View>
              ))}
            </View>
          ) : (
            <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.sm }}>No videos attached</Text>
          )}
        </Card>
      </ScrollView>
    </View>
  );
}

function EvidenceGroupHead({ icon, label, count }: { icon: keyof typeof Ionicons.glyphMap; label: string; count: number }) {
  const { tokens } = useTheme();
  return (
    <View style={styles.evidenceHeadRow}>
      <Ionicons name={icon} size={16} color={tokens.foreground} />
      <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.semibold, fontSize: tokens.text.sm }}>{label}</Text>
      <View style={[styles.countBadge, { backgroundColor: tokens.accentBlue.soft, borderRadius: tokens.radius.sm }]}>
        <Text style={{ color: tokens.accentBlue.strong, fontSize: tokens.text.xxs, fontWeight: tokens.fontWeight.bold }}>{String(count).padStart(2, '0')}</Text>
      </View>
    </View>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  const { tokens } = useTheme();
  return (
    <View style={styles.field}>
      <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm, marginBottom: 4 }}>{label}</Text>
      <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.sm, fontFamily: mono ? 'Inter_500Medium' : undefined }} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  body: { padding: 16, gap: 14, paddingBottom: 40 },
  sectionLabelRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 14 },
  field: { width: '20%', minWidth: 140, marginBottom: 14, paddingRight: 8 },
  typeBadge: { alignSelf: 'flex-start', paddingHorizontal: 10, paddingVertical: 4 },
  evidenceHeadRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 },
  countBadge: { paddingHorizontal: 7, paddingVertical: 2 },
  thumbRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  thumb: { width: 64, height: 64, alignItems: 'center', justifyContent: 'center', gap: 4 },
});
