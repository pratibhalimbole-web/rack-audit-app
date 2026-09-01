import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { AppHeader } from '@/components/AppHeader';
import { mine, scopedIssues, summaryStats, type FlaggedLine, type ScopedIssue } from '@/lib/auditLogic';
import { conditionSeverity } from '@/lib/conditionSeverity';
import { useLocationsTreeMap } from '@/hooks/useLocationsTree';
import { CONDITIONS, type Condition } from '@/lib/types';
import { useZoneAuditStore, type ZoneScanRecord } from '@/store/useZoneAuditStore';
import { useTheme } from '@/theme/ThemeProvider';
import { useAudits } from '../dashboard/hooks';

type SortDir = 'asc' | 'desc';
type Severity = 'red' | 'amber' | 'green';
type FilterCategory = 'rack' | 'bay' | 'condition' | 'audit';
// A card's origin: 'scan' = the normal Reconciliation Form flow (a
// location's expected SKU was scanned/checked); 'manual' = Manual Mode's
// out-of-scope issue report. ScopedIssue (case1/case2) has no `source`
// field at all — it's only ever reachable through Reconciliation Form, so
// it's always treated as 'scan' for this filter.
type SourceType = 'scan' | 'manual';
const SOURCE_LABEL: Record<SourceType, string> = { scan: 'Reconciliation Form', manual: 'Manual Report' };

// Every card is tagged with the audit it came from — this board merges
// issues across every audit assigned to the inspector rather than locking
// to whichever one it was reached from, so a card can no longer be
// identified by its own fields alone.
type WithAudit<T> = T & { auditId: string; auditName: string };

function issueLineId(f: FlaggedLine): string {
  return [f.layout, f.rack, f.bay, f.locCode, f.pallet, f.sku].map(encodeURIComponent).join('~');
}

// The reconciliation form lets an inspector scan several SKUs under one
// pallet LPN, so a pallet can carry multiple independently-flagged lines
// (see mockData.ts's P-1202). Group flagged lines by pallet so each pallet
// gets one card listing every flagged SKU on it, instead of one card per line.
// Keyed by auditId too — two different audits can legitimately reuse the
// same pallet/location codes, and merging those into one card would be wrong.
type PalletIssueGroup = { key: string; auditId: string; auditName: string; layout: string; rack: string; bay: string; locCode: string; pallet: string; lines: FlaggedLine[] };

function groupByPallet(lines: WithAudit<FlaggedLine>[]): PalletIssueGroup[] {
  const groups = new Map<string, PalletIssueGroup>();
  for (const line of lines) {
    const key = [line.auditId, line.layout, line.rack, line.bay, line.locCode, line.pallet].map(encodeURIComponent).join('~');
    const existing = groups.get(key);
    if (existing) {
      existing.lines.push(line);
    } else {
      groups.set(key, {
        key,
        auditId: line.auditId,
        auditName: line.auditName,
        layout: line.layout,
        rack: line.rack,
        bay: line.bay,
        locCode: line.locCode,
        pallet: line.pallet,
        lines: [line],
      });
    }
  }
  return [...groups.values()];
}

function worstSeverity(lines: FlaggedLine[]): Severity {
  const rank: Record<Severity, number> = { green: 0, amber: 1, red: 2 };
  return lines.reduce<Severity>((worst, l) => {
    const sev = conditionSeverity(l.condition);
    return rank[sev] > rank[worst] ? sev : worst;
  }, 'green');
}

// A wrong SKU altogether is always the worst severity, regardless of its
// (irrelevant, since it's not even the right item) condition — matches how
// the existing SKU-mismatch severity already treats identity mismatches.
// A matched pallet's severity follows whichever is worse: its damage
// condition, or plain amber if the only issue is a quantity difference.
function scopedIssueSeverity(s: ScopedIssue): Severity {
  if (s.kind === 'mismatch') return 'red';
  if (s.condition !== 'Good') return conditionSeverity(s.condition);
  return 'amber';
}

function scopedIssueKey(s: WithAudit<ScopedIssue>): string {
  return [s.auditId, s.layout, s.rack, s.bay, s.locCode, s.pallet].map(encodeURIComponent).join('~');
}

function locationLabel(layout: string, rack: string, bay: string, locCode: string): string {
  return `${layout} · Rack ${rack}, Bay ${bay} · ${locCode}`;
}

// severity → the literal color word, so the card badge reads the same way
// as the reference design's Green/Amber/Red status chip.
const SEVERITY_BADGE: Record<Severity, { label: string; ragKey: Severity }> = {
  green: { label: 'Green', ragKey: 'green' },
  amber: { label: 'Amber', ragKey: 'amber' },
  red: { label: 'Red', ragKey: 'red' },
};

const CATEGORY_LABEL: Record<FilterCategory, string> = { rack: 'Rack Name', bay: 'Bay Name', condition: 'Damage', audit: 'Audit' };

