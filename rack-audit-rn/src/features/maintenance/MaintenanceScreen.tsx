import { Ionicons } from '@expo/vector-icons';
import { useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { AppHeader } from '@/components/AppHeader';
import { Card } from '@/components/Card';
import { useLocationsTreeMap } from '@/hooks/useLocationsTree';
import { mine } from '@/lib/auditLogic';
import { buildMaintenanceTasks, maintenanceLocationLabel, type MaintenanceStatusColor, type MaintenanceTask } from '@/lib/maintenance';
import type { Priority } from '@/lib/types';
import { useTheme } from '@/theme/ThemeProvider';
import { useAudits } from '../dashboard/hooks';

const PRIORITIES: Priority[] = ['High', 'Medium', 'Low'];
const STATUS_TOKEN: Record<MaintenanceStatusColor, 'red' | 'amber' | 'green'> = { Red: 'red', Amber: 'amber', Green: 'green' };

// Ports the "Pallet" admin web's Maintenance board (UI reference screenshot)
// down to a field inspector's own assigned-task list — see src/lib/
// maintenance.ts for how a card's action/status is derived from the same
// findings Reported Audits already shows (Rules and Action defines the
// action pool per discrepancy type; Action Board assigns one + a status to
// each specific reported issue — this app has no admin surface for either,
// so both are derived deterministically instead of user-editable here).
export function MaintenanceScreen() {
  const { tokens } = useTheme();
  const { data: audits } = useAudits();
  const candidates = useMemo(() => (audits ? mine(audits) : []), [audits]);
  const candidateIds = useMemo(() => candidates.map((a) => a.audit_id), [candidates]);
  const { map: treeMap, isLoading } = useLocationsTreeMap(candidateIds);

  const [search, setSearch] = useState('');
  const [priority, setPriority] = useState<Priority | null>(null);
  const [sortDesc, setSortDesc] = useState(true);

  const tasks = useMemo(() => buildMaintenanceTasks(candidates, treeMap), [candidates, treeMap]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return tasks
      .filter((t) => !priority || t.priority === priority)
      .filter((t) => !q || [t.sku, t.name, t.rack, t.locCode, t.action, t.issueType].join(' ').toLowerCase().includes(q))
      .slice()
      .sort((a, b) => (sortDesc ? b.dueDate.localeCompare(a.dueDate) : a.dueDate.localeCompare(b.dueDate)));
  }, [tasks, search, priority, sortDesc]);

  if (isLoading) {
    return (
      <View style={[styles.loading, { backgroundColor: tokens.muted }]}>
        <ActivityIndicator color={tokens.primary} />
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: tokens.muted }}>
      <AppHeader title="Maintenance" sub="Follow-up actions assigned to reported issues" showBack menuItems={[{ label: 'Sync Now', onPress: () => {} }]} />

      <View style={styles.toolbar}>
        <View style={[styles.searchBox, { backgroundColor: tokens.card, borderColor: tokens.border, borderRadius: tokens.radius.lg }]}>
          <Ionicons name="search" size={16} color="#667085" />
          <TextInput
            value={search}
            onChangeText={setSearch}
            placeholder="Search SKU, rack, action..."
            placeholderTextColor={tokens.slate400}
            style={{ flex: 1, color: tokens.foreground, fontSize: tokens.text.sm, paddingVertical: 8 }}
          />
        </View>
        <Pressable onPress={() => setSortDesc((d) => !d)} style={[styles.iconBtn, { backgroundColor: tokens.card, borderColor: tokens.border, borderRadius: tokens.radius.lg }]}>
          <Ionicons name="swap-vertical-outline" size={18} color={tokens.foreground} />
        </Pressable>
      </View>

      <View style={styles.priorityRow}>
        {PRIORITIES.map((p) => {
          const active = priority === p;
          return (
            <Pressable
              key={p}
              onPress={() => setPriority(active ? null : p)}
              style={[styles.priorityChip, { backgroundColor: active ? tokens.accentBlue.soft : tokens.card, borderColor: active ? tokens.accentBlue.border : tokens.border }]}
            >
              <Text style={{ color: active ? tokens.accentBlue.strong : tokens.mutedForeground, fontWeight: tokens.fontWeight.semibold, fontSize: tokens.text.xs }}>{p}</Text>
              {active ? <Ionicons name="close" size={13} color={tokens.accentBlue.strong} style={{ marginLeft: 4 }} /> : null}
            </Pressable>
          );
        })}
      </View>

      <ScrollView contentContainerStyle={styles.body}>
        <View style={[styles.totalBadge, { backgroundColor: tokens.accentBlue.soft, borderRadius: tokens.radius.lg }]}>
          <Text style={{ color: tokens.accentBlue.strong, fontSize: tokens.text.xxs, fontWeight: tokens.fontWeight.bold }}>Total : {filtered.length}</Text>
        </View>

        {filtered.length ? (
          <View style={{ gap: 12 }}>
            {filtered.map((t) => (
              <MaintenanceCard key={t.id} task={t} />
            ))}
          </View>
        ) : (
          <View style={styles.empty}>
            <Ionicons name="checkmark-circle-outline" size={28} color="#667085" />
            <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.base }}>No maintenance tasks</Text>
            <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.sm }}>Nothing matches these filters.</Text>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

