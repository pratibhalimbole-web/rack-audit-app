import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { AppHeader } from '@/components/AppHeader';
import { emptyLocations, mine, type EmptyLocation } from '@/lib/auditLogic';
import { buildFindings, findingRouteId, fmtInspected, type Finding, type FindingType } from '@/lib/findings';
import { useLocationsTreeMap } from '@/hooks/useLocationsTree';
import { useZoneAuditStore } from '@/store/useZoneAuditStore';
import { useTheme } from '@/theme/ThemeProvider';
import { useAudits } from '../dashboard/hooks';

type WithAudit<T> = T & { auditId: string; auditName: string };

const FINDING_BADGE: Record<FindingType, 'red' | 'amber' | 'accentBlue'> = {
  'Mismatched SKU': 'amber',
  'Missing SKU': 'accentBlue',
  Damage: 'red',
  'Manual Report': 'amber',
};

function badgeColors(tokens: ReturnType<typeof useTheme>['tokens'], type: FindingType) {
  const key = FINDING_BADGE[type];
  if (key === 'accentBlue') return { bg: tokens.accentBlue.soft, fg: tokens.accentBlue.strong };
  return { bg: tokens.rag[key].soft, fg: tokens.rag[key].strong };
}

const FINDING_TYPES: FindingType[] = ['Mismatched SKU', 'Missing SKU', 'Damage', 'Manual Report'];