// Ports renderProgressIssuesBoard() (rack-audit-app.html ~4094-4166) —
// tablet-only redesign of the Progress tab: search + sort-by-qty + rack/bay/
// condition filters over the audit's flagged (non-"Good") lines, as a card
// grid rather than the phone's rack/bay breakdown. Toolbar/filter picker/card
// layout reworked to match a reference "Maintenance" board design: a filter
// icon opens a floating multi-select picker (Severity quick-list + expandable
// category checklists), a persistent strip below the toolbar summarizes
// active selections as removable chips ("Close all" clears them), and cards
// get a due-date-style header with a colored status badge.
export function ReportedAuditsBoard({ auditId }: { auditId?: string } = {}) {
  const { tokens } = useTheme();
  const { data: audits } = useAudits();
  // Every audit assigned to the inspector, not just whichever one this
  // screen happened to be reached from — the board merges issues across
  // all of them into one list, UNLESS a specific auditId was passed in
  // (Audit Details' "View Full Rack/Bay Breakdown"), in which case it locks
  // to that single task instead of the universal cross-audit view.
  const candidates = useMemo(() => {
    if (!audits) return [];
    if (auditId) return audits.filter((a) => a.audit_id === auditId);
    return mine(audits);
  }, [audits, auditId]);
  const scopedAudit = auditId ? candidates[0] : null;
  const candidateIds = useMemo(() => candidates.map((a) => a.audit_id), [candidates]);

  // Zone-scoped audits never populate the rack/bay/loc tree — this board's
  // usual FlaggedLine/ScopedIssue pipeline can't see them at all, so their
  // issues come straight from useZoneAuditStore instead. Only shown when
  // this board is locked to one specific (zone-scoped) audit, same as
  // Audit Details' "View Reported Issues" entry point.
  const zoneScansByAudit = useZoneAuditStore((s) => s.scansByAudit);
  const zoneIssueLines = useMemo(() => {
    if (!scopedAudit || scopedAudit.scope_type !== 'Zone') return [];
    const byZone = zoneScansByAudit[scopedAudit.audit_id] ?? {};
    return Object.values(byZone)
      .flat()
      .filter((l) => {
        const mismatch = !!l.expectedZone && l.expectedZone !== l.scannedZone;
        const noExpectation = !l.expectedZone;
        return mismatch || noExpectation || l.qtyIssueRaised || l.damageIssueRaised;
      });
  }, [scopedAudit, zoneScansByAudit]);
  const { map: treeMap, isLoading } = useLocationsTreeMap(candidateIds);
  const auditNameById = useMemo(() => Object.fromEntries(candidates.map((a) => [a.audit_id, a.audit_name])), [candidates]);

  const [search, setSearch] = useState('');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [sortOpen, setSortOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [openCategory, setOpenCategory] = useState<FilterCategory | null>(null);
  const [filterRacks, setFilterRacks] = useState<string[]>([]);
  const [filterBays, setFilterBays] = useState<string[]>([]);
  const [filterConditions, setFilterConditions] = useState<Condition[]>([]);
  const [filterSources, setFilterSources] = useState<SourceType[]>([]);
  const [filterAudits, setFilterAudits] = useState<string[]>([]);

  // Every audit's flagged lines and scoped issues, each tagged with which
  // audit it came from — merged into one flat list so the rest of the
  // board (filtering, grouping, sections) works the same as the old
  // single-audit version, just over a bigger pool.
  const stats = useMemo(
    () =>
      candidates.flatMap((a) =>
        summaryStats(treeMap[a.audit_id]).flagged.map((f): WithAudit<FlaggedLine> => ({ ...f, auditId: a.audit_id, auditName: a.audit_name })),
      ),
    [candidates, treeMap],
  );
  // Case 1 (Mismatch) / Case 2 (Matched + qty/damage issue) — reconciled
  // against EXPECTED_SKUS directly, independent of whether "Raise Issue"
  // was ever tapped, since a real SKU/qty discrepancy is worth surfacing
  // either way. Case 3 (Manual Mode) has no expected SKU to reconcile
  // against at all, so it stays sourced from summaryStats/FlaggedLine below.
  const scoped = useMemo(
    () =>
      candidates.flatMap((a) => scopedIssues(treeMap[a.audit_id]).map((s): WithAudit<ScopedIssue> => ({ ...s, auditId: a.audit_id, auditName: a.audit_name }))),
    [candidates, treeMap],
  );
  const racks = useMemo(() => [...new Set([...stats.map((f) => f.rack), ...scoped.map((s) => s.rack)])].sort(), [stats, scoped]);
  const bays = useMemo(() => [...new Set([...stats.map((f) => f.bay), ...scoped.map((s) => s.bay)])].sort(), [stats, scoped]);
  const conditions = useMemo(
    () => CONDITIONS.filter((c) => c !== 'Good' && (stats.some((f) => f.condition === c) || scoped.some((s) => s.condition === c))),
    [stats, scoped],
  );
  // Only audits that actually contributed a card — an assigned audit with
  // nothing flagged yet would otherwise show up as a selectable filter with
  // no possible effect.
  const auditFilterOptions = useMemo(
    () => candidates.filter((a) => stats.some((f) => f.auditId === a.audit_id) || scoped.some((s) => s.auditId === a.audit_id)),
    [candidates, stats, scoped],
  );

  const issueGroups = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = stats.filter((f) => {
      if (filterAudits.length && !filterAudits.includes(f.auditId)) return false;
      if (filterRacks.length && !filterRacks.includes(f.rack)) return false;
      if (filterBays.length && !filterBays.includes(f.bay)) return false;
      if (filterConditions.length && !filterConditions.includes(f.condition)) return false;
      if (filterSources.length && !filterSources.includes(f.source === 'manual' ? 'manual' : 'scan')) return false;
      return !q || [f.sku, f.name, f.rack, f.locCode, f.pallet].join(' ').toLowerCase().includes(q);
    });
    const groups = groupByPallet(filtered);
    const qty = (g: PalletIssueGroup) => g.lines.reduce((sum, l) => sum + l.qty, 0);
    return groups.slice().sort((x, y) => (sortDir === 'asc' ? qty(x) - qty(y) : qty(y) - qty(x)));
  }, [stats, search, filterAudits, filterRacks, filterBays, filterConditions, filterSources, sortDir]);

  // Manual Mode reports (Case 3) still come from summaryStats/FlaggedLine —
  // every Manual Mode save always carries issueRaised, so it's reliably in
  // stats.flagged already. A group counts as Manual if any of its lines
  // came from that flow (a Manual Mode pallet is always a single
  // self-contained report, so in practice this is never a mix).
  const manualIssueGroups = useMemo(() => issueGroups.filter((g) => g.lines.some((l) => l.source === 'manual')), [issueGroups]);

  const filterScoped = (items: WithAudit<ScopedIssue>[]) => {
    const q = search.trim().toLowerCase();
    return items.filter((s) => {
      if (filterAudits.length && !filterAudits.includes(s.auditId)) return false;
      if (filterRacks.length && !filterRacks.includes(s.rack)) return false;
      if (filterBays.length && !filterBays.includes(s.bay)) return false;
      if (filterConditions.length && !filterConditions.includes(s.condition)) return false;
      // ScopedIssue has no `source` field — it's only ever reachable
      // through Reconciliation Form, so it's always 'scan' for this filter.
      if (filterSources.length && !filterSources.includes('scan')) return false;
      return !q || [s.foundSku, s.expectedSku, s.rack, s.locCode, s.pallet].join(' ').toLowerCase().includes(q);
    });
  };
  const sortByQty = (items: WithAudit<ScopedIssue>[]) => items.slice().sort((x, y) => (sortDir === 'asc' ? x.foundQty - y.foundQty : y.foundQty - x.foundQty));

  // Case 1 — wrong SKU scanned at an in-scope location.
  const case1Items = useMemo(
    () => sortByQty(filterScoped(scoped.filter((s) => s.kind === 'mismatch'))),
    [scoped, search, filterAudits, filterRacks, filterBays, filterConditions, filterSources, sortDir],
  );
  // Case 2 — right SKU, but a quantity or damage discrepancy.
  const case2Items = useMemo(
    () => sortByQty(filterScoped(scoped.filter((s) => s.kind === 'matched-issue'))),
    [scoped, search, filterAudits, filterRacks, filterBays, filterConditions, filterSources, sortDir],
  );
  // Toggle OFF (default) — only matched-but-off-on-qty/damage pallets.
  // Toggle ON ("Mismatch SKUs") — wrong-SKU pallets plus Manual Mode reports,
  // since both are location-level discrepancies outside a clean match.
  const viewTotal = case1Items.length + case2Items.length + manualIssueGroups.length + zoneIssueLines.length;

  const activeFilterCount = filterAudits.length + filterRacks.length + filterBays.length + filterConditions.length + filterSources.length;

  const toggleIn = <T,>(list: T[], value: T, setList: (v: T[]) => void) =>
    setList(list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);

  const clearAllFilters = () => {
    setFilterAudits([]);
    setFilterRacks([]);
    setFilterBays([]);
    setFilterConditions([]);
    setFilterSources([]);
  };

  if (isLoading) {
    return (
      <View style={[styles.loading, { backgroundColor: tokens.muted }]}>
        <ActivityIndicator color={tokens.primary} />
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: tokens.muted }}>
      <AppHeader
        title="Reported Audits"
        sub={scopedAudit ? `${scopedAudit.audit_id} · ${scopedAudit.audit_name}` : `${candidates.length} Assigned Audit${candidates.length === 1 ? '' : 's'} · Issue overview`}
        showBack
        menuItems={[{ label: 'Sync Now', onPress: () => {} }]}
      />

      <View style={styles.toolbar}>
        <View style={[styles.searchBox, { backgroundColor: tokens.card, borderColor: tokens.border, borderRadius: tokens.radius.lg }]}>
          <Ionicons name="search" size={16} color="#667085" />
          <TextInput
            value={search}
            onChangeText={setSearch}
            placeholder="Search SKU, rack, location..."
            placeholderTextColor={tokens.slate400}
            style={{ flex: 1, color: tokens.foreground, fontSize: tokens.text.sm, paddingVertical: 8 }}
          />
        </View>

        <View style={styles.toolbarIcons}>
          <View>
              <Pressable
                onPress={() => {
                  setPickerOpen((o) => !o);
                  setOpenCategory(null);
                  setSortOpen(false);
                }}
                style={[styles.iconBtn, { backgroundColor: activeFilterCount || pickerOpen ? tokens.accentBlue.soft : tokens.card, borderColor: tokens.border, borderRadius: tokens.radius.lg }]}
              >
                <Ionicons name="filter-outline" size={18} color={activeFilterCount || pickerOpen ? tokens.accentBlue.strong : tokens.foreground} />
              </Pressable>

              {pickerOpen ? (
                <>
                  {openCategory ? (
                    <View style={[styles.categoryPanel, { backgroundColor: tokens.popover, borderColor: tokens.border, borderRadius: tokens.radius.lg }]}>
                      <Text style={[styles.panelTitle, { color: tokens.popoverForeground, borderBottomColor: tokens.border }]}>{CATEGORY_LABEL[openCategory]}</Text>
                      <ScrollView style={{ maxHeight: 260 }}>
                        {(openCategory === 'rack'
                          ? racks
                          : openCategory === 'bay'
                            ? bays
                            : openCategory === 'audit'
                              ? auditFilterOptions.map((a) => a.audit_id)
                              : conditions
                        ).map((opt) => {
                          const list =
                            openCategory === 'rack' ? filterRacks : openCategory === 'bay' ? filterBays : openCategory === 'audit' ? filterAudits : filterConditions;
                          const checked = (list as string[]).includes(opt);
                          const label = openCategory === 'audit' ? (auditNameById[opt] ?? opt) : opt;
                          return (
                            <Pressable
                              key={opt}
                              onPress={() =>
                                openCategory === 'rack'
                                  ? toggleIn(filterRacks, opt, setFilterRacks)
                                  : openCategory === 'bay'
                                    ? toggleIn(filterBays, opt, setFilterBays)
                                    : openCategory === 'audit'
                                      ? toggleIn(filterAudits, opt, setFilterAudits)
                                      : toggleIn(filterConditions, opt as Condition, setFilterConditions)
                              }
                              style={styles.checklistRow}
                            >
                              <Checkbox checked={checked} />
                              <Text style={{ color: tokens.popoverForeground, fontSize: tokens.text.sm }} numberOfLines={1}>
                                {label}
                              </Text>
                            </Pressable>
                          );
                        })}
                      </ScrollView>
                    </View>
                  ) : null}

                  <View style={[styles.mainPanel, { backgroundColor: tokens.popover, borderColor: tokens.border, borderRadius: tokens.radius.lg }]}>
                    <Text style={[styles.panelTitle, { color: tokens.popoverForeground, borderBottomColor: tokens.border }]}>Type</Text>
                    {(['scan', 'manual'] as SourceType[]).map((src) => {
                      const checked = filterSources.includes(src);
                      return (
                        <Pressable key={src} onPress={() => toggleIn(filterSources, src, setFilterSources)} style={styles.checklistRow}>
                          <Ionicons name={src === 'manual' ? 'create-outline' : 'document-text-outline'} size={16} color={tokens.foreground} />
                          <Text style={{ color: tokens.popoverForeground, fontSize: tokens.text.sm, flex: 1 }}>{SOURCE_LABEL[src]}</Text>
                          <Checkbox checked={checked} />
                        </Pressable>
                      );
                    })}

                    <Text style={[styles.panelTitle, { color: tokens.popoverForeground, borderBottomColor: tokens.border, marginTop: 8 }]}>Select</Text>
                    {/* Filtering by Audit is meaningless once already locked to one task's breakdown. */}
                    {((scopedAudit ? ['condition', 'rack', 'bay'] : ['audit', 'condition', 'rack', 'bay']) as FilterCategory[]).map((cat) => (
                      <Pressable key={cat} onPress={() => setOpenCategory(openCategory === cat ? null : cat)} style={styles.checklistRow}>
                        <Text style={{ color: openCategory === cat ? tokens.primary : tokens.popoverForeground, fontSize: tokens.text.sm, fontWeight: tokens.fontWeight.semibold, flex: 1 }}>
                          {CATEGORY_LABEL[cat]}
                        </Text>
                        <Ionicons name={openCategory === cat ? 'chevron-up' : 'chevron-down'} size={16} color="#667085" />
                      </Pressable>
                    ))}
                  </View>
                </>
              ) : null}
          </View>

          <View>
            <Pressable
              onPress={() => {
                setSortOpen((o) => !o);
                setPickerOpen(false);
                setOpenCategory(null);
              }}
              style={[styles.iconBtn, { backgroundColor: tokens.card, borderColor: tokens.border, borderRadius: tokens.radius.lg }]}
            >
              <Ionicons name="swap-vertical-outline" size={18} color={tokens.foreground} />
            </Pressable>
            {sortOpen ? (
              <>
                <View style={[styles.sortDropdown, { backgroundColor: tokens.popover, borderColor: tokens.border, borderRadius: tokens.radius.lg }]}>
                  <Text style={[styles.panelTitle, { color: tokens.mutedForeground, borderBottomColor: tokens.border }]}>Sort by Qty</Text>
                  {(['desc', 'asc'] as SortDir[]).map((dir) => (
                    <Pressable
                      key={dir}
                      onPress={() => {
                        setSortDir(dir);
                        setSortOpen(false);
                      }}
                      style={styles.checklistRow}
                    >
                      <Text style={{ color: tokens.popoverForeground, fontSize: tokens.text.sm, flex: 1 }}>{dir === 'asc' ? 'Low to High' : 'High to Low'}</Text>
                      {sortDir === dir ? <Ionicons name="checkmark" size={16} color={tokens.primary} /> : null}
                    </Pressable>
                  ))}
                </View>
              </>
            ) : null}
          </View>
        </View>
      </View>

      {/* One full-screen catcher for both the filter picker and the sort
          dropdown — tapping anywhere outside either (the summary strip, the
          card list, empty space) closes whichever is open. Toolbar has a
          higher zIndex than this, so its own icons/panels stay on top and
          interactive while it's rendered. */}
      {pickerOpen || sortOpen ? (
        <Pressable
          style={[StyleSheet.absoluteFill, styles.dismissBackdrop]}
          onPress={() => {
            setPickerOpen(false);
            setOpenCategory(null);
            setSortOpen(false);
          }}
        />
      ) : null}

      {activeFilterCount ? (
        <View style={[styles.summary, { backgroundColor: tokens.card, borderColor: tokens.border, borderRadius: tokens.radius.lg }]}>
          <View style={styles.summaryTop}>
            <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.base }}>Total : {viewTotal}</Text>
            <SummaryChips
              label="Audit"
              values={filterAudits.map((id) => auditNameById[id] ?? id)}
              onRemove={(name) => setFilterAudits((l) => l.filter((id) => (auditNameById[id] ?? id) !== name))}
            />
            <SummaryChips label="Type" values={filterSources.map((s) => SOURCE_LABEL[s])} onRemove={(label) => setFilterSources((l) => l.filter((s) => SOURCE_LABEL[s] !== label))} />
            <SummaryChips label="Damage" values={filterConditions} onRemove={(v) => setFilterConditions((l) => l.filter((c) => c !== v))} />
            <SummaryChips label="Rack" values={filterRacks} onRemove={(v) => setFilterRacks((l) => l.filter((r) => r !== v))} />
            <SummaryChips label="Bay" values={filterBays} onRemove={(v) => setFilterBays((l) => l.filter((b) => b !== v))} />
          </View>
          <Pressable onPress={clearAllFilters} style={styles.closeAllRow}>
            <Text style={{ color: tokens.mutedForeground, fontWeight: tokens.fontWeight.semibold, fontSize: tokens.text.sm }}>Close all</Text>
            <Ionicons name="chevron-up" size={16} color="#667085" />
          </Pressable>
        </View>
      ) : null}

      <ScrollView contentContainerStyle={styles.body}>
        {!activeFilterCount ? (
          <View style={[styles.totalBadge, { backgroundColor: tokens.accentBlue.soft, borderRadius: tokens.radius.lg }]}>
            <Text style={{ color: tokens.accentBlue.strong, fontSize: tokens.text.xxs, fontWeight: tokens.fontWeight.bold }}>Total : {viewTotal}</Text>
          </View>
        ) : null}
        {case1Items.length || case2Items.length || manualIssueGroups.length || zoneIssueLines.length ? (
          <>
            {case1Items.length ? (
              <ScopedIssueSection
                title="Mismatch SKUs"
                subtitle="Wrong SKU scanned at a location this audit expected a specific item"
                icon="swap-horizontal-outline"
                items={case1Items}
              />
            ) : null}
            {case2Items.length ? (
              <ScopedIssueSection
                title="Matched SKUs — Quantity/Damage"
                subtitle="Right item found, but the quantity or damage doesn't match what's expected"
                icon="clipboard-outline"
                items={case2Items}
              />
            ) : null}
            {manualIssueGroups.length ? (
              <IssueSection
                title="Manually Reported"
                subtitle="Raised via Manual Mode, outside its audit's assigned scope"
                icon="hand-left-outline"
                groups={manualIssueGroups}
              />
            ) : null}
            {zoneIssueLines.length ? <ZoneIssueSection lines={zoneIssueLines} /> : null}
          </>
        ) : (
          <View style={styles.empty}>
            <Ionicons name="checkmark-circle-outline" size={28} color="#667085" />
            <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.base }}>No reported issues</Text>
            <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.sm }}>Nothing matches these filters.</Text>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