function fmtDue(iso: string): string {
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' });
}

function MaintenanceField({ label, value }: { label: string; value: string }) {
  const { tokens } = useTheme();
  return (
    <View style={{ width: '50%', marginBottom: 12 }}>
      <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xxs, marginBottom: 2 }}>{label}</Text>
      <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.semibold, fontSize: tokens.text.sm }} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

function MaintenanceCard({ task }: { task: MaintenanceTask }) {
  const { tokens } = useTheme();
  const ragKey = STATUS_TOKEN[task.statusColor];
  const priorityRag = task.priority === 'High' ? 'red' : task.priority === 'Medium' ? 'amber' : 'green';
  return (
    <Card style={{ padding: 0, overflow: 'hidden' }}>
      <View style={[styles.cardHead, { backgroundColor: tokens.muted, borderBottomColor: tokens.border }]}>
        <View style={styles.cardHeadLeft}>
          <Ionicons name="calendar-outline" size={14} color={tokens.mutedForeground} />
          <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xxs, fontWeight: tokens.fontWeight.semibold }}>Due Date :</Text>
          <Text style={{ color: tokens.foreground, fontSize: tokens.text.xxs, fontWeight: tokens.fontWeight.bold }}>{fmtDue(task.dueDate)}</Text>
        </View>
        <View style={[styles.statusPill, { backgroundColor: tokens.rag[ragKey].soft, borderColor: tokens.rag[ragKey].border }]}>
          <Text style={{ color: tokens.rag[ragKey].strong, fontSize: tokens.text.xxs, fontWeight: tokens.fontWeight.bold }}>{task.boardStatus}</Text>
        </View>
      </View>
      <View style={{ padding: 14 }}>
        <Text style={{ color: tokens.accentBlue.strong, fontWeight: tokens.fontWeight.semibold, fontSize: tokens.text.xxs, marginBottom: 8 }} numberOfLines={1}>
          {task.auditId} · {task.auditName}
        </Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
          <MaintenanceField label="Issue Type" value={task.issueType} />
          <MaintenanceField label="SKU" value={task.sku} />
          <MaintenanceField label="Rack Name" value={task.rack} />
          <MaintenanceField label="Action" value={task.action} />
        </View>
        <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xxs, marginBottom: 2 }}>Location</Text>
        <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.semibold, fontSize: tokens.text.sm, marginBottom: 12 }} numberOfLines={1}>
          {maintenanceLocationLabel(task)}
        </Text>
        <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xxs, marginBottom: 4 }}>Priority</Text>
        <View style={[styles.priorityBadge, { backgroundColor: tokens.rag[priorityRag].soft, borderColor: tokens.rag[priorityRag].border }]}>
          <View style={[styles.priorityDot, { backgroundColor: tokens.rag[priorityRag].strong }]} />
          <Text style={{ color: tokens.rag[priorityRag].strong, fontSize: tokens.text.xs, fontWeight: tokens.fontWeight.bold }}>{task.priority}</Text>
        </View>
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  toolbar: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 10 },
  searchBox: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, paddingHorizontal: 12 },
  iconBtn: { width: 38, height: 38, alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
  priorityRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: 16, paddingBottom: 10 },
  priorityChip: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6 },
  body: { padding: 16, paddingTop: 4, paddingBottom: 40 },
  totalBadge: { alignSelf: 'flex-start', paddingHorizontal: 10, paddingVertical: 4, marginBottom: 14 },
  empty: { alignItems: 'center', gap: 6, paddingVertical: 40 },
  cardHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 6, paddingHorizontal: 14, paddingVertical: 10, borderBottomWidth: 1 },
  cardHeadLeft: { flexDirection: 'row', alignItems: 'center', gap: 5, flexShrink: 1 },
  statusPill: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 },
  priorityBadge: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', borderWidth: 1, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 5 },
  priorityDot: { width: 6, height: 6, borderRadius: 3 },
});
