import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import { AppHeader } from '@/components/AppHeader';
import { Card } from '@/components/Card';
import { locLevelPosition } from '@/features/rack-view/buildBayDiagram';
import { useLocationsTree } from '@/hooks/useLocationsTree';
import { emptyLocations } from '@/lib/auditLogic';
import { findRackIn } from '@/lib/locationsRepo';
import { fmtInspected } from '@/lib/findings';
import { useTheme } from '@/theme/ThemeProvider';
import { useAudits } from '../dashboard/hooks';

// Reached from a Reconciliation Findings "Empty location" card — no SKU/
// Finding Type here at all, since nothing was ever scanned; instead shows
// the location breadcrumb plus the Pallet Condition question/evidence
// actually answered at the top of Rack View's Reconciliation Form for that
// location (see RackViewScreen's "Is the pallet condition at this location
// good?" + conditionEvidence, saved via the synthetic source:'empty' line).
export function EmptyLocationDetailsScreen() {
  const { tokens } = useTheme();
  const { emptyId } = useLocalSearchParams<{ emptyId: string }>();
  const [auditId, locCode, pallet] = (emptyId ?? '').split('~').map((s) => decodeURIComponent(s));
  const { data: audits } = useAudits();
  const audit = audits?.find((a) => a.audit_id === auditId);
  const { data: tree, isLoading } = useLocationsTree(auditId);

  const entry = emptyLocations(tree).find((e) => e.locCode === locCode && e.pallet === pallet);

  if (!audit || isLoading) {
    return (
      <View style={[styles.loading, { backgroundColor: tokens.muted }]}>
        <ActivityIndicator color={tokens.primary} />
      </View>
    );
  }

  if (!entry) {
    return (
      <View style={{ flex: 1, backgroundColor: tokens.muted }}>
        <AppHeader title="Issue Details" showBack />
        <View style={styles.loading}>
          <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.sm }}>This location is no longer marked empty.</Text>
        </View>
      </View>
    );
  }

  const rackObj = tree ? findRackIn(tree, entry.layout, entry.rack) : undefined;
  const bayObj = rackObj?.bays.find((b) => b.code === entry.bay);
  const { level, position } = locLevelPosition(bayObj, locCode);
  const ev = entry.conditionEvidence;
  const images = ev?.images ?? [];
  const videos = ev?.videos ?? [];
  const conditionLabel = entry.palletConditionGood === false ? 'Not Good' : entry.palletConditionGood === true ? 'Good' : 'Not Answered';

  return (
    <View style={{ flex: 1, backgroundColor: tokens.muted }}>
      <AppHeader title="Issue Details" showBack menuItems={[{ label: 'Sync Now', onPress: () => {} }]} />
      <ScrollView contentContainerStyle={styles.body}>
        <Card>
          <View style={styles.sectionLabelRow}>
            <View style={[styles.iconWrap, { backgroundColor: tokens.accentBlue.soft }]}>
              <Ionicons name="search-outline" size={16} color={tokens.accentBlue.strong} />
            </View>
            <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.base }}>Issue Details</Text>
          </View>
          <View style={styles.grid}>
            <Field label="Inspected on" value={fmtInspected()} />
            <Field label="Event Name & ID" value={`${audit.audit_name} - ${audit.audit_id}`} />
            <Field label="Layout" value={entry.layout} />
            <Field label="Rack" value={entry.rack} />
            <Field label="Bay" value={entry.bay} />
            <Field label="Level" value={level != null ? `L-${String(level).padStart(2, '0')}` : '—'} />
            <Field label="Position" value={position != null ? `P${String(position).padStart(2, '0')}` : '—'} />
            <Field label="Pallet" value={entry.pallet} mono />
          </View>
        </Card>

        <Card>
          <View style={styles.sectionLabelRow}>
            <View style={[styles.iconWrap, { backgroundColor: tokens.accentBlue.soft }]}>
              <Ionicons name="barcode-outline" size={16} color={tokens.accentBlue.strong} />
            </View>
            <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.base }}>Pallet Condition Details</Text>
          </View>
          <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm, marginTop: 14 }}>Pallet Condition :</Text>
          <View style={[styles.typeBadge, { backgroundColor: tokens.accentBlue.soft, borderRadius: tokens.radius.lg, marginTop: 6 }]}>
            <Text style={{ color: tokens.accentBlue.strong, fontSize: tokens.text.xs, fontWeight: tokens.fontWeight.bold }}>{conditionLabel}</Text>
          </View>

          <View style={{ marginTop: 16 }}>
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
          </View>

          <View style={{ marginTop: 16 }}>
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
          </View>
        </Card>
      </ScrollView>
    </View>
  );
}

function EvidenceGroupHead({ icon, label, count }: { icon: keyof typeof Ionicons.glyphMap; label: string; count: number }) {
  const { tokens } = useTheme();
  return (
    <View style={styles.evidenceHeadRow}>
      <View style={[styles.iconWrap, { backgroundColor: tokens.accentBlue.soft }]}>
        <Ionicons name={icon} size={16} color={tokens.accentBlue.strong} />
      </View>
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
  iconWrap: { width: 28, height: 28, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 14 },
  field: { width: '20%', minWidth: 140, marginBottom: 14, paddingRight: 8 },
  typeBadge: { alignSelf: 'flex-start', paddingHorizontal: 10, paddingVertical: 4 },
  evidenceHeadRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 },
  countBadge: { paddingHorizontal: 7, paddingVertical: 2 },
  thumbRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  thumb: { width: 64, height: 64, alignItems: 'center', justifyContent: 'center', gap: 4 },
});