function Checkbox({ checked }: { checked: boolean }) {
  const { tokens } = useTheme();
  return (
    <View
      style={[
        styles.checkbox,
        { borderRadius: tokens.radius.sm, borderColor: checked ? tokens.primary : tokens.border, backgroundColor: checked ? tokens.primary : 'transparent' },
      ]}
    >
      {checked ? <Ionicons name="checkmark" size={13} color={tokens.primaryForeground} /> : null}
    </View>
  );
}

// Rounded, dot-free status badge for the card header — visually distinct
// from the shared Pill (used for compact inline tags elsewhere) since the
// reference's Green/Amber/Red header badge is a bigger, plainer chip.
function StatusBadge({ label, ragKey }: { label: string; ragKey: Severity }) {
  const { tokens } = useTheme();
  return (
    <View style={[styles.statusBadge, { backgroundColor: tokens.rag[ragKey].soft, borderRadius: tokens.radius.xl }]}>
      <Text style={{ color: tokens.rag[ragKey].strong, fontSize: tokens.text.xs, fontWeight: tokens.fontWeight.bold }}>{label}</Text>
    </View>
  );
}

function SummaryChips({ label, values, onRemove }: { label: string; values: string[]; onRemove: (v: string) => void }) {
  const { tokens } = useTheme();
  if (!values.length) return null;
  return (
    <View style={styles.chipRow}>
      <View style={[styles.chipDot, { backgroundColor: tokens.mutedForeground }]} />
      <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xs, fontWeight: tokens.fontWeight.semibold, marginRight: 4 }}>{label}</Text>
      {values.map((v) => (
        <Pressable key={v} onPress={() => onRemove(v)} style={[styles.chip, { backgroundColor: tokens.accentBlue.soft, borderRadius: tokens.radius.lg }]}>
          <Text style={{ color: tokens.accentBlue.strong, fontSize: tokens.text.xs, fontWeight: tokens.fontWeight.semibold }}>{v}</Text>
          <Ionicons name="close" size={13} color={tokens.accentBlue.strong} style={{ marginLeft: 4 }} />
        </Pressable>
      ))}
    </View>
  );
}

