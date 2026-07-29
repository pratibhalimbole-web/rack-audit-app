import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { AppHeader } from '@/components/AppHeader';
import { TodoCard } from '@/components/TodoCard';
import { DUE_BUCKETS, dueBucket, type DueBucketKey } from '@/lib/auditLogic';
import { useAuditProgressMap } from '@/hooks/useLocationsTree';
import { useAuthStore } from '@/store/useAuthStore';
import type { Audit } from '@/lib/types';
import { useTheme } from '@/theme/ThemeProvider';
import { useMyAudits } from '../dashboard/hooks';

const COLUMN_COLOR: Record<(typeof DUE_BUCKETS)[number]['color'], 'red' | 'green' | 'accentBlue' | 'amber'> = {
  red: 'red',
  green: 'green',
  blue: 'accentBlue',
  amber: 'amber',
};

// Ports renderTasks() (rack-audit-app.html ~2067-2098) — a due-date kanban
// board (Delayed/Today/This Week/This Month), search filtered, with
// completed/closed audits dropped before bucketing (source: they aren't "to
// do" anymore regardless of due date).
export function TasksBoard() {
  const { tokens } = useTheme();
  const inspector = useAuthStore((s) => s.inspector);
  const { data: audits = [] } = useMyAudits();
  const [search, setSearch] = useState('');

  const myTasks = useMemo(() => audits.filter((a) => !['Submitted', 'Reconciled', 'Closed'].includes(a.status)), [audits]);
  const q = search.trim().toLowerCase();
  const searched = useMemo(
    () => myTasks.filter((a) => !q || [a.audit_id, a.audit_name, ...a.scope_values].join(' ').toLowerCase().includes(q)),
    [myTasks, q],
  );

  const byBucket = useMemo(() => {
    const buckets: Record<DueBucketKey, Audit[]> = { Delayed: [], Today: [], 'This Week': [], 'This Month': [] };
    searched.forEach((a) => buckets[dueBucket(a)].push(a));
    return buckets;
  }, [searched]);

  const { map } = useAuditProgressMap(myTasks.map((a) => a.audit_id));

  return (
    <View style={{ flex: 1, backgroundColor: tokens.muted }}>
      <AppHeader
        title="My Audit Tasks"
        sub={`${myTasks.length} Assigned · ${inspector?.warehouse ?? ''}`}
        showBack
        menuItems={[
          { label: 'Sync Now', onPress: () => {} },
          { label: 'Settings', onPress: () => router.push('/settings') },
        ]}
      />
      <View style={styles.searchWrap}>
        <View style={[styles.searchBox, { backgroundColor: tokens.card, borderColor: tokens.border, borderRadius: tokens.radius.lg }]}>
          <Ionicons name="search" size={16} color={tokens.mutedForeground} />
          <TextInput
            value={search}
            onChangeText={setSearch}
            placeholder="Search audit ID, layout, rack..."
            placeholderTextColor={tokens.slate400}
            style={{ flex: 1, color: tokens.foreground, fontSize: tokens.text.sm, paddingVertical: 10 }}
          />
        </View>
      </View>
      <ScrollView horizontal contentContainerStyle={styles.board} showsHorizontalScrollIndicator={false}>
        {DUE_BUCKETS.map(({ key, color }) => {
          const items = byBucket[key];
          const toneKey = COLUMN_COLOR[color];
          const headColor = toneKey === 'accentBlue' ? tokens.accentBlue : tokens.rag[toneKey];
          return (
            <View key={key} style={styles.column}>
              <View style={[styles.columnHead, { backgroundColor: headColor.soft, borderRadius: tokens.radius.lg }]}>
                <Text style={{ color: headColor.strong, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm }}>{key}</Text>
                <View style={[styles.countBadge, { backgroundColor: headColor.base }]}>
                  <Text style={{ color: tokens.card, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.xxs }}>
                    {String(items.length).padStart(2, '0')}
                  </Text>
                </View>
              </View>
              <ScrollView style={styles.columnBody} showsVerticalScrollIndicator={false}>
                {items.length ? (
                  items.map((a) => <TodoCard key={a.audit_id} audit={a} rollup={map[a.audit_id]?.rollup ?? EMPTY_ROLLUP} />)
                ) : (
                  <Text style={{ color: tokens.slate400, fontSize: tokens.text.xs, textAlign: 'center', marginTop: 20 }}>Nothing here</Text>
                )}
              </ScrollView>
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}

const EMPTY_ROLLUP = { rackDone: 0, rackTotal: 0, bayDone: 0, bayTotal: 0, locDone: 0, locTotal: 0 };

const styles = StyleSheet.create({
  searchWrap: { paddingHorizontal: 16, paddingTop: 12 },
  searchBox: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, paddingHorizontal: 12 },
  board: { padding: 16, gap: 12 },
  column: { width: 260 },
  columnHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingVertical: 8, marginBottom: 10 },
  countBadge: { paddingHorizontal: 7, paddingVertical: 2, borderRadius: 999 },
  columnBody: { flex: 1 },
});
