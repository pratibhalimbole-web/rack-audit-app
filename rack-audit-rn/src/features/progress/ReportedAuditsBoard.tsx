import { Ionicons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { AppHeader } from '@/components/AppHeader';
import { Pill } from '@/components/Pill';
import { mismatchSeverity, mismatchType, skuMismatches, summaryStats, type FlaggedLine, type SkuMismatch } from '@/lib/auditLogic';
import { conditionSeverity } from '@/lib/conditionSeverity';
import { useLocationsTree } from '@/hooks/useLocationsTree';
import { CONDITIONS, type Condition } from '@/lib/types';
import { useTheme } from '@/theme/ThemeProvider';
import { useAudits } from '../dashboard/hooks';

type SortDir = 'asc' | 'desc';
type BoardView = 'issues' | 'mismatches';

function issueLineId(f: FlaggedLine): string {
  return [f.layout, f.rack, f.bay, f.locCode, f.pallet, f.sku].map(encodeURIComponent).join('~');
}

function mismatchKey(m: SkuMismatch): string {
  return [m.layout, m.rack, m.bay, m.locCode, m.pallet].map(encodeURIComponent).join('~');
}

// Ports renderProgressIssuesBoard() (rack-audit-app.html ~4094-4166) —
// tablet-only redesign of the Progress tab: search + sort-by-qty + rack/bay/
// condition filters over the audit's flagged (non-"Good") lines, as a card
// grid rather than the phone's rack/bay breakdown.
export function ReportedAuditsBoard() {
  const { tokens } = useTheme();
  const { auditId } = useLocalSearchParams<{ auditId: string }>();
  const { data: audits } = useAudits();
  const audit = audits?.find((a) => a.audit_id === auditId);
  const { data: tree, isLoading } = useLocationsTree(auditId);

  const [view, setView] = useState<BoardView>('issues');
  const [search, setSearch] = useState('');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [sortOpen, setSortOpen] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [filterRack, setFilterRack] = useState<string | null>(null);
  const [filterBay, setFilterBay] = useState<string | null>(null);
  const [filterCondition, setFilterCondition] = useState<Condition | null>(null);

  const stats = useMemo(() => summaryStats(tree), [tree]);
  const racks = useMemo(() => [...new Set(stats.flagged.map((f) => f.rack))].sort(), [stats]);
  const bays = useMemo(() => [...new Set(stats.flagged.map((f) => f.bay))].sort(), [stats]);
  const conditions = useMemo(() => CONDITIONS.filter((c) => c !== 'Good' && stats.flagged.some((f) => f.condition === c)), [stats]);

  const issues = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = stats.flagged.filter((f) => {
      if (filterRack && f.rack !== filterRack) return false;
      if (filterBay && f.bay !== filterBay) return false;
      if (filterCondition && f.condition !== filterCondition) return false;
      return !q || [f.sku, f.name, f.rack, f.locCode, f.pallet].join(' ').toLowerCase().includes(q);
    });
    return filtered.slice().sort((x, y) => (sortDir === 'asc' ? x.qty - y.qty : y.qty - x.qty));
  }, [stats, search, filterRack, filterBay, filterCondition, sortDir]);

  const mismatches = useMemo(() => {
    const q = search.trim().toLowerCase();
    const all = skuMismatches(tree);
    return all.filter(
      (m) => !q || [m.expected.sku, m.foundSku, m.rack, m.locCode, m.pallet].join(' ').toLowerCase().includes(q),
    );
  }, [tree, search]);

  const activeFilterCount = [filterRack, filterBay, filterCondition].filter(Boolean).length;

  if (!audit || isLoading) {
    return (
      <View style={[styles.loading, { backgroundColor: tokens.muted }]}>
        <ActivityIndicator color={tokens.primary} />
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: tokens.muted }}>
      <AppHeader title="Reported Audits" sub={`${audit.audit_id} · ${audit.scope_type} overview`} showBack menuItems={[{ label: 'Sync Now', onPress: () => {} }]} />

      {/* Reported Issues (condition-flagged lines, summaryStats) vs Mismatch
          SKUs (master-slot vs found-on-count discrepancies, skuMismatches) —
          two genuinely different data sources, so a toggle rather than a
          shared filter on one list. */}
      <View style={styles.viewToggleRow}>
        <View style={[styles.viewToggle, { borderColor: tokens.border, borderRadius: tokens.radius.lg }]}>
          <Pressable
            onPress={() => setView('issues')}
            style={[styles.viewToggleBtn, view === 'issues' ? { backgroundColor: tokens.primary } : null]}
          >
            <Text
              style={{
                color: view === 'issues' ? tokens.primaryForeground : tokens.foreground,
                fontWeight: tokens.fontWeight.semibold,
                fontSize: tokens.text.sm,
              }}
            >
              Reported Issues
            </Text>
          </Pressable>
          <Pressable
            onPress={() => setView('mismatches')}
            style={[styles.viewToggleBtn, view === 'mismatches' ? { backgroundColor: tokens.primary } : null]}
          >
            <Text
              style={{
                color: view === 'mismatches' ? tokens.primaryForeground : tokens.foreground,
                fontWeight: tokens.fontWeight.semibold,
                fontSize: tokens.text.sm,
              }}
            >
              Mismatch SKUs
            </Text>
          </Pressable>
        </View>
      </View>

      <View style={styles.toolbar}>
        <View style={[styles.searchBox, { backgroundColor: tokens.card, borderColor: tokens.border, borderRadius: tokens.radius.lg }]}>
          <Ionicons name="search" size={16} color={tokens.mutedForeground} />
          <TextInput
            value={search}
            onChangeText={setSearch}
            placeholder="Search SKU, rack, location..."
            placeholderTextColor={tokens.slate400}
            style={{ flex: 1, color: tokens.foreground, fontSize: tokens.text.sm, paddingVertical: 8 }}
          />
        </View>
        {view === 'issues' ? (
          <>
            <View style={[styles.sortChip, { backgroundColor: tokens.accentBlue.soft, borderRadius: tokens.radius.lg }]}>
              <Text style={{ color: tokens.accentBlue.strong, fontSize: tokens.text.xs, fontWeight: tokens.fontWeight.semibold }}>
                Qty · {sortDir === 'asc' ? 'Low to High' : 'High to Low'}
              </Text>
            </View>
            <View>
              <Pressable
                onPress={() => {
                  setFilterOpen((o) => !o);
                  setSortOpen(false);
                }}
                style={[styles.iconBtn, { backgroundColor: activeFilterCount ? tokens.accentBlue.soft : tokens.card, borderColor: tokens.border, borderRadius: tokens.radius.lg }]}
              >
                <Ionicons name="filter-outline" size={18} color={activeFilterCount ? tokens.accentBlue.strong : tokens.foreground} />
              </Pressable>
              {filterOpen ? (
                <>
                  <Pressable style={StyleSheet.absoluteFill} onPress={() => setFilterOpen(false)} />
                  <View style={[styles.dropdown, { backgroundColor: tokens.popover, borderColor: tokens.border, borderRadius: tokens.radius.lg }]}>
                    <FilterGroup title="Rack" options={racks} current={filterRack} onPick={(v) => setFilterRack(filterRack === v ? null : v)} />
                    <FilterGroup title="Bay" options={bays} current={filterBay} onPick={(v) => setFilterBay(filterBay === v ? null : v)} />
                    <FilterGroup title="Condition" options={conditions} current={filterCondition} onPick={(v) => setFilterCondition(filterCondition === v ? null : (v as Condition))} />
                    {activeFilterCount ? (
                      <Pressable
                        onPress={() => {
                          setFilterRack(null);
                          setFilterBay(null);
                          setFilterCondition(null);
                        }}
                        style={styles.dropdownItem}
                      >
                        <Text style={{ color: tokens.primary, fontSize: tokens.text.sm }}>Clear filters</Text>
                      </Pressable>
                    ) : null}
                  </View>
                </>
              ) : null}
            </View>
            <View>
              <Pressable
                onPress={() => {
                  setSortOpen((o) => !o);
                  setFilterOpen(false);
                }}
                style={[styles.iconBtn, { backgroundColor: tokens.card, borderColor: tokens.border, borderRadius: tokens.radius.lg }]}
              >
                <Ionicons name="swap-vertical-outline" size={18} color={tokens.foreground} />
              </Pressable>
              {sortOpen ? (
                <>
                  <Pressable style={StyleSheet.absoluteFill} onPress={() => setSortOpen(false)} />
                  <View style={[styles.dropdown, { backgroundColor: tokens.popover, borderColor: tokens.border, borderRadius: tokens.radius.lg }]}>
                    <Text style={[styles.dropdownTitle, { color: tokens.mutedForeground }]}>Sort by Qty</Text>
                    {(['asc', 'desc'] as SortDir[]).map((dir) => (
                      <Pressable
                        key={dir}
                        onPress={() => {
                          setSortDir(dir);
                          setSortOpen(false);
                        }}
                        style={styles.dropdownItem}
                      >
                        <Text style={{ color: tokens.popoverForeground, fontSize: tokens.text.sm }}>{dir === 'asc' ? 'Low to High' : 'High to Low'}</Text>
                        {sortDir === dir ? <Ionicons name="checkmark" size={16} color={tokens.primary} /> : null}
                      </Pressable>
                    ))}
                  </View>
                </>
              ) : null}
            </View>
          </>
        ) : null}
      </View>

      <ScrollView contentContainerStyle={styles.body}>
        {view === 'issues' ? (
          <>
            <View style={[styles.totalBadge, { backgroundColor: tokens.accentBlue.soft, borderRadius: tokens.radius.lg }]}>
              <Text style={{ color: tokens.accentBlue.strong, fontSize: tokens.text.xxs, fontWeight: tokens.fontWeight.bold }}>Total : {issues.length}</Text>
            </View>
            {issues.length ? (
              <View style={styles.grid}>
                {issues.map((f) => (
                  <IssueCard key={issueLineId(f)} auditId={auditId} issue={f} />
                ))}
              </View>
            ) : (
              <View style={styles.empty}>
                <Ionicons name="cube-outline" size={28} color={tokens.slate400} />
                <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.base }}>No reported issues</Text>
                <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.sm }}>Nothing matches these filters.</Text>
              </View>
            )}
          </>
        ) : (
          <>
            <View style={[styles.totalBadge, { backgroundColor: tokens.accentBlue.soft, borderRadius: tokens.radius.lg }]}>
              <Text style={{ color: tokens.accentBlue.strong, fontSize: tokens.text.xxs, fontWeight: tokens.fontWeight.bold }}>Total : {mismatches.length}</Text>
            </View>
            {mismatches.length ? (
              <View style={styles.grid}>
                {mismatches.map((m) => (
                  <MismatchCard key={mismatchKey(m)} auditId={auditId} mismatch={m} />
                ))}
              </View>
            ) : (
              <View style={styles.empty}>
                <Ionicons name="checkmark-circle-outline" size={28} color={tokens.slate400} />
                <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.base }}>No SKU mismatches</Text>
                <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.sm }}>
                  Every counted location matches the master inventory plan.
                </Text>
              </View>
            )}
          </>
        )}
      </ScrollView>
    </View>
  );
}

