import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, useWindowDimensions, View } from 'react-native';
import { AppHeader } from '@/components/AppHeader';
import { TodoCard } from '@/components/TodoCard';
import { MaintenanceTodoCard } from '@/components/MaintenanceTodoCard';
import { useAuditProgressMap, useLocationsTreeMap } from '@/hooks/useLocationsTree';
import { mine } from '@/lib/auditLogic';
import { buildMaintenanceTasks } from '@/lib/maintenance';
import { useTheme } from '@/theme/ThemeProvider';
import { useAudits } from '../dashboard/hooks';

const COMPLETED_AUDIT_STATUSES = ['Submitted', 'Reconciled', 'Closed'];

// Same two-card-type board shape as Tasks (src/features/tasks/TasksBoard.tsx)
// — Audit cards (TodoCard) and Maintenance/Field cards (MaintenanceTodoCard)
// — but grouped under "Audits" / "Maintenance" headers instead of due-date
// columns, and showing only what's actually done: completed audits
// (Submitted/Reconciled/Closed) and closed maintenance follow-ups. The one
// card-level difference from Tasks' own cards is the extra "Action Taken"
// label on a closed Maintenance card (showActionTaken on MaintenanceTodoCard).
// Tasks (TasksBoard.tsx) lays 4 due-date columns across the same board
// padding/gap — this screen only has 2 (Audits/Maintenance), so letting
// them flex:1 the same way would render noticeably wider cards. Pin each
// column to the same width a Tasks column actually gets instead, so a card
// here reads as the same size as its Tasks counterpart rather than a
// stretched-out version of it.
const BOARD_PADDING = 16;
const BOARD_GAP = 12;
const TASKS_BOARD_COLUMNS = 4;

