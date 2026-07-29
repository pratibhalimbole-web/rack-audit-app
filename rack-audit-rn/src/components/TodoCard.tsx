import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { fmtDate, priorityFor, uiStatus } from '@/lib/auditLogic';
import type { Audit } from '@/lib/types';
import type { Rollup } from '@/lib/auditLogic';
import { useTheme } from '@/theme/ThemeProvider';
import { Pill } from './Pill';

// Ports todoCard() (rack-audit-app.html ~2047-2064) — the To Do Task board's
// card, distinct from TaskCard (Dashboard's task preview): a title + a
// 2-column field grid whose numbers mirror what Audit Details itself shows
// for the same audit (bayTotal/bayDone/bayPending from the same rollup()).
export function TodoCard({ audit, rollup }: { audit: Audit; rollup: Rollup }) {
  const { tokens } = useTheme();
  const uis = uiStatus(audit);
  const priority = priorityFor(audit);
  const bayPending = rollup.bayTotal - rollup.bayDone;

  return (
    <Pressable
      onPress={() => router.push({ pathname: '/audit/[auditId]', params: { auditId: audit.audit_id } } as never)}
      style={[styles.card, { backgroundColor: tokens.card, borderColor: tokens.border, borderRadius: tokens.radius.xl }]}
    >
      <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm, marginBottom: 10 }}>
        {audit.audit_type}
      </Text>
      <View style={styles.grid}>
        <Field label="Task Status">
          <Pill label={uis} tone={uis} />
        </Field>
        <Field label="Priority">
          <Pill label={priority} tone={priority} />
        </Field>
        <Field label="Audit Date">
          <Text style={[styles.mono, { color: tokens.foreground }]}>{fmtDate(audit.start_date)}</Text>
        </Field>
        <Field label="Total Bay">
          <NumChip value={rollup.bayTotal} />
        </Field>
        <Field label="Completed Bay">
          <NumChip value={rollup.bayDone} />
        </Field>
        <Field label="Pending Bay">
          <NumChip value={bayPending} />
        </Field>
      </View>
    </Pressable>
  );
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

function NumChip({ value }: { value: number }) {
  const { tokens } = useTheme();
  return (
    <View style={[styles.chip, { backgroundColor: tokens.muted, borderRadius: tokens.radius.sm }]}>
      <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.xs }}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, padding: 14, marginBottom: 10 },
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  field: { width: '50%', marginBottom: 10 },
  mono: { fontSize: 12, fontFamily: 'Inter_500Medium' },
  chip: { alignSelf: 'flex-start', paddingHorizontal: 8, paddingVertical: 2 },
});