function FilterGroup<T extends string>({ title, options, current, onPick }: { title: string; options: T[]; current: T | null; onPick: (v: T) => void }) {
  const { tokens } = useTheme();
  if (!options.length) return null;
  return (
    <View>
      <Text style={[styles.dropdownTitle, { color: tokens.mutedForeground }]}>{title}</Text>
      {options.map((opt) => (
        <Pressable key={opt} onPress={() => onPick(opt)} style={styles.dropdownItem}>
          <Text style={{ color: tokens.popoverForeground, fontSize: tokens.text.sm }}>{opt}</Text>
          {current === opt ? <Ionicons name="checkmark" size={16} color={tokens.primary} /> : null}
        </Pressable>
      ))}
    </View>
  );
}

function IssueCard({ auditId, issue }: { auditId: string; issue: FlaggedLine }) {
  const { tokens } = useTheme();
  const sev = conditionSeverity(issue.condition);
  return (
    <Pressable
      onPress={() => router.push({ pathname: '/audit/[auditId]/issue/[lineId]', params: { auditId, lineId: issueLineId(issue) } } as never)}
      style={[styles.issueCard, { backgroundColor: tokens.card, borderColor: tokens.border, borderRadius: tokens.radius.xl }]}
    >
      <View style={styles.issueHeadRow}>
        <Ionicons name="cube-outline" size={16} color={tokens.mutedForeground} />
        <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xs }}>Pallet:</Text>
        <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm }}>{issue.pallet}</Text>
      </View>
      <View style={styles.issueGrid}>
        <IssueField label="Scanned SKU" value={issue.sku} />
        <IssueField label="Rack" value={issue.rack} />
        <IssueField label="Bay" value={issue.bay} />
        <IssueField label="No. of SKUs" value={String(issue.skuCount)} chip />
        <IssueField label="Quantity" value={String(issue.qty)} chip />
        <View style={styles.issueField}>
          <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xxs, marginBottom: 4 }}>Condition</Text>
          <Pill label={issue.condition} tone={issue.condition === 'Damaged' || issue.condition === 'Broken' ? 'High' : sev === 'green' ? 'Low' : 'Medium'} />
        </View>
      </View>
    </Pressable>
  );
}

