import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { AppHeader } from '@/components/AppHeader';
import { TodoCard } from '@/components/TodoCard';
import { MaintenanceTodoCard } from '@/components/MaintenanceTodoCard';
import { DUE_BUCKETS, dueBucket, type DueBucketKey } from '@/lib/auditLogic';
import { buildMaintenanceTasks, type MaintenanceTask } from '@/lib/maintenance';
import { useAuditProgressMap, useLocationsTreeMap } from '@/hooks/useLocationsTree';
import { useAuthStore } from '@/store/useAuthStore';
import type { Audit } from '@/lib/types';
import { useTheme } from '@/theme/ThemeProvider';
import { useMyAudits } from '../dashboard/hooks';

// The board now carries two distinct card types side by side in the same
// due-date columns — an Audit task (unchanged TodoCard) and a Maintenance/
// Field task (follow-up work on an already-reported issue, sourced the same
// way the standalone Maintenance screen builds its own list). A discriminated
// union keeps the two from being confused with each other when bucketing.
type BoardItem = { kind: 'audit'; audit: Audit } | { kind: 'maintenance'; task: MaintenanceTask };

// Same day-math as dueBucket(), just keyed off a plain ISO due date instead
// of an Audit's start/end — Maintenance tasks only ever carry the one date.
function dueBucketForDate(dueDateISO: string): DueBucketKey {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(dueDateISO + 'T00:00:00');
  const diffDays = Math.round((due.getTime() - today.getTime()) / 86400000);
  if (diffDays < 0) return 'Delayed';
  if (diffDays === 0) return 'Today';
  if (diffDays <= 7) return 'This Week';
  return 'This Month';
}

const COLUMN_COLOR: Record<(typeof DUE_BUCKETS)[number]['color'], 'red' | 'green' | 'accentBlue' | 'amber'> = {
  red: 'red',
  green: 'green',
  blue: 'accentBlue',
  amber: 'amber',
};

type TaskTypeFilter = 'Audit' | 'Maintenance';
type FilterCategory = 'type' | 'zone' | 'rack' | 'bay';
const CATEGORY_LABEL: Record<FilterCategory, string> = { type: 'Task Type', zone: 'Zone', rack: 'Rack', bay: 'Bay' };

// Flat layout/rack/bay location, sourced from either an audit's own
// allLocations() or a Maintenance task's direct rack/bay fields — the one
// shape the Zone/Rack/Bay filter needs to reason about both task types the
// same way.
type FilterLoc = { layout: string; rack: string; bay: string };