// Ports renderProgressIssuesBoard() (rack-audit-app.html ~4094-4166), redone
// as a flat, unified "Reconciliation Findings" grid instead of the previous
// three-section layout — one card per discrepancy (Mismatched SKU, Missing
// SKU, Damage, or Manual Report), broken down to the individual Inventory
// Unit ID behind it wherever one was scanned. "Show Empty location" adds a
// second, differently-shaped card type for locations resolved via "Is the
// selected location pallet is empty?" — no SKU/unit id to show, so its own
// card and its own Issue Details layout (Pallet Condition, not Finding
// Type) — see src/lib/findings.ts and FindingDetailsScreen.
export function ReportedAuditsBoard({ auditId }: { auditId?: string } = {}) {
  const { tokens } = useTheme();
  const { data: audits } = useAudits();
  const candidates = useMemo(() => {
    if (!audits) return [];
    if (auditId) return audits.filter((a) => a.audit_id === auditId);
    return mine(audits);
  }, [audits, auditId]);
  const scopedAudit = auditId ? candidates[0] : null;
  const candidateIds = useMemo(() => candidates.map((a) => a.audit_id), [candidates]);
  const { map: treeMap, isLoading } = useLocationsTreeMap(candidateIds);

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

  const [search, setSearch] = useState('');
  const [showEmptyLocation, setShowEmptyLocation] = useState(false);
  const [sortDesc, setSortDesc] = useState(true);
  const [sortOpen, setSortOpen] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [filterTypes, setFilterTypes] = useState<FindingType[]>([]);

  const allFindings = useMemo(
    () => buildFindings(candidates, treeMap, zoneIssueLines, scopedAudit?.audit_id, scopedAudit?.audit_name),
    [candidates, treeMap, zoneIssueLines, scopedAudit],
  );
  const emptyFindings = useMemo(
    (): WithAudit<EmptyLocation>[] => candidates.flatMap((a) => emptyLocations(treeMap[a.audit_id]).map((e) => ({ ...e, auditId: a.audit_id, auditName: a.audit_name }))),
    [candidates, treeMap],
  );

  // "Show Empty location" SWITCHES the view, it doesn't add to it — on,
  // the grid is only resolved-empty locations; off (default), it's only
  // real findings. The two card shapes are different enough (no SKU/unit
  // id/Finding Type on an empty card at all) that mixing them in one grid
  // would read as a formatting error, not two kinds of the same thing.
  const findings = useMemo(() => {
    if (showEmptyLocation) return [];
    const q = search.trim().toLowerCase();
    const filtered = allFindings.filter((f) => {
      if (filterTypes.length && !filterTypes.includes(f.findingType)) return false;
      return !q || [f.sku, f.skuName, f.unitId, f.rack, f.bay, f.locCode, f.auditName, f.discId].join(' ').toLowerCase().includes(q);
    });
    return filtered.slice().sort((x, y) => (sortDesc ? y.sku.localeCompare(x.sku) : x.sku.localeCompare(y.sku)));
  }, [allFindings, search, filterTypes, sortDesc, showEmptyLocation]);

  const emptyCards = useMemo(() => {
    if (!showEmptyLocation) return [];
    const q = search.trim().toLowerCase();
    return emptyFindings.filter((e) => !q || [e.rack, e.bay, e.locCode, e.auditName].join(' ').toLowerCase().includes(q));
  }, [showEmptyLocation, emptyFindings, search]);

  const total = showEmptyLocation ? emptyCards.length : findings.length;
  const activeFilterCount = filterTypes.length;
  const toggleType = (t: FindingType) => setFilterTypes((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]));

  if (isLoading) {
    return (
      <View style={[styles.loading, { backgroundColor: tokens.muted }]}>
        <ActivityIndicator color={tokens.primary} />
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: tokens.muted }}>
      {/* No per-audit subtitle — this board always merges findings across
          every assigned audit now, so a single audit's name/id up here
          would misleadingly imply it's scoped to just that one. */}
      <AppHeader title="Reconciliation Findings" showBack menuItems={[{ label: 'Sync Now', onPress: () => {} }]} />

      <View style={styles.toolbar}>
        <View style={[styles.searchBox, { backgroundColor: tokens.card, borderColor: tokens.border, borderRadius: tokens.radius.lg }]}>
          <Ionicons name="search" size={16} color="#667085" />
          <TextInput
            value={search}
            onChangeText={setSearch}
            placeholder="Search..."
            placeholderTextColor={tokens.slate400}
            style={{ flex: 1, color: tokens.foreground, fontSize: tokens.text.sm, paddingVertical: 8 }}
          />
        </View>

        <Pressable onPress={() => setShowEmptyLocation((v) => !v)} style={styles.emptyToggleRow}>
          <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.semibold, fontSize: tokens.text.sm }}>Show Empty location</Text>
          <SmallToggle value={showEmptyLocation} onToggle={() => setShowEmptyLocation((v) => !v)} />
        </Pressable>

        <View style={styles.toolbarIcons}>
          <View>
            <Pressable
              onPress={() => {
                setFilterOpen((o) => !o);
                setSortOpen(false);
              }}
              style={[styles.iconBtn, { backgroundColor: activeFilterCount || filterOpen ? tokens.accentBlue.soft : tokens.card, borderColor: tokens.border, borderRadius: tokens.radius.lg }]}
            >
              <Ionicons name="filter-outline" size={18} color={activeFilterCount || filterOpen ? tokens.accentBlue.strong : tokens.foreground} />
              {activeFilterCount ? (
                <View style={[styles.filterCountBadge, { backgroundColor: tokens.accentBlue.strong }]}>
                  <Text style={{ color: tokens.card, fontSize: tokens.text.xxs, fontWeight: tokens.fontWeight.bold }}>{activeFilterCount}</Text>
                </View>
              ) : null}
            </Pressable>
            {filterOpen ? (
              <View style={[styles.mainPanel, { backgroundColor: tokens.popover, borderColor: tokens.border, borderRadius: tokens.radius.lg }]}>
                <Text style={[styles.panelTitle, { color: tokens.popoverForeground, borderBottomColor: tokens.border }]}>Finding Type</Text>
                {FINDING_TYPES.map((t) => {
                  const checked = filterTypes.includes(t);
                  return (
                    <Pressable key={t} onPress={() => toggleType(t)} style={styles.checklistRow}>
                      <Checkbox checked={checked} />
                      <Text style={{ color: tokens.popoverForeground, fontSize: tokens.text.sm, flex: 1 }} numberOfLines={1}>
                        {t}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
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
              <View style={[styles.sortDropdown, { backgroundColor: tokens.popover, borderColor: tokens.border, borderRadius: tokens.radius.lg }]}>
                <Text style={[styles.panelTitle, { color: tokens.mutedForeground, borderBottomColor: tokens.border }]}>Sort by SKU</Text>
                {[
                  { label: 'A to Z', desc: false },
                  { label: 'Z to A', desc: true },
                ].map((opt) => (
                  <Pressable
                    key={opt.label}
                    onPress={() => {
                      setSortDesc(opt.desc);
                      setSortOpen(false);
                    }}
                    style={styles.checklistRow}
                  >
                    <Text style={{ color: tokens.popoverForeground, fontSize: tokens.text.sm, flex: 1 }}>{opt.label}</Text>
                    {sortDesc === opt.desc ? <Ionicons name="checkmark" size={16} color={tokens.primary} /> : null}
                  </Pressable>
                ))}
              </View>
            ) : null}
          </View>
        </View>
      </View>

      {filterOpen || sortOpen ? (
        <Pressable
          style={[StyleSheet.absoluteFill, styles.dismissBackdrop]}
          onPress={() => {
            setFilterOpen(false);
            setSortOpen(false);
          }}
        />
      ) : null}

      <ScrollView contentContainerStyle={styles.body}>
        <View style={[styles.totalBadge, { backgroundColor: tokens.accentBlue.soft, borderRadius: tokens.radius.lg }]}>
          <Text style={{ color: tokens.accentBlue.strong, fontSize: tokens.text.sm, fontWeight: tokens.fontWeight.bold }}>Total : {String(total).padStart(2, '0')}</Text>
        </View>

        {total ? (
          <View style={styles.grid}>
            {findings.map((f, i) => (
              <FindingCard key={`${f.discId}-${f.unitId}-${i}`} finding={f} />
            ))}
            {emptyCards.map((e, i) => (
              <EmptyLocationCard key={`empty-${e.auditId}-${e.locCode}-${i}`} entry={e} />
            ))}
          </View>
        ) : (
          <View style={styles.empty}>
            <Ionicons name="checkmark-circle-outline" size={28} color="#667085" />
            <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.base }}>No findings</Text>
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

// Plain track+thumb, no label of its own — used next to "Show Empty
// location" where the adjacent text already is the label.
function SmallToggle({ value, onToggle }: { value: boolean; onToggle: () => void }) {
  const { tokens } = useTheme();
  return (
    <Pressable onPress={onToggle} hitSlop={8}>
      <View style={[styles.toggleTrack, { backgroundColor: value ? tokens.primary : tokens.slate300 }]}>
        <View style={[styles.toggleThumb, { left: value ? 16 : 2 }]} />
      </View>
    </Pressable>
  );
}

function FindingField({ label, value }: { label: string; value: string }) {
  const { tokens } = useTheme();
  return (
    <View style={styles.findingField}>
      <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xxs, marginBottom: 3 }}>{label}</Text>
      <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.semibold, fontSize: tokens.text.sm }} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

function FindingCard({ finding }: { finding: Finding }) {
  const { tokens } = useTheme();
  const badge = badgeColors(tokens, finding.findingType);
  return (
    <Pressable
      onPress={() => router.push({ pathname: '/finding/[findingId]', params: { findingId: findingRouteId(finding) } } as never)}
      style={[styles.findingCard, { backgroundColor: tokens.card, borderColor: tokens.border, borderRadius: tokens.radius.xl }]}
    >
      <View style={[styles.findingHead, { backgroundColor: tokens.accentBlue.soft, borderTopLeftRadius: tokens.radius.xl, borderTopRightRadius: tokens.radius.xl }]}>
        <Ionicons name="barcode-outline" size={16} color={tokens.accentBlue.strong} />
        <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.semibold, fontSize: tokens.text.sm }}>
          DISC-ID : <Text style={{ fontWeight: tokens.fontWeight.bold }}>{finding.discId}</Text>
        </Text>
      </View>
      <View style={styles.findingBody}>
        <View style={styles.findingRow}>
          <FindingField label="Event Name & ID" value={`${finding.auditName}-${finding.auditId}`} />
          <View style={styles.findingField}>
            <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xxs, marginBottom: 3 }}>Finding Type</Text>
            <View style={[styles.findingTypeBadge, { backgroundColor: badge.bg, borderRadius: tokens.radius.lg }]}>
              <Text style={{ color: badge.fg, fontSize: tokens.text.xs, fontWeight: tokens.fontWeight.bold }}>{finding.findingType}</Text>
            </View>
          </View>
        </View>
        <View style={styles.findingRow}>
          <FindingField label="SKU" value={finding.sku} />
          <FindingField label="Inventory unit id" value={finding.unitId} />
        </View>
        <FindingField label="Inspected on" value={finding.inspectedOn} />
      </View>
    </Pressable>
  );
}