// Shared header for a labeled block of issue cards — icon, title + count
// badge, and a one-line explainer of what this section means. Used by all
// three case sections so a supervisor always knows what they're looking at
// without needing to infer it from the cards alone.
function SectionHead({ title, subtitle, icon, count }: { title: string; subtitle: string; icon: keyof typeof Ionicons.glyphMap; count: number }) {
  const { tokens } = useTheme();
  return (
    <View style={styles.sectionHead}>
      <View style={[styles.sectionIconWrap, { backgroundColor: tokens.accentBlue.soft, borderRadius: tokens.radius.lg }]}>
        <Ionicons name={icon} size={16} color={tokens.accentBlue.strong} />
      </View>
      <View style={{ flex: 1 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.extrabold, fontSize: tokens.text.base }}>{title}</Text>
          <View style={[styles.sectionCount, { backgroundColor: tokens.muted, borderRadius: tokens.radius.xl }]}>
            <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xxs, fontWeight: tokens.fontWeight.bold }}>{count}</Text>
          </View>
        </View>
        <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xs, marginTop: 1 }}>{subtitle}</Text>
      </View>
    </View>
  );
}

// Case 3 (Manual Mode) — keeps the pallet/SKU-list card shape, since it's
// sourced from FlaggedLine/summaryStats like before. Renders nothing when
// empty, so an active filter that only matches one section doesn't leave a
// dangling empty header.
function IssueSection({
  title,
  subtitle,
  icon,
  groups,
}: {
  title: string;
  subtitle: string;
  icon: keyof typeof Ionicons.glyphMap;
  groups: PalletIssueGroup[];
}) {
  if (!groups.length) return null;
  return (
    <View style={styles.section}>
      <SectionHead title={title} subtitle={subtitle} icon={icon} count={groups.length} />
      <View style={styles.grid}>
        {groups.map((g) => (
          <IssueCard key={g.key} auditId={g.auditId} group={g} />
        ))}
      </View>
    </View>
  );
}