// Ports renderTasks() (rack-audit-app.html ~2067-2098) — a due-date kanban
// board (Delayed/Today/This Week/This Month), search filtered, with
// completed/closed audits dropped before bucketing (source: they aren't "to
// do" anymore regardless of due date).
export function TasksBoard() {
  const { tokens } = useTheme();
  const inspector = useAuthStore((s) => s.inspector);
  const { data: audits = [] } = useMyAudits();
  const [search, setSearch] = useState('');

  const [filterOpen, setFilterOpen] = useState(false);
  const [filterCategory, setFilterCategory] = useState<FilterCategory | null>(null);
  const [typeFilters, setTypeFilters] = useState<TaskTypeFilter[]>([]);
  const [zoneFilters, setZoneFilters] = useState<string[]>([]);
  const [rackFilters, setRackFilters] = useState<string[]>([]);
  const [bayFilters, setBayFilters] = useState<string[]>([]);

  const myTasks = useMemo(() => audits.filter((a) => !['Submitted', 'Reconciled', 'Closed'].includes(a.status)), [audits]);
  const q = search.trim().toLowerCase();

  const { map } = useAuditProgressMap(myTasks.map((a) => a.audit_id));

  // Search matches the same fields the Zone/Rack/Bay filter operates on —
  // no audit ID lookup, since that's not something an inspector browsing
  // by location would type.
  const searchedAudits = useMemo(
    () =>
      myTasks.filter((a) => {
        if (!q) return true;
        const locs = map[a.audit_id]?.allLocations ?? [];
        return locs.some((l) => [l.layout, l.rack, l.bay].join(' ').toLowerCase().includes(q));
      }),
    [myTasks, map, q],
  );

  // Maintenance/Field tasks — same source data + builder the standalone
  // Maintenance screen uses (every audit assigned to this inspector, not
  // just the ones still open, since a follow-up action can outlive the
  // audit it was raised on), filtered down to still-open work only.
  const maintenanceAuditIds = useMemo(() => audits.map((a) => a.audit_id), [audits]);
  const { map: maintenanceTreeMap } = useLocationsTreeMap(maintenanceAuditIds);
  const maintenanceTasks = useMemo(() => buildMaintenanceTasks(audits, maintenanceTreeMap), [audits, maintenanceTreeMap]);
  const openMaintenanceTasks = useMemo(() => maintenanceTasks.filter((t) => t.boardStatus !== 'Closed'), [maintenanceTasks]);
  const searchedMaintenance = useMemo(
    () => openMaintenanceTasks.filter((t) => !q || [t.layout, t.rack, t.bay].join(' ').toLowerCase().includes(q)),
    [openMaintenanceTasks, q],
  );

  // Every layout/rack/bay location touched by ANY audit or maintenance task
  // — the pool the Zone/Rack/Bay filter's option lists (and the cascading
  // Rack→Bay narrowing) are built from.
  const allFilterLocs = useMemo<FilterLoc[]>(() => {
    const locs: FilterLoc[] = [];
    myTasks.forEach((a) => (map[a.audit_id]?.allLocations ?? []).forEach((l) => locs.push({ layout: l.layout, rack: l.rack, bay: l.bay })));
    openMaintenanceTasks.forEach((t) => locs.push({ layout: t.layout, rack: t.rack, bay: t.bay }));
    return locs;
  }, [myTasks, map, openMaintenanceTasks]);

  const zoneOptions = useMemo(() => [...new Set(allFilterLocs.map((l) => l.layout))].sort(), [allFilterLocs]);
  const rackOptions = useMemo(() => {
    const pool = zoneFilters.length ? allFilterLocs.filter((l) => zoneFilters.includes(l.layout)) : allFilterLocs;
    return [...new Set(pool.map((l) => l.rack))].sort();
  }, [allFilterLocs, zoneFilters]);
  // Bay options only exist once at least one Rack is picked — there's no
  // "browse every bay in the warehouse" option, matching how a real
  // inspector actually narrows down (rack first, then which bay in it).
  const bayOptions = useMemo(() => {
    if (!rackFilters.length) return [];
    const pool = allFilterLocs.filter((l) => rackFilters.includes(l.rack) && (!zoneFilters.length || zoneFilters.includes(l.layout)));
    return [...new Set(pool.map((l) => l.bay))].sort();
  }, [allFilterLocs, rackFilters, zoneFilters]);

  // Dropping a Rack filter value can leave a previously-picked Bay
  // orphaned (it belonged to a rack that's no longer selected) — prune
  // those out instead of silently filtering by a bay the UI no longer
  // shows as selectable.
  const activeBayFilters = useMemo(() => bayFilters.filter((b) => bayOptions.includes(b)), [bayFilters, bayOptions]);

  const matchesLocFilters = (locs: FilterLoc[]) => {
    if (!zoneFilters.length && !rackFilters.length && !activeBayFilters.length) return true;
    return locs.some(
      (l) =>
        (!zoneFilters.length || zoneFilters.includes(l.layout)) &&
        (!rackFilters.length || rackFilters.includes(l.rack)) &&
        (!activeBayFilters.length || activeBayFilters.includes(l.bay)),
    );
  };

  const showAuditType = !typeFilters.length || typeFilters.includes('Audit');
  const showMaintenanceType = !typeFilters.length || typeFilters.includes('Maintenance');

  const filteredAudits = useMemo(
    () => (showAuditType ? searchedAudits.filter((a) => matchesLocFilters(map[a.audit_id]?.allLocations ?? [])) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [searchedAudits, map, showAuditType, zoneFilters, rackFilters, activeBayFilters],
  );
  const filteredMaintenance = useMemo(
    () => (showMaintenanceType ? searchedMaintenance.filter((t) => matchesLocFilters([{ layout: t.layout, rack: t.rack, bay: t.bay }])) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [searchedMaintenance, showMaintenanceType, zoneFilters, rackFilters, activeBayFilters],
  );

  const activeFilterCount = typeFilters.length + zoneFilters.length + rackFilters.length + activeBayFilters.length;
  const toggleIn = <T,>(list: T[], value: T, setList: (v: T[]) => void) =>
    setList(list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);

  const byBucket = useMemo(() => {
    const buckets: Record<DueBucketKey, BoardItem[]> = { Delayed: [], Today: [], 'This Week': [], 'This Month': [] };
    filteredAudits.forEach((a) => buckets[dueBucket(a)].push({ kind: 'audit', audit: a }));
    filteredMaintenance.forEach((t) => buckets[dueBucketForDate(t.dueDate)].push({ kind: 'maintenance', task: t }));
    return buckets;
  }, [filteredAudits, filteredMaintenance]);

  return (
    <View style={{ flex: 1, backgroundColor: tokens.muted }}>
      <AppHeader
        title="Tasks"
        sub={`${myTasks.length} Assigned · ${inspector?.warehouse ?? ''}`}
        showBack
        menuItems={[
          { label: 'Sync Now', onPress: () => {} },
          { label: 'Settings', onPress: () => router.push('/settings') },
        ]}
      />
      <View style={styles.searchWrap}>
        <View style={[styles.searchBox, { backgroundColor: tokens.card, borderColor: tokens.border, borderRadius: tokens.radius.lg }]}>
          <Ionicons name="search" size={16} color="#667085" />
          <TextInput
            value={search}
            onChangeText={setSearch}
            placeholder="Search zone, rack, bay..."
            placeholderTextColor={tokens.slate400}
            style={{ flex: 1, color: tokens.foreground, fontSize: tokens.text.sm, paddingVertical: 10 }}
          />
        </View>

        <View>
          <Pressable
            onPress={() => {
              setFilterOpen((o) => !o);
              setFilterCategory(null);
            }}
            style={[
              styles.filterBtn,
              { backgroundColor: activeFilterCount || filterOpen ? tokens.accentBlue.soft : tokens.card, borderColor: tokens.border, borderRadius: tokens.radius.lg },
            ]}
          >
            <Ionicons name="filter-outline" size={18} color={activeFilterCount || filterOpen ? tokens.accentBlue.strong : tokens.foreground} />
            {activeFilterCount ? (
              <View style={[styles.filterCountBadge, { backgroundColor: tokens.accentBlue.strong }]}>
                <Text style={{ color: tokens.card, fontSize: tokens.text.xxs, fontWeight: tokens.fontWeight.bold }}>{activeFilterCount}</Text>
              </View>
            ) : null}
          </Pressable>

          {filterOpen ? (
            <>
              <Pressable style={StyleSheet.absoluteFill} onPress={() => setFilterOpen(false)} />
              {filterCategory ? (
                <View style={[styles.filterCategoryPanel, { backgroundColor: tokens.popover, borderColor: tokens.border, borderRadius: tokens.radius.lg }]}>
                  <Text style={[styles.filterPanelTitle, { color: tokens.popoverForeground, borderBottomColor: tokens.border }]}>
                    {CATEGORY_LABEL[filterCategory]}
                  </Text>
                  {filterCategory === 'bay' && !rackFilters.length ? (
                    <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xs, paddingVertical: 10 }}>
                      Select a Rack first to choose a Bay.
                    </Text>
                  ) : (
                    <ScrollView style={{ maxHeight: 240 }}>
                      {(filterCategory === 'type' ? (['Audit', 'Maintenance'] as TaskTypeFilter[]) : filterCategory === 'zone' ? zoneOptions : filterCategory === 'rack' ? rackOptions : bayOptions).map((opt) => {
                        const checked =
                          filterCategory === 'type'
                            ? typeFilters.includes(opt as TaskTypeFilter)
                            : filterCategory === 'zone'
                              ? zoneFilters.includes(opt)
                              : filterCategory === 'rack'
                                ? rackFilters.includes(opt)
                                : activeBayFilters.includes(opt);
                        return (
                          <Pressable
                            key={opt}
                            onPress={() => {
                              if (filterCategory === 'type') toggleIn(typeFilters, opt as TaskTypeFilter, setTypeFilters);
                              else if (filterCategory === 'zone') toggleIn(zoneFilters, opt, setZoneFilters);
                              else if (filterCategory === 'rack') toggleIn(rackFilters, opt, setRackFilters);
                              else toggleIn(bayFilters, opt, setBayFilters);
                            }}
                            style={styles.filterChecklistRow}
                          >
                            <FilterCheckbox checked={checked} />
                            <Text style={{ color: tokens.popoverForeground, fontSize: tokens.text.sm }} numberOfLines={1}>
                              {opt}
                            </Text>
                          </Pressable>
                        );
                      })}
                    </ScrollView>
                  )}
                </View>
              ) : null}

              <View style={[styles.filterMainPanel, { backgroundColor: tokens.popover, borderColor: tokens.border, borderRadius: tokens.radius.lg }]}>
                <Text style={[styles.filterPanelTitle, { color: tokens.popoverForeground, borderBottomColor: tokens.border }]}>Filter By</Text>
                {(['type', 'zone', 'rack', 'bay'] as FilterCategory[]).map((cat) => {
                  // Bay stays visible but visibly disabled until a Rack is
                  // picked — an inspector always narrows rack-first, never
                  // jumps straight to "which bay in the whole warehouse".
                  const disabled = cat === 'bay' && !rackFilters.length;
                  return (
                    <Pressable
                      key={cat}
                      disabled={disabled}
                      onPress={() => setFilterCategory(filterCategory === cat ? null : cat)}
                      style={[styles.filterChecklistRow, disabled ? { opacity: 0.4 } : null]}
                    >
                      <Text
                        style={{
                          color: filterCategory === cat ? tokens.primary : tokens.popoverForeground,
                          fontSize: tokens.text.sm,
                          fontWeight: tokens.fontWeight.semibold,
                          flex: 1,
                        }}
                      >
                        {CATEGORY_LABEL[cat]}
                      </Text>
                      <Ionicons name={filterCategory === cat ? 'chevron-up' : 'chevron-down'} size={16} color="#667085" />
                    </Pressable>
                  );
                })}
              </View>
            </>
          ) : null}
        </View>

        <Pressable
          onPress={() => router.push('/tasks/map' as never)}
          style={[styles.mapBtn, { backgroundColor: tokens.card, borderColor: tokens.border, borderRadius: tokens.radius.lg }]}
        >
          <Ionicons name="cube-outline" size={16} color={tokens.foreground} />
          <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.semibold, fontSize: tokens.text.xs }}>View Tasks on 3D</Text>
        </Pressable>
      </View>
      <View style={styles.board}>
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
                  items.map((item) =>
                    item.kind === 'audit' ? (
                      <TodoCard key={item.audit.audit_id} audit={item.audit} rollup={map[item.audit.audit_id]?.rollup ?? EMPTY_ROLLUP} />
                    ) : (
                      <MaintenanceTodoCard key={item.task.id} task={item.task} />
                    ),
                  )
                ) : (
                  <Text style={{ color: tokens.slate400, fontSize: tokens.text.xs, textAlign: 'center', marginTop: 20 }}>Nothing here</Text>
                )}
              </ScrollView>
            </View>
          );
        })}
      </View>
    </View>
  );
}

