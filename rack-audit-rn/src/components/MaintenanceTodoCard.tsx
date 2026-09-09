import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { fmtDate } from '@/lib/auditLogic';
import { maintenanceLocationLabel, type MaintenanceStatusColor, type MaintenanceTask } from '@/lib/maintenance';
import { useTheme } from '@/theme/ThemeProvider';

const STATUS_TOKEN: Record<MaintenanceStatusColor, 'red' | 'amber' | 'green'> = { Red: 'red', Amber: 'amber', Green: 'green' };

// Same encoding Reported Audits' own cards use (ReportedAuditsBoard.tsx's
// issueLineId) to reach the real Issue Details screen — a MaintenanceTask
// is itself derived from that exact flagged line's identity (layout/rack/
// bay/locCode/pallet/sku), so it re-resolves to the same real record there.
function maintenanceLineId(task: MaintenanceTask): string {
  return [task.layout, task.rack, task.bay, task.locCode, task.pallet, task.sku].map(encodeURIComponent).join('~');
}

// The Tasks board's second card type, alongside TodoCard's Audit cards — a
// Maintenance/Field task (a follow-up action assigned to an already-reported
// issue, same data the standalone Maintenance screen lists). Same card
// weight/shape as TodoCard so the two sit comfortably in the same due-date
// column, but its own accent border + type badge make the two immediately
// distinguishable at a glance rather than reading as one undifferentiated list.
// showActionTaken: only true on the Completed Task screen's card — the one
// difference from this same card as it appears on the Tasks board, where
// the task is still open and nothing's been "taken" yet.
export function MaintenanceTodoCard({ task, showActionTaken }: { task: MaintenanceTask; showActionTaken?: boolean }) {
  const { tokens } = useTheme();
  const ragKey = STATUS_TOKEN[task.statusColor];

  return (
    <Pressable
      onPress={() =>
        router.push({ pathname: '/audit/[auditId]/issue/[lineId]', params: { auditId: task.auditId, lineId: maintenanceLineId(task) } } as never)
      }
      style={[styles.card, { backgroundColor: tokens.card, borderColor: tokens.border, borderRadius: tokens.radius.xl }]}
    >
      <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm, marginBottom: 10 }} numberOfLines={1}>
        {task.issueType} · {task.sku}
      </Text>
      <View style={styles.fields}>
        <Field label="Location" full>
          <Text style={[styles.value, { color: tokens.foreground }]} numberOfLines={1}>
            {maintenanceLocationLabel(task)}
          </Text>
        </Field>
        <View style={styles.row}>
          {!showActionTaken ? (
            <Field label="Status">
              <View style={[styles.statusPill, { backgroundColor: tokens.rag[ragKey].soft, borderColor: tokens.rag[ragKey].border }]}>
                <Text style={{ color: tokens.rag[ragKey].strong, fontSize: tokens.text.xxs, fontWeight: tokens.fontWeight.bold }} numberOfLines={1}>
                  {task.boardStatus}
                </Text>
              </View>
            </Field>
          ) : null}
          <Field label="Task Type" full={showActionTaken}>
            <Text style={[styles.value, { color: tokens.foreground }]}>Maintenance</Text>
          </Field>
        </View>
        <View style={styles.row}>
          <Field label="Due Date">
            <Text style={[styles.value, { color: tokens.foreground }]}>{fmtDate(task.dueDate)}</Text>
          </Field>
          <Field label="Rack">
            <Text style={[styles.value, { color: tokens.foreground }]} numberOfLines={1}>
              {task.rack}
            </Text>
          </Field>
        </View>
        <View style={styles.row}>
          <Field label="Action">
            <Text style={[styles.value, { color: tokens.foreground }]} numberOfLines={1}>
              {task.action}
            </Text>
          </Field>
        </View>
        {showActionTaken ? (
          <View style={styles.row}>
            <Field label="Action Taken">
              <Text style={[styles.value, { color: tokens.foreground }]} numberOfLines={1}>
                {task.action}
              </Text>
            </Field>
          </View>
        ) : null}
      </View>
    </Pressable>
  );
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

const styles = StyleSheet.create({
  card: { borderWidth: 1, padding: 14, marginBottom: 10 },
  fields: { rowGap: 10 },
  row: { flexDirection: 'row', justifyContent: 'space-between' },
  field: { width: '48%' },
  fieldFull: { width: '100%' },
  value: { fontSize: 12, fontWeight: '600' },
  statusPill: { alignSelf: 'flex-start', borderWidth: 1, paddingHorizontal: 8, paddingVertical: 2 },
});