// A resolved-empty location has no SKU/unit id/finding type at all, so the
// card reads location-first instead — same as Rack View's own location
// breadcrumb — and its own header leads with when it was checked, not a
// Discrepancy ID.
function EmptyLocationCard({ entry }: { entry: WithAudit<EmptyLocation> }) {
  const { tokens } = useTheme();
  return (
    <Pressable
      onPress={() => router.push({ pathname: '/finding/empty/[emptyId]', params: { emptyId: [entry.auditId, entry.locCode, entry.pallet].map(encodeURIComponent).join('~') } } as never)}
      style={[styles.findingCard, { backgroundColor: tokens.card, borderColor: tokens.border, borderRadius: tokens.radius.xl }]}
    >
      <View style={[styles.findingHead, { backgroundColor: tokens.accentBlue.soft, borderTopLeftRadius: tokens.radius.xl, borderTopRightRadius: tokens.radius.xl }]}>
        <Ionicons name="calendar-outline" size={16} color={tokens.accentBlue.strong} />
        <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.semibold, fontSize: tokens.text.sm }}>
          Inspected on : <Text style={{ fontWeight: tokens.fontWeight.bold }}>{fmtInspected()}</Text>
        </Text>
      </View>
      <View style={styles.findingBody}>
        <View style={styles.findingRow}>
          <FindingField label="Layout" value={entry.layout} />
          <FindingField label="Rack" value={entry.rack} />
        </View>
        <View style={styles.findingRow}>
          <FindingField label="Bay" value={entry.bay} />
          <FindingField label="Pallet" value={entry.pallet} />
        </View>
        <FindingField label="Event Name & ID" value={`${entry.auditName}-${entry.auditId}`} />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  toolbar: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 10, zIndex: 30 },
  dismissBackdrop: { zIndex: 15 },
  searchBox: { flexGrow: 1, flexBasis: 220, flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, paddingHorizontal: 12 },
  emptyToggleRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  toggleTrack: { width: 34, height: 20, borderRadius: 10 },
  toggleThumb: { position: 'absolute', top: 2, width: 16, height: 16, borderRadius: 8, backgroundColor: '#fff' },
  toolbarIcons: { flexDirection: 'row', alignItems: 'center', gap: 8, marginLeft: 'auto' },
  iconBtn: { width: 38, height: 38, alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
  filterCountBadge: { position: 'absolute', top: -4, right: -4, minWidth: 16, height: 16, borderRadius: 8, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 3 },
  mainPanel: { position: 'absolute', top: 44, right: 0, width: 200, borderWidth: 1, padding: 10, zIndex: 21 },
  sortDropdown: { position: 'absolute', top: 44, right: 0, width: 170, borderWidth: 1, padding: 10, zIndex: 21 },
  panelTitle: { fontSize: 12, fontWeight: '700', paddingBottom: 8, marginBottom: 4, borderBottomWidth: 1 },
  checklistRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 9, paddingHorizontal: 2 },
  checkbox: { width: 18, height: 18, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  body: { padding: 16 },
  totalBadge: { alignSelf: 'flex-start', paddingHorizontal: 12, paddingVertical: 5, marginBottom: 14 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 14 },
  // Pinned to a fixed 4-per-row width (not flexGrow-to-fill) so the grid
  // reads as a real 4x4 layout regardless of card content length, matching
  // the reference design instead of however many happen to fit.
  findingCard: { flexGrow: 0, flexShrink: 0, flexBasis: '23%', minWidth: 240, borderWidth: 1, overflow: 'hidden' },
  findingHead: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, paddingVertical: 10 },
  findingBody: { padding: 14, gap: 10 },
  findingRow: { flexDirection: 'row', gap: 10 },
  findingField: { flex: 1 },
  findingTypeBadge: { alignSelf: 'flex-start', paddingHorizontal: 10, paddingVertical: 4 },
  empty: { alignItems: 'center', gap: 8, paddingVertical: 60 },
});