function FilterCheckbox({ checked }: { checked: boolean }) {
  const { tokens } = useTheme();
  return (
    <View
      style={[
        styles.filterCheckbox,
        { borderRadius: tokens.radius.sm, borderColor: checked ? tokens.primary : tokens.border, backgroundColor: checked ? tokens.primary : 'transparent' },
      ]}
    >
      {checked ? <Ionicons name="checkmark" size={13} color={tokens.primaryForeground} /> : null}
    </View>
  );
}

const EMPTY_ROLLUP = { rackDone: 0, rackTotal: 0, bayDone: 0, bayTotal: 0, locDone: 0, locTotal: 0 };

const styles = StyleSheet.create({
  searchWrap: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingTop: 12 },
  searchBox: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, paddingHorizontal: 12 },
  mapBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: 1, height: 40, paddingHorizontal: 12 },
  filterBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
  filterCountBadge: { position: 'absolute', top: -4, right: -4, minWidth: 16, height: 16, borderRadius: 8, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 3 },
  filterMainPanel: { position: 'absolute', top: 44, left: 0, width: 200, borderWidth: 1, padding: 10, zIndex: 21 },
  filterCategoryPanel: { position: 'absolute', top: 44, left: 212, width: 200, borderWidth: 1, padding: 10, zIndex: 21 },
  filterPanelTitle: { fontSize: 12, fontWeight: '700', paddingBottom: 8, marginBottom: 4, borderBottomWidth: 1 },
  filterChecklistRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 9, paddingHorizontal: 2 },
  filterCheckbox: { width: 18, height: 18, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  board: { flex: 1, flexDirection: 'row', padding: 16, gap: 12 },
  column: { flex: 1 },
  columnHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingVertical: 8, marginBottom: 10 },
  countBadge: { paddingHorizontal: 7, paddingVertical: 2, borderRadius: 999 },
  columnBody: { flex: 1 },
});
