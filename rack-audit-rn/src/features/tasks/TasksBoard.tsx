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
type FilterCategory = 'type' | 'zoneValue' | 'layout' | 'rack' | 'bay';
const CATEGORY_LABEL: Record<FilterCategory, string> = { type: 'Task Type', zoneValue: 'Zone', layout: 'Layout', rack: 'Rack', bay: 'Bay' };

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
  const { data: audits = [] } = useMyAudits();
  const [search, setSearch] = useState('');

  const [filterOpen, setFilterOpen] = useState(false);
  const [filterCategory, setFilterCategory] = useState<FilterCategory | null>(null);
  const [categorySearch, setCategorySearch] = useState('');
  const [typeFilters, setTypeFilters] = useState<TaskTypeFilter[]>([]);
  // The actual Zone scope values raised on Zone-type audits (e.g. "Zone A")
  // — distinct from Layout, which is the warehouse layout a task's
  // locations live in.
  const [zoneValueFilters, setZoneValueFilters] = useState<string[]>([]);
  const [layoutFilters, setLayoutFilters] = useState<string[]>([]);
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

  const layoutOptions = useMemo(() => [...new Set(allFilterLocs.map((l) => l.layout))].sort(), [allFilterLocs]);
  const rackOptions = useMemo(() => {
    const pool = layoutFilters.length ? allFilterLocs.filter((l) => layoutFilters.includes(l.layout)) : allFilterLocs;
    return [...new Set(pool.map((l) => l.rack))].sort();
  }, [allFilterLocs, layoutFilters]);
  // Bay options only exist once at least one Rack is picked — there's no
  // "browse every bay in the warehouse" option, matching how a real
  // inspector actually narrows down (rack first, then which bay in it).
  const bayOptions = useMemo(() => {
    if (!rackFilters.length) return [];
    const pool = allFilterLocs.filter((l) => rackFilters.includes(l.rack) && (!layoutFilters.length || layoutFilters.includes(l.layout)));
    return [...new Set(pool.map((l) => l.bay))].sort();
  }, [allFilterLocs, rackFilters, layoutFilters]);

  // Every distinct Zone raised on a Zone-type audit — a Maintenance task
  // has no scope_type of its own, so it never matches a Zone filter.
  const zoneValueOptions = useMemo(
    () => [...new Set(myTasks.filter((a) => a.scope_type === 'Zone').flatMap((a) => a.scope_values))].sort(),
    [myTasks],
  );

  // Dropping a Rack filter value can leave a previously-picked Bay
  // orphaned (it belonged to a rack that's no longer selected) — prune
  // those out instead of silently filtering by a bay the UI no longer
  // shows as selectable.
  const activeBayFilters = useMemo(() => bayFilters.filter((b) => bayOptions.includes(b)), [bayFilters, bayOptions]);

  const matchesLocFilters = (locs: FilterLoc[]) => {
    if (!layoutFilters.length && !rackFilters.length && !activeBayFilters.length) return true;
    return locs.some(
      (l) =>
        (!layoutFilters.length || layoutFilters.includes(l.layout)) &&
        (!rackFilters.length || rackFilters.includes(l.rack)) &&
        (!activeBayFilters.length || activeBayFilters.includes(l.bay)),
    );
  };

  const showAuditType = !typeFilters.length || typeFilters.includes('Audit');
  const showMaintenanceType = !typeFilters.length || typeFilters.includes('Maintenance');

  const filteredAudits = useMemo(
    () =>
      showAuditType
        ? searchedAudits.filter(
            (a) =>
              matchesLocFilters(map[a.audit_id]?.allLocations ?? []) &&
              (!zoneValueFilters.length || (a.scope_type === 'Zone' && a.scope_values.some((v) => zoneValueFilters.includes(v)))),
          )
        : [],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [searchedAudits, map, showAuditType, layoutFilters, rackFilters, activeBayFilters, zoneValueFilters],
  );
  const filteredMaintenance = useMemo(
    () =>
      showMaintenanceType && !zoneValueFilters.length
        ? searchedMaintenance.filter((t) => matchesLocFilters([{ layout: t.layout, rack: t.rack, bay: t.bay }]))
        : [],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [searchedMaintenance, showMaintenanceType, layoutFilters, rackFilters, activeBayFilters, zoneValueFilters],
  );

  const activeFilterCount = typeFilters.length + zoneValueFilters.length + layoutFilters.length + rackFilters.length + activeBayFilters.length;
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
              <Pressable
                style={StyleSheet.absoluteFill}
                onPress={() => {
                  setFilterOpen(false);
                  setFilterCategory(null);
                }}
              />
              {filterCategory
                ? (() => {
                    const options =
                      filterCategory === 'type'
                        ? (['Audit', 'Maintenance'] as TaskTypeFilter[])
                        : filterCategory === 'zoneValue'
                          ? zoneValueOptions
                          : filterCategory === 'layout'
                            ? layoutOptions
                            : filterCategory === 'rack'
                              ? rackOptions
                              : bayOptions;
                    const cs = categorySearch.trim().toLowerCase();
                    const visibleOptions = cs ? options.filter((o) => o.toLowerCase().includes(cs)) : options;
                    return (
                      <View style={[styles.filterCategoryPanel, { backgroundColor: tokens.popover, borderColor: tokens.border, borderRadius: tokens.radius.lg }]}>
                        <View style={styles.filterCategoryHeadRow}>
                          <Text style={{ color: tokens.popoverForeground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.base }}>{CATEGORY_LABEL[filterCategory]}</Text>
                          <View style={[styles.categoryTotalBadge, { backgroundColor: tokens.accentBlue.soft, borderRadius: tokens.radius.lg }]}>
                            <Text style={{ color: tokens.accentBlue.strong, fontSize: tokens.text.xs, fontWeight: tokens.fontWeight.bold }}>Total : {options.length}</Text>
                          </View>
                        </View>
                        <View style={[styles.categorySearchBox, { backgroundColor: tokens.muted, borderColor: tokens.border, borderRadius: tokens.radius.lg }]}>
                          <Ionicons name="search" size={15} color="#667085" />
                          <TextInput
                            value={categorySearch}
                            onChangeText={setCategorySearch}
                            placeholder="Search"
                            placeholderTextColor={tokens.slate400}
                            style={{ flex: 1, color: tokens.foreground, fontSize: tokens.text.sm, paddingVertical: 6 }}
                          />
                        </View>
                        {filterCategory === 'bay' && !rackFilters.length ? (
                          <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xs, paddingVertical: 10 }}>
                            Select a Rack first to choose a Bay.
                          </Text>
                        ) : (
                          <ScrollView style={{ maxHeight: 260 }}>
                            {visibleOptions.map((opt) => {
                              const checked =
                                filterCategory === 'type'
                                  ? typeFilters.includes(opt as TaskTypeFilter)
                                  : filterCategory === 'zoneValue'
                                    ? zoneValueFilters.includes(opt)
                                    : filterCategory === 'layout'
                                      ? layoutFilters.includes(opt)
                                      : filterCategory === 'rack'
                                        ? rackFilters.includes(opt)
                                        : activeBayFilters.includes(opt);
                              return (
                                <Pressable
                                  key={opt}
                                  onPress={() => {
                                    if (filterCategory === 'type') toggleIn(typeFilters, opt as TaskTypeFilter, setTypeFilters);
                                    else if (filterCategory === 'zoneValue') toggleIn(zoneValueFilters, opt, setZoneValueFilters);
                                    else if (filterCategory === 'layout') toggleIn(layoutFilters, opt, setLayoutFilters);
                                    else if (filterCategory === 'rack') toggleIn(rackFilters, opt, setRackFilters);
                                    else toggleIn(bayFilters, opt, setBayFilters);
                                  }}
                                  style={styles.filterChecklistRow}
                                >
                                  <FilterCheckbox checked={checked} />
                                  <Text style={{ color: tokens.popoverForeground, fontSize: tokens.text.base }} numberOfLines={1}>
                                    {opt}
                                  </Text>
                                </Pressable>
                              );
                            })}
                          </ScrollView>
                        )}
                      </View>
                    );
                  })()
                : null}

              <View style={[styles.filterMainPanel, { backgroundColor: tokens.popover, borderColor: tokens.border, borderRadius: tokens.radius.lg }]}>
                <Text style={[styles.filterPanelTitle, { color: tokens.popoverForeground, borderBottomColor: tokens.border }]}>Select</Text>
                {(['type', 'zoneValue', 'layout', 'rack', 'bay'] as FilterCategory[]).map((cat) => {
                  // Bay stays visible but visibly disabled until a Rack is
                  // picked — an inspector always narrows rack-first, never
                  // jumps straight to "which bay in the whole warehouse".
                  const disabled = cat === 'bay' && !rackFilters.length;
                  const active = filterCategory === cat;
                  return (
                    <Pressable
                      key={cat}
                      disabled={disabled}
                      onPress={() => {
                        setFilterCategory(active ? null : cat);
                        setCategorySearch('');
                      }}
                      style={[styles.filterChecklistRow, active ? { backgroundColor: tokens.accentBlue.soft, borderRadius: tokens.radius.lg } : null, disabled ? { opacity: 0.4 } : null]}
                    >
                      <Text
                        style={{
                          color: active ? tokens.accentBlue.strong : tokens.popoverForeground,
                          fontSize: tokens.text.base,
                          fontWeight: tokens.fontWeight.semibold,
                          flex: 1,
                        }}
                      >
                        {CATEGORY_LABEL[cat]}
                      </Text>
                      <Ionicons name={active ? 'chevron-up' : 'chevron-down'} size={16} color={active ? tokens.accentBlue.strong : '#667085'} />
                    </Pressable>
                  );
                })}
              </View>
            </>
          ) : null}
        </View>
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
  filterBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
  filterCountBadge: { position: 'absolute', top: -4, right: -4, minWidth: 16, height: 16, borderRadius: 8, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 3 },
  filterMainPanel: { position: 'absolute', top: 44, left: 0, width: 220, borderWidth: 1, padding: 12, zIndex: 21 },
  // Opens to the LEFT of the main "Select" panel, not the right — matches
  // the reference where the category flyout hangs off the main panel's
  // near edge instead of extending further off-screen.
  filterCategoryPanel: { position: 'absolute', top: 44, left: -412, width: 380, borderWidth: 1, padding: 14, zIndex: 21 },
  filterCategoryHeadRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  categoryTotalBadge: { paddingHorizontal: 10, paddingVertical: 4 },
  categorySearchBox: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, paddingHorizontal: 10, marginBottom: 8 },
  filterPanelTitle: { fontSize: 13, fontWeight: '700', paddingBottom: 8, marginBottom: 4, borderBottomWidth: 1 },
  filterChecklistRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 9, paddingHorizontal: 6 },
  filterCheckbox: { width: 18, height: 18, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  board: { flex: 1, flexDirection: 'row', padding: 16, gap: 12 },
  column: { flex: 1 },
  columnHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingVertical: 8, marginBottom: 10 },
  countBadge: { paddingHorizontal: 7, paddingVertical: 2, borderRadius: 999 },
  columnBody: { flex: 1 },
});
