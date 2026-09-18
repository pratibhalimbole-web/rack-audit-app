import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { fmtDate, uiStatus } from '@/lib/auditLogic';
import { ZONE_EXPECTED_SKUS } from '@/lib/mockData';
import type { Audit } from '@/lib/types';
import type { Rollup } from '@/lib/auditLogic';
import { useTheme } from '@/theme/ThemeProvider';
import { Pill } from './Pill';

// Ports todoCard() (rack-audit-app.html ~2047-2064) — the To Do Task board's
// card, distinct from TaskCard (Dashboard's task preview). The card stretches
// to the full width of its column (same width as that column's
// Delayed/Today/This Week/This Month header), with fields laid out as two
// even (50/50) columns per row so their spacing scales with it. Total Bay is
// a "done/total" ratio field rather than separate completed/pending/total
// fields. A multi-layout audit gets its own "No. of Layout" field paired
// with "No. of Racks", and Total Bay drops to its own row beneath them;
// a single-layout audit pairs "No. of Racks" with "Total Bay" directly.
// hideStatus: the Completed Task screen (src/features/maintenance/
// MaintenanceScreen.tsx) already implies every card here is done, so its
// own "Task Status" pill is redundant there — only the Tasks board (mixed
// due-date buckets, where status is the point) shows it. Doubles as the
// signal for where a tap should land: Completed Task's own reported-issues
// grid (task-details) instead of the regular Audit Details screen.
export function TodoCard({ audit, rollup, hideStatus }: { audit: Audit; rollup: Rollup; hideStatus?: boolean }) {
  const { tokens } = useTheme();
  const uis = uiStatus(audit);
  // Zone-scoped audits have no rack/bay breakdown (worked at the whole-zone
  // grain, same as Audit Details) — "Total Bay" would just read 00/00, so
  // this shows how many zones are in scope instead.
  const isZoneScope = audit.scope_type === 'Zone';
  // Distinct SKUs across this audit's zones' own pick lists — same source
  // Zone Scan itself checks scans against.
  const zoneSkuCount = isZoneScope
    ? new Set(audit.scope_values.flatMap((z) => (ZONE_EXPECTED_SKUS[z] ?? []).map((s) => s.sku))).size
    : 0;

  return (
    <Pressable
      onPress={() =>
        router.push({ pathname: hideStatus ? '/audit/[auditId]/task-details' : '/audit/[auditId]', params: { auditId: audit.audit_id } } as never)
      }
      style={[styles.card, { backgroundColor: tokens.card, borderColor: tokens.border, borderRadius: tokens.radius.xl }]}
    >
      <Text
        style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm, marginBottom: 10 }}
        numberOfLines={1}
      >
        {audit.audit_name} -{audit.audit_id}
      </Text>
      <View style={styles.fields}>
        <View style={styles.row}>
          {!hideStatus ? (
            <Field label="Task Status">
              <Pill label={uis} tone={uis} />
            </Field>
          ) : null}
          <Field label="Task Type" full={hideStatus}>
            <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.semibold, fontSize: tokens.text.xs }}>Audit</Text>
          </Field>
        </View>
        <View style={styles.row}>
          <Field label="Start Date">
            <Text style={[styles.mono, { color: tokens.foreground }]}>{fmtDate(audit.start_date)}</Text>
          </Field>
          <Field label="End Date">
            <Text style={[styles.mono, { color: tokens.foreground }]}>{fmtDate(audit.end_date)}</Text>
          </Field>
        </View>
        <View style={styles.row}>
          {isZoneScope ? (
            <>
              <Field label="Total Zone">
                <NumChip value={audit.scope_values.length} />
              </Field>
              <Field label="No. of SKUs">
                <NumChip value={zoneSkuCount} />
              </Field>
            </>
          ) : rollup.layoutTotal > 1 ? (
            <>
              <Field label="No. of Layout">
                <NumChip value={rollup.layoutTotal} />
              </Field>
              <Field label="No. of Racks">
                <NumChip value={rollup.rackTotal} />
              </Field>
            </>
          ) : (
            <>
              <Field label="No. of Racks">
                <NumChip value={rollup.rackTotal} />
              </Field>
              <Field label="Total Bay">
                <NumChip value={ratio(rollup.bayDone, rollup.bayTotal)} />
              </Field>
            </>
          )}
        </View>
        {!isZoneScope && rollup.layoutTotal > 1 ? (
          <View style={styles.row}>
            <Field label="Total Bay">
              <NumChip value={ratio(rollup.bayDone, rollup.bayTotal)} />
            </Field>
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}

// "02/04" — done padded to 2 digits out of total, e.g. 2 of this audit's 4
// bays completed.
function ratio(done: number, total: number): string {
  return `${String(done).padStart(2, '0')}/${String(total).padStart(2, '0')}`;
}

function Field({ label, children, full }: { label: string; children: React.ReactNode; full?: boolean }) {
  const { tokens } = useTheme();
  return (
    <View style={[styles.field, full ? styles.fieldFull : null]}>
      <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xxs, marginBottom: 4 }}>{label}</Text>
      {children}
    </View>
  );
}

function NumChip({ value }: { value: number | string }) {
  const { tokens } = useTheme();
  return (
    <View style={[styles.chip, { backgroundColor: tokens.muted, borderRadius: tokens.radius.sm }]}>
      <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.xs }}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, padding: 14, marginBottom: 10 },
  fields: { rowGap: 10 },
  row: { flexDirection: 'row', justifyContent: 'space-between' },
  field: { width: '48%' },
  fieldFull: { width: '100%' },
  mono: { fontSize: 12, fontFamily: 'Inter_500Medium' },
  chip: { alignSelf: 'flex-start', paddingHorizontal: 8, paddingVertical: 2 },
});