// Cases 1 & 2 — reconciled directly against EXPECTED_SKUS (scopedIssues),
// so every card always shows Expected vs. Scanned, plus which location it's
// at. Not pressable: unlike Case 3's cards, these aren't sourced from
// summaryStats, so there's no existing detail screen that would resolve the
// same identity.
function ScopedIssueSection({
  title,
  subtitle,
  icon,
  items,
}: {
  title: string;
  subtitle: string;
  icon: keyof typeof Ionicons.glyphMap;
  items: WithAudit<ScopedIssue>[];
}) {
  if (!items.length) return null;
  return (
    <View style={styles.section}>
      <SectionHead title={title} subtitle={subtitle} icon={icon} count={items.length} />
      <View style={styles.grid}>
        {items.map((s) => (
          <ScopedIssueCard key={scopedIssueKey(s)} item={s} />
        ))}
      </View>
    </View>
  );
}

function ScopedIssueCard({ item }: { item: WithAudit<ScopedIssue> }) {
  const { tokens } = useTheme();
  const badge = SEVERITY_BADGE[scopedIssueSeverity(item)];
  return (
    <View style={[styles.issueCard, { backgroundColor: tokens.card, borderColor: tokens.border, borderRadius: tokens.radius.xl }]}>
      <View style={[styles.issueHeadRow, { backgroundColor: '#EEF3FF', borderTopLeftRadius: tokens.radius.xl, borderTopRightRadius: tokens.radius.xl }]}>
        <View style={styles.issueHeadLeft}>
          <Ionicons name={item.kind === 'mismatch' ? 'swap-horizontal-outline' : 'cube-outline'} size={16} color={tokens.primary} />
          <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.semibold, fontSize: tokens.text.sm }}>Pallet :</Text>
          <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm }}>{item.pallet}</Text>
        </View>
        <StatusBadge label={badge.label} ragKey={badge.ragKey} />
      </View>
      <View style={styles.cardBody}>
        <Text style={{ color: tokens.accentBlue.strong, fontWeight: tokens.fontWeight.semibold, fontSize: tokens.text.xxs, marginBottom: 8 }} numberOfLines={1}>
          {item.auditId} · {item.auditName}
        </Text>
        <View style={styles.issueGrid}>
          <IssueField label="Rack" value={item.rack} />
          <IssueField label="Bay" value={item.bay} />
        </View>
        <View style={styles.compareRow}>
          <View style={[styles.compareCol, { borderColor: tokens.border, borderRadius: tokens.radius.lg }]}>
            <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xxs, marginBottom: 4 }}>Expected</Text>
            <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm }} numberOfLines={1}>
              {item.expectedSku}
            </Text>
            <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xxs, marginTop: 2 }}>Qty {item.expectedQty}</Text>
          </View>
          <View style={[styles.compareCol, { borderColor: tokens.border, borderRadius: tokens.radius.lg }]}>
            <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xxs, marginBottom: 4 }}>Scanned</Text>
            <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm }} numberOfLines={1}>
              {item.foundSku}
            </Text>
            <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xxs, marginTop: 2 }}>Qty {item.foundQty}</Text>
          </View>
        </View>
        <View style={styles.skuConditionRow}>
          <View style={[styles.chipDot, { backgroundColor: tokens.rag[conditionSeverity(item.condition)].strong }]} />
          <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xxs }}>Damage: {item.condition}</Text>
        </View>
        <View style={[styles.locationRow, { borderTopColor: tokens.border }]}>
          <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xxs, marginBottom: 2 }}>Location</Text>
          <Text style={{ color: tokens.foreground, fontSize: tokens.text.sm, fontWeight: tokens.fontWeight.semibold }} numberOfLines={1}>
            {locationLabel(item.layout, item.rack, item.bay, item.locCode)}
          </Text>
        </View>
      </View>
    </View>
  );
}