export function MaintenanceScreen() {
  const { tokens } = useTheme();
  const { width: winWidth } = useWindowDimensions();
  const columnWidth = (winWidth - BOARD_PADDING * 2 - BOARD_GAP * (TASKS_BOARD_COLUMNS - 1)) / TASKS_BOARD_COLUMNS;
  const { data: audits } = useAudits();
  const candidates = useMemo(() => (audits ? mine(audits) : []), [audits]);
  const candidateIds = useMemo(() => candidates.map((a) => a.audit_id), [candidates]);
  const { map: treeMap, isLoading } = useLocationsTreeMap(candidateIds);

  const [search, setSearch] = useState('');

  const completedAudits = useMemo(() => candidates.filter((a) => COMPLETED_AUDIT_STATUSES.includes(a.status)), [candidates]);
  const { map: progressMap } = useAuditProgressMap(completedAudits.map((a) => a.audit_id));

  const tasks = useMemo(() => buildMaintenanceTasks(candidates, treeMap), [candidates, treeMap]);
  const completedMaintenance = useMemo(() => tasks.filter((t) => t.boardStatus === 'Closed'), [tasks]);

  const q = search.trim().toLowerCase();
  const filteredAudits = useMemo(
    () => completedAudits.filter((a) => !q || [a.audit_id, a.audit_name].join(' ').toLowerCase().includes(q)),
    [completedAudits, q],
  );
  const filteredMaintenance = useMemo(
    () => completedMaintenance.filter((t) => !q || [t.sku, t.name, t.rack, t.locCode, t.action, t.issueType].join(' ').toLowerCase().includes(q)),
    [completedMaintenance, q],
  );

  if (isLoading) {
    return (
      <View style={[styles.loading, { backgroundColor: tokens.muted }]}>
        <ActivityIndicator color={tokens.primary} />
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: tokens.muted }}>
      <AppHeader title="Completed Task" sub="Completed audits and closed maintenance follow-ups" showBack menuItems={[{ label: 'Sync Now', onPress: () => {} }]} />

      <View style={styles.searchWrap}>
        <View style={[styles.searchBox, { backgroundColor: tokens.card, borderColor: tokens.border, borderRadius: tokens.radius.lg }]}>
          <Ionicons name="search" size={16} color="#667085" />
          <TextInput
            value={search}
            onChangeText={setSearch}
            placeholder="Search audit, SKU, rack, action..."
            placeholderTextColor={tokens.slate400}
            style={{ flex: 1, color: tokens.foreground, fontSize: tokens.text.sm, paddingVertical: 10 }}
          />
        </View>
      </View>

      <View style={styles.board}>
        <View style={[styles.column, { width: columnWidth }]}>
          <View style={[styles.columnHead, { backgroundColor: tokens.accentBlue.soft, borderRadius: tokens.radius.lg }]}>
            <Text style={{ color: tokens.accentBlue.strong, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm }}>Audits</Text>
            <View style={[styles.countBadge, { backgroundColor: tokens.accentBlue.base }]}>
              <Text style={{ color: tokens.card, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.xxs }}>
                {String(filteredAudits.length).padStart(2, '0')}
              </Text>
            </View>
          </View>
          <ScrollView style={styles.columnBody} showsVerticalScrollIndicator={false}>
            {filteredAudits.length ? (
              filteredAudits.map((a) => <TodoCard key={a.audit_id} audit={a} rollup={progressMap[a.audit_id]?.rollup ?? EMPTY_ROLLUP} hideStatus />)
            ) : (
              <Text style={{ color: tokens.slate400, fontSize: tokens.text.xs, textAlign: 'center', marginTop: 20 }}>Nothing here</Text>
            )}
          </ScrollView>
        </View>

        <View style={[styles.column, { width: columnWidth }]}>
          <View style={[styles.columnHead, { backgroundColor: tokens.accentBlue.soft, borderRadius: tokens.radius.lg }]}>
            <Text style={{ color: tokens.accentBlue.strong, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm }}>Maintenance</Text>
            <View style={[styles.countBadge, { backgroundColor: tokens.accentBlue.base }]}>
              <Text style={{ color: tokens.card, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.xxs }}>
                {String(filteredMaintenance.length).padStart(2, '0')}
              </Text>
            </View>
          </View>
          <ScrollView style={styles.columnBody} showsVerticalScrollIndicator={false}>
            {filteredMaintenance.length ? (
              filteredMaintenance.map((t) => <MaintenanceTodoCard key={t.id} task={t} showActionTaken />)
            ) : (
              <Text style={{ color: tokens.slate400, fontSize: tokens.text.xs, textAlign: 'center', marginTop: 20 }}>Nothing here</Text>
            )}
          </ScrollView>
        </View>
      </View>
      <View style={[styles.footerBar, { backgroundColor: tokens.card, borderTopColor: tokens.border }]}>
        <Pressable onPress={() => router.back()} style={[styles.footerBtn, styles.cancelBtn, { borderColor: tokens.border }]}>
          <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.base }}>Cancel</Text>
        </Pressable>
        <Pressable
          onPress={() => router.back()}
          style={[styles.footerBtn, { flex: 1.4, backgroundColor: tokens.primary, borderRadius: tokens.radius.lg }]}
        >
          <Text style={{ color: tokens.primaryForeground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.base }}>Complete Task</Text>
        </Pressable>
      </View>
    </View>
  );
}

const EMPTY_ROLLUP = { rackDone: 0, rackTotal: 0, bayDone: 0, bayTotal: 0, locDone: 0, locTotal: 0 };

const styles = StyleSheet.create({
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  searchWrap: { paddingHorizontal: 16, paddingTop: 12 },
  searchBox: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, paddingHorizontal: 12 },
  board: { flex: 1, flexDirection: 'row', padding: 16, gap: 12 },
  column: {},
  columnHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingVertical: 8, marginBottom: 10 },
  countBadge: { paddingHorizontal: 7, paddingVertical: 2, borderRadius: 999 },
  columnBody: { flex: 1 },
  footerBar: { flexDirection: 'row', gap: 12, padding: 16, borderTopWidth: StyleSheet.hairlineWidth },
  footerBtn: { flex: 1, height: 48, alignItems: 'center', justifyContent: 'center' },
  cancelBtn: { borderWidth: 1, borderRadius: 12 },
});
