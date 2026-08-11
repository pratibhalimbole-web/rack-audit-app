import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { fmtDate, priorityFor, uiStatus } from '@/lib/auditLogic';
import type { Audit } from '@/lib/types';
import type { Rollup } from '@/lib/auditLogic';
import { useTheme } from '@/theme/ThemeProvider';
import { Pill } from './Pill';

// Ports todoCard() (rack-audit-app.html ~2047-2064) — the To Do Task board's
// card, distinct from TaskCard (Dashboard's task preview). The card stretches
// to the full width of its column (same width as that column's
// Delayed/Today/This Week/This Month header), with fields laid out as two
// even (50/50) columns per row so their spacing scales with it. Total Bay
// and Total Location are each one "done/total" ratio field rather than
// three separate completed/pending/total fields.
export function TodoCard({ audit, rollup }: { audit: Audit; rollup: Rollup }) {
  const { tokens } = useTheme();
  const uis = uiStatus(audit);
  const priority = priorityFor(audit);

  return (
    <Pressable
      onPress={() => router.push({ pathname: '/audit/[auditId]', params: { auditId: audit.audit_id } } as never)}
      style={[styles.card, { backgroundColor: tokens.card, borderColor: tokens.border, borderRadius: tokens.radius.xl }]}
    >
      <Text
        style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm, marginBottom: 10 }}
        numberOfLines={1}
      >
        {audit.audit_name}
      </Text>
      <View style={styles.fields}>
        <View style={styles.row}>
          <Field label="Task Status">
            <Pill label={uis} tone={uis} />
          </Field>
          <Field label="Priority">
            <Pill label={priority} tone={priority} />
          </Field>
        </View>
        <View style={styles.row}>
          <Field label="Audit Date">
            <Text style={[styles.mono, { color: tokens.foreground }]}>{fmtDate(audit.start_date)}</Text>
          </Field>
          <Field label="No. of Racks">
            <NumChip value={rollup.rackTotal} />
          </Field>
        </View>
        <View style={styles.row}>
          <Field label="Total Bay">
            <NumChip value={ratio(rollup.bayDone, rollup.bayTotal)} />
          </Field>
          <Field label="Total Location">
            <NumChip value={ratio(rollup.locDone, rollup.locTotal)} />
          </Field>
        </View>
      </View>
    </Pressable>
  );
}

// "02/04" — done padded to 2 digits out of total, e.g. 2 of this audit's 4
// bays completed.
function ratio(done: number, total: number): string {
  return `${String(done).padStart(2, '0')}/${String(total).padStart(2, '0')}`;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  const { tokens } = useTheme();
  return (
    <View style={styles.field}>
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
  mono: { fontSize: 12, fontFamily: 'Inter_500Medium' },
  chip: { alignSelf: 'flex-start', paddingHorizontal: 8, paddingVertical: 2 },
});