function MismatchCard({ auditId, mismatch }: { auditId: string; mismatch: SkuMismatch }) {
  const { tokens } = useTheme();
  const severity = mismatchSeverity(mismatch);
  const type = mismatchType(mismatch);
  return (
    <Pressable
      onPress={() => router.push({ pathname: '/audit/[auditId]/discrepancy/[key]', params: { auditId, key: mismatchKey(mismatch) } } as never)}
      style={[styles.issueCard, { backgroundColor: tokens.card, borderColor: tokens.border, borderRadius: tokens.radius.xl }]}
    >
      <View style={styles.issueHeadRow}>
        <Ionicons name="git-compare-outline" size={16} color={tokens.mutedForeground} />
        <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xs }}>Location:</Text>
        <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm }}>{mismatch.locCode}</Text>
      </View>
      <View style={styles.issueGrid}>
        <IssueField label="Expected SKU" value={mismatch.expected.sku} />
        <IssueField label="Found SKU" value={mismatch.foundSku} />
        <IssueField label="Rack" value={mismatch.rack} />
        <IssueField label="Bay" value={mismatch.bay} />
        <IssueField label="Expected Qty" value={String(mismatch.expected.qty)} chip />
        <IssueField label="Found Qty" value={String(mismatch.foundQty)} chip />
      </View>
      <View style={styles.mismatchFooterRow}>
        <Pill label={type} tone={type === 'SKU Mismatch' ? 'High' : 'Medium'} />
        <Pill label={severity} tone={severity === 'Critical' ? 'High' : severity === 'Medium' ? 'Medium' : 'Low'} />
      </View>
    </Pressable>
  );
}