// Zone Scan has no rack/bay/loc/pallet identity — its issue cards read the
// SKU itself plus where it was found vs. where WMS expects it, instead of a
// location breadcrumb. Not pressable: like ScopedIssueCard, there's no
// issue-detail screen keyed by a zone scan line's identity.
function zoneIssueSeverity(l: ZoneScanRecord): Severity {
  const mismatch = !!l.expectedZone && l.expectedZone !== l.scannedZone;
  if (mismatch) return 'red';
  if (l.damageIssueRaised && l.condition) return conditionSeverity(l.condition);
  return 'amber';
}

function ZoneIssueSection({ lines }: { lines: ZoneScanRecord[] }) {
  if (!lines.length) return null;
  return (
    <View style={styles.section}>
      <SectionHead
        title="Zone Scan Issues"
        subtitle="SKUs scanned in Zone Scan with a location, quantity, or damage discrepancy"
        icon="location-outline"
        count={lines.length}
      />
      <View style={styles.grid}>
        {lines.map((l, i) => (
          <ZoneIssueCard key={`${l.sku}~${l.label}~${i}`} line={l} />
        ))}
      </View>
    </View>
  );
}

function ZoneIssueCard({ line }: { line: ZoneScanRecord }) {
  const { tokens } = useTheme();
  const mismatch = !!line.expectedZone && line.expectedZone !== line.scannedZone;
  const noExpectation = !line.expectedZone;
  const badge = SEVERITY_BADGE[zoneIssueSeverity(line)];

  const tags: { label: string }[] = [];
  if (mismatch) tags.push({ label: 'Location Mismatch' });
  else if (noExpectation) tags.push({ label: 'No Expectation on Record' });
  if (line.qtyIssueRaised) tags.push({ label: 'Quantity Issue' });
  if (line.damageIssueRaised) tags.push({ label: 'Damage Issue' });

  return (
    <View style={[styles.issueCard, { backgroundColor: tokens.card, borderColor: tokens.border, borderRadius: tokens.radius.xl }]}>
      <View style={[styles.issueHeadRow, { backgroundColor: '#EEF3FF', borderTopLeftRadius: tokens.radius.xl, borderTopRightRadius: tokens.radius.xl }]}>
        <View style={styles.issueHeadLeft}>
          <Ionicons name="pricetag-outline" size={16} color={tokens.primary} />
          <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm }} numberOfLines={1}>
            {line.sku}
          </Text>
        </View>
        <StatusBadge label={badge.label} ragKey={badge.ragKey} />
      </View>
      <View style={styles.cardBody}>
        <Text style={{ color: tokens.foreground, fontSize: tokens.text.sm, fontWeight: tokens.fontWeight.semibold, marginBottom: 2 }} numberOfLines={1}>
          {line.name}
        </Text>
        <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xxs, marginBottom: 8 }} numberOfLines={1}>
          Label: {line.label}
        </Text>

        <View style={styles.compareRow}>
          <View style={[styles.compareCol, { borderColor: tokens.border, borderRadius: tokens.radius.lg }]}>
            <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xxs, marginBottom: 4 }}>Expected Zone</Text>
            <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm }} numberOfLines={1}>
              {line.expectedZone ?? 'None on record'}
            </Text>
          </View>
          <View style={[styles.compareCol, { borderColor: tokens.border, borderRadius: tokens.radius.lg }]}>
            <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xxs, marginBottom: 4 }}>Scanned Zone</Text>
            <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm }} numberOfLines={1}>
              {line.scannedZone}
            </Text>
          </View>
        </View>

        {/* Only shows what the inspector actually entered — a line can be
            a location mismatch/no-expectation card without ever having its
            Quantity or Damage fields touched at all. */}
        {line.qty != null || line.condition != null ? (
          <View style={styles.issueGrid}>
            {line.qty != null ? <IssueField label="Qty Entered" value={String(line.qty)} /> : null}
            {line.condition != null ? <IssueField label="Damage Entered" value={line.condition} /> : null}
          </View>
        ) : null}

        {tags.length ? (
          <View style={[styles.zoneTagRow]}>
            {tags.map((t) => (
              <View key={t.label} style={[styles.zoneTag, { backgroundColor: tokens.muted, borderColor: tokens.border }]}>
                <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xxs, fontWeight: tokens.fontWeight.semibold }}>{t.label}</Text>
              </View>
            ))}
          </View>
        ) : null}
      </View>
    </View>
  );
}

function IssueCard({ auditId, group }: { auditId: string; group: PalletIssueGroup }) {
  const { tokens } = useTheme();
  const badge = SEVERITY_BADGE[worstSeverity(group.lines)];
  return (
    <View style={[styles.issueCard, { backgroundColor: tokens.card, borderColor: tokens.border, borderRadius: tokens.radius.xl }]}>
      <View style={[styles.issueHeadRow, { backgroundColor: '#EEF3FF', borderTopLeftRadius: tokens.radius.xl, borderTopRightRadius: tokens.radius.xl }]}>
        <View style={styles.issueHeadLeft}>
          <Ionicons name="cube-outline" size={16} color={tokens.primary} />
          <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.semibold, fontSize: tokens.text.sm }}>Pallet :</Text>
          <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm }}>{group.pallet}</Text>
        </View>
        <StatusBadge label={badge.label} ragKey={badge.ragKey} />
      </View>
      <View style={styles.cardBody}>
        <Text style={{ color: tokens.accentBlue.strong, fontWeight: tokens.fontWeight.semibold, fontSize: tokens.text.xxs, marginBottom: 8 }} numberOfLines={1}>
          {group.auditId} · {group.auditName}
        </Text>
        <View style={styles.issueGrid}>
          <IssueField label="Rack" value={group.rack} />
          <IssueField label="Bay" value={group.bay} />
        </View>

        {/* One row per SKU scanned on this pallet — the reconciliation form
            lets an inspector log several SKUs under a single pallet LPN, so
            a pallet can carry more than one independently-flagged line. */}
        <View style={styles.skuList}>
          {group.lines.map((line) => {
            const sev = conditionSeverity(line.condition);
            return (
              <Pressable
                key={issueLineId(line)}
                onPress={() => router.push({ pathname: '/audit/[auditId]/issue/[lineId]', params: { auditId, lineId: issueLineId(line) } } as never)}
                style={[styles.skuRow, { borderColor: tokens.border, borderRadius: tokens.radius.lg }]}
              >
                <View style={styles.skuRowLeft}>
                  <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm }} numberOfLines={1}>
                    {line.sku}
                  </Text>
                  <View style={styles.skuConditionRow}>
                    <View style={[styles.chipDot, { backgroundColor: tokens.rag[sev].strong }]} />
                    <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xxs }}>{line.condition}</Text>
                  </View>
                </View>
                <View style={[styles.numChip, { backgroundColor: tokens.muted, borderRadius: tokens.radius.sm }]}>
                  <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.xs }}>Qty {line.qty}</Text>
                </View>
              </Pressable>
            );
          })}
        </View>
      </View>
    </View>
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
  toolbar: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 10, zIndex: 30 },
  dismissBackdrop: { zIndex: 15 },
  searchBox: { flexGrow: 0, flexBasis: 220, flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, paddingHorizontal: 12 },
  toolbarIcons: { flexDirection: 'row', alignItems: 'center', gap: 8, marginLeft: 'auto' },
  iconBtn: { width: 38, height: 38, alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
  // Two floating panels: the main picker (Severity + category list) anchored
  // under the filter icon, and — when a category is expanded — a second
  // checklist panel to its left, mirroring the reference's side-by-side
  // flyout rather than an inline accordion (plenty of width on a tablet).
  mainPanel: { position: 'absolute', top: 44, right: 0, width: 220, borderWidth: 1, padding: 10, zIndex: 21 },
  categoryPanel: { position: 'absolute', top: 44, right: 232, width: 220, borderWidth: 1, padding: 10, zIndex: 21 },
  sortDropdown: { position: 'absolute', top: 44, right: 0, width: 190, borderWidth: 1, padding: 10, zIndex: 21 },
  panelTitle: { fontSize: 12, fontWeight: '700', paddingBottom: 8, marginBottom: 4, borderBottomWidth: 1 },
  checklistRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 9, paddingHorizontal: 2 },
  checkbox: { width: 18, height: 18, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  summary: { marginHorizontal: 16, marginBottom: 12, borderWidth: 1, padding: 14 },
  summaryTop: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 10 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  chipDot: { width: 5, height: 5, borderRadius: 2.5 },
  chip: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingVertical: 6 },
  closeAllRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 4, marginTop: 8 },
  body: { padding: 16 },
  totalBadge: { alignSelf: 'flex-start', paddingHorizontal: 10, paddingVertical: 4, marginBottom: 14 },
  section: { marginBottom: 20 },
  sectionHead: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, marginBottom: 12 },
  sectionIconWrap: { width: 30, height: 30, alignItems: 'center', justifyContent: 'center' },
  sectionCount: { paddingHorizontal: 8, paddingVertical: 2 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 14 },
  // flexGrow+flexBasis (not a fixed width) so cards stretch to fill each
  // row evenly instead of leaving a blank column when they don't divide
  // the container width evenly (e.g. 4 cards fit, ~350px left over unused).
  issueCard: { flexGrow: 1, flexBasis: 260, borderWidth: 1, overflow: 'hidden' },
  issueHeadRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 6, paddingHorizontal: 14, paddingVertical: 12 },
  issueHeadLeft: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1 },
  statusBadge: { paddingHorizontal: 14, paddingVertical: 6, alignSelf: 'flex-start' },
  cardBody: { padding: 14 },
  issueGrid: { flexDirection: 'row', flexWrap: 'wrap' },
  issueField: { width: '50%', marginBottom: 10 },
  compareRow: { flexDirection: 'row', gap: 8, marginBottom: 10 },
  compareCol: { flex: 1, borderWidth: 1, padding: 10 },
  zoneTagRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 10 },
  zoneTag: { borderWidth: 1, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 4 },
  numChip: { alignSelf: 'flex-start', paddingHorizontal: 8, paddingVertical: 2 },
  skuList: { marginTop: 2, gap: 8 },
  skuRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, borderWidth: 1, paddingHorizontal: 10, paddingVertical: 9 },
  skuRowLeft: { flexShrink: 1, gap: 3 },
  skuConditionRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  locationRow: { borderTopWidth: 1, paddingTop: 10, marginTop: 2 },
  empty: { alignItems: 'center', gap: 8, paddingVertical: 60 },
});