function IssueField({ label, value, chip }: { label: string; value: string; chip?: boolean }) {
  const { tokens } = useTheme();
  return (
    <View style={styles.issueField}>
      <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xxs, marginBottom: 4 }}>{label}</Text>
      {chip ? (
        <View style={[styles.numChip, { backgroundColor: tokens.muted, borderRadius: tokens.radius.sm }]}>
          <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.xs }}>{value}</Text>
        </View>
      ) : (
        <Text style={{ color: tokens.foreground, fontSize: tokens.text.sm }} numberOfLines={1}>
          {value}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  viewToggleRow: { paddingHorizontal: 16, paddingTop: 10 },
  viewToggle: { flexDirection: 'row', borderWidth: 1, padding: 3, alignSelf: 'flex-start' },
  viewToggleBtn: { paddingHorizontal: 16, height: 36, alignItems: 'center', justifyContent: 'center', borderRadius: 6 },
  mismatchFooterRow: { flexDirection: 'row', gap: 8, marginTop: 4 },
  toolbar: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingVertical: 10 },
  searchBox: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, paddingHorizontal: 12 },
  sortChip: { paddingHorizontal: 10, paddingVertical: 8 },
  iconBtn: { width: 38, height: 38, alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
  dropdown: { position: 'absolute', top: 44, right: 0, width: 180, borderWidth: 1, padding: 8, zIndex: 20 },
  dropdownTitle: { fontSize: 11, fontWeight: '700', marginTop: 6, marginBottom: 2, paddingHorizontal: 6 },
  dropdownItem: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 6, paddingVertical: 9 },
  body: { padding: 16 },
  totalBadge: { alignSelf: 'flex-start', paddingHorizontal: 10, paddingVertical: 4, marginBottom: 14 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 14 },
  // flexGrow+flexBasis (not a fixed width) so cards stretch to fill each
  // row evenly instead of leaving a blank column when they don't divide
  // the container width evenly (e.g. 4 cards fit, ~350px left over unused).
  issueCard: { flexGrow: 1, flexBasis: 260, borderWidth: 1, padding: 14 },
  issueHeadRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 12 },
  issueGrid: { flexDirection: 'row', flexWrap: 'wrap' },
  issueField: { width: '50%', marginBottom: 10 },
  numChip: { alignSelf: 'flex-start', paddingHorizontal: 8, paddingVertical: 2 },
  empty: { alignItems: 'center', gap: 8, paddingVertical: 60 },
});
