import { EXPECTED_SKUS, INSPECTOR, MASTER_INVENTORY, TODAY } from './mockData';
import type { Audit, AuditLocationsTree, Condition, Evidence, LocationNode, MasterSlot, Priority } from './types';

// Pure domain logic ported from rack-audit-app.html (~lines 1475-1555).
// Kept framework-agnostic (no React/Query here) so both TanStack Query
// selectors and plain screen code can reuse the exact same rules.

export function isOverdue(audit: Audit): boolean {
  const end = new Date(audit.end_date + 'T00:00:00');
  return end < TODAY && !['Submitted', 'Reconciled', 'Closed'].includes(audit.status);
}

// previewMode ('noAudits') from the source's studio toolbar isn't ported —
// that was a design-time preview toggle for the web prototype, not a real
// app feature.
export function mine(audits: Audit[]): Audit[] {
  return audits.filter((a) => a.team_members.includes(INSPECTOR.name));
}

export function currentOngoing(audits: Audit[]): Audit | undefined {
  return mine(audits).find((a) => a.status === 'In Progress' && !isOverdue(a));
}

export function fmtDate(iso: string): string {
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
}

export type UiStatus = 'Overdue' | 'Completed' | 'In Progress' | 'To Do';

export function uiStatus(a: Audit): UiStatus {
  if (isOverdue(a)) return 'Overdue';
  if (['Submitted', 'Reconciled', 'Closed'].includes(a.status)) return 'Completed';
  if (a.status === 'In Progress') return 'In Progress';
  return 'To Do';
}

export function pillClass(uis: UiStatus): string {
  return { 'To Do': 's-scheduled', 'In Progress': 's-inprogress', Completed: 's-completed', Overdue: 's-overdue' }[uis];
}

// To Do Task board groups by due date rather than status — a completed audit
// isn't "to do" anymore regardless of when it was due, so those are filtered
// out entirely before bucketing (by the screen) rather than getting a column
// of their own the way the old status tabs gave them one.
export const DUE_BUCKETS = [
  { key: 'Delayed', color: 'red' },
  { key: 'Today', color: 'green' },
  { key: 'This Week', color: 'blue' },
  { key: 'This Month', color: 'amber' },
] as const;

export type DueBucketKey = (typeof DUE_BUCKETS)[number]['key'];

export function dueBucket(a: Audit): DueBucketKey {
  if (isOverdue(a)) return 'Delayed';
  const end = new Date(a.end_date + 'T00:00:00');
  const diffDays = Math.round((end.getTime() - TODAY.getTime()) / 86400000);
  if (diffDays <= 0) return 'Today';
  if (diffDays <= 7) return 'This Week';
  return 'This Month';
}

export function priorityFor(a: Audit): Priority {
  if (a.priority) return a.priority;
  const n = a.audit_id.replace(/\D/g, '');
  const m = Number(n) % 3;
  return (['High', 'Medium', 'Low'] as const)[m];
}

export type LocationEntry = { layout: string; rack: string; bay: string; loc: LocationNode };

export function allLocations(tree: AuditLocationsTree | undefined): LocationEntry[] {
  const layouts = tree?.layouts ?? [];
  const out: LocationEntry[] = [];
  layouts.forEach((ly) =>
    ly.racks.forEach((r) => r.bays.forEach((b) => b.locations.forEach((l) => out.push({ layout: ly.name, rack: r.code, bay: b.code, loc: l })))),
  );
  return out;
}

// One row per bay, with the location to open by default (its first
// not-yet-completed location, or its first location if every one's done).
// Shared by Audit Details' bay pill grid and Dashboard's Resume Audit
// shortcut, so both land on the exact same "next thing to do" bay.
export type FlatBay = { layout: string; rack: string; code: string; done: boolean; openLoc: string | null };

export function flattenBays(tree: AuditLocationsTree | undefined): FlatBay[] {
  const layouts = tree?.layouts ?? [];
  const out: FlatBay[] = [];
  layouts.forEach((ly) =>
    ly.racks.forEach((rack) =>
      rack.bays.forEach((b) => {
        const done = b.locations.length > 0 && b.locations.every((l) => l.status === 'Completed');
        const openLoc = b.locations.find((l) => l.status !== 'Completed') ?? b.locations[0];
        out.push({ layout: ly.name, rack: rack.code, code: b.code, done, openLoc: openLoc ? openLoc.code : null });
      }),
    ),
  );
  return out;
}

export type Rollup = { rackDone: number; rackTotal: number; bayDone: number; bayTotal: number; locDone: number; locTotal: number };

export function rollup(tree: AuditLocationsTree | undefined): Rollup {
  const layouts = tree?.layouts ?? [];
  const locs = allLocations(tree);
  const locDone = locs.filter((x) => x.loc.status === 'Completed').length;
  let bayTotal = 0;
  let bayDone = 0;
  let rackTotal = 0;
  let rackDone = 0;
  layouts.forEach((ly) =>
    ly.racks.forEach((r) => {
      rackTotal++;
      if (r.bays.every((b) => b.locations.every((l) => l.status === 'Completed'))) rackDone++;
      r.bays.forEach((b) => {
        bayTotal++;
        if (b.locations.every((l) => l.status === 'Completed')) bayDone++;
      });
    }),
  );
  return { rackDone, rackTotal, bayDone, bayTotal, locDone, locTotal: locs.length };
}

export function lastSaved(tree: AuditLocationsTree | undefined): LocationEntry | null {
  const withPallets = allLocations(tree)
    .filter((x) => x.loc.pallets.length > 0)
    .reverse();
  return withPallets.length ? withPallets[0] : null;
}

export function nextPending(tree: AuditLocationsTree | undefined): LocationEntry | null {
  return allLocations(tree).find((x) => x.loc.status !== 'Completed') || null;
}

export type FlaggedLine = {
  layout: string;
  rack: string;
  bay: string;
  locCode: string;
  pallet: string;
  sku: string;
  name: string;
  qty: number;
  condition: Condition;
  skuCount: number;
  lot: string;
  evidence?: Evidence;
  // Whether the inspector explicitly raised this via Rack View's Raise
  // Issue (Mismatch, quantity/damage discrepancy, or any Manual Mode
  // report) — distinct from a line just happening to have a non-Good
  // condition without ever being flagged.
  issueRaised?: boolean;
  // 'manual' marks a Rack View Manual Mode report — outside the audit's
  // assigned target_sku scope, only reportable because Manual Mode was on.
  source?: 'scan' | 'manual';
};

export type SummaryStats = {
  palletCount: number;
  lineCount: number;
  qtyTotal: number;
  byCondition: Partial<Record<Condition, number>>;
  flagged: FlaggedLine[];
};

// Ports summaryStats() (rack-audit-app.html ~1531-1550): aggregates
// everything actually counted for an audit — pallets, SKU lines, quantity, a
// condition breakdown — plus a flat list of non-"Good" lines worth a second
// look. Used by Audit Summary, Progress's Reported Audits board, and Issue
// Details (which re-derives one flagged entry from this list by its
// identifying fields rather than passing the whole object through nav
// params, so it always reflects live state).
export function summaryStats(tree: AuditLocationsTree | undefined): SummaryStats {
  let palletCount = 0;
  let lineCount = 0;
  let qtyTotal = 0;
  const byCondition: Partial<Record<Condition, number>> = {};
  const flagged: FlaggedLine[] = [];

  allLocations(tree).forEach(({ layout, rack, bay, loc }) => {
    (loc.pallets || []).forEach((p) => {
      palletCount++;
      (p.lines || []).forEach((line) => {
        lineCount++;
        qtyTotal += line.qty;
        byCondition[line.condition] = (byCondition[line.condition] ?? 0) + line.qty;
        // A line is worth a second look either because its condition says
        // so, or because an inspector explicitly raised it — a Mismatch or
        // Manual Mode report can carry issueRaised with condition still
        // 'Good' (e.g. a qty-only or wrong-SKU issue), and would otherwise
        // never surface here.
        if (line.condition !== 'Good' || line.issueRaised) {
          flagged.push({
            layout,
            rack,
            bay,
            locCode: loc.code,
            pallet: p.pallet,
            sku: line.sku,
            name: line.name,
            qty: line.qty,
            condition: line.condition,
            skuCount: (p.lines || []).length,
            lot: line.lot,
            evidence: line.evidence,
            issueRaised: line.issueRaised,
            source: line.source,
          });
        }
      });
    });
  });

  return { palletCount, lineCount, qtyTotal, byCondition, flagged };
}

export type SkuMismatch = {
  layout: string;
  rack: string;
  bay: string;
  locCode: string;
  pallet: string;
  expected: MasterSlot;
  foundSku: string;
  foundName: string;
  foundLot: string;
  foundQty: number;
  evidence?: Evidence;
};

// Compares each location's master-slotted SKU/qty (MASTER_INVENTORY, what
// the warehouse plan says should be there) against what the first pallet
// actually recorded — a real discrepancy check, not the condition-based
// "flagged" list summaryStats() already covers. Only locations with an
// actual difference are returned.
export function skuMismatches(tree: AuditLocationsTree | undefined): SkuMismatch[] {
  const out: SkuMismatch[] = [];
  allLocations(tree).forEach(({ layout, rack, bay, loc }) => {
    const expected = MASTER_INVENTORY[loc.code];
    const found = loc.pallets[0]?.lines[0];
    if (!expected || !found) return;
    if (found.sku !== expected.sku || found.qty !== expected.qty) {
      out.push({
        layout,
        rack,
        bay,
        locCode: loc.code,
        pallet: loc.pallets[0].pallet,
        expected,
        foundSku: found.sku,
        foundName: found.name,
        foundLot: found.lot,
        foundQty: found.qty,
        evidence: found.evidence,
      });
    }
  });
  return out;
}

export function mismatchType(m: SkuMismatch): 'SKU Mismatch' | 'Quantity Variance' {
  return m.foundSku !== m.expected.sku ? 'SKU Mismatch' : 'Quantity Variance';
}

export function mismatchSeverity(m: SkuMismatch): 'Critical' | 'Medium' | 'Low' {
  if (m.foundSku !== m.expected.sku) return 'Critical';
  const diffPct = Math.abs(m.foundQty - m.expected.qty) / Math.max(1, m.expected.qty);
  return diffPct >= 0.1 ? 'Medium' : 'Low';
}

export type ScopedIssueKind = 'mismatch' | 'matched-issue';

export type ScopedIssue = {
  kind: ScopedIssueKind;
  layout: string;
  rack: string;
  bay: string;
  locCode: string;
  pallet: string;
  expectedSku: string;
  expectedName: string;
  expectedQty: number;
  foundSku: string;
  foundName: string;
  foundLot: string;
  foundQty: number;
  condition: Condition;
  issueRaised?: boolean;
  evidence?: Evidence;
};

// Reconciles each location's actually-saved pallet (loc.pallets.find by
// `saved`, never the unsaved mock-seeded pallets[0] — the same rule Rack
// View itself uses) against EXPECTED_SKUS, the exact "what should be here"
// list Rack View shows the inspector — splitting into the two in-scope
// Reconciliation outcomes: the wrong SKU altogether ('mismatch'), or the
// right SKU but a quantity/damage discrepancy ('matched-issue'). Manual
// Mode saves are excluded — those have no expected SKU to compare against
// at all and are a separate, out-of-scope concern (see FlaggedLine/
// summaryStats, filtered by source==='manual').
export function scopedIssues(tree: AuditLocationsTree | undefined): ScopedIssue[] {
  const out: ScopedIssue[] = [];
  allLocations(tree).forEach(({ layout, rack, bay, loc }) => {
    const saved = loc.pallets.find((p) => p.saved);
    const found = saved?.lines[0];
    if (!saved || !found || found.source === 'manual') return;
    const expected = EXPECTED_SKUS[loc.code]?.[0];
    if (!expected) return;
    const skuOk = found.sku === expected.sku;
    if (skuOk && found.qty === expected.qty && found.condition === 'Good') return; // clean match — not an issue
    out.push({
      kind: skuOk ? 'matched-issue' : 'mismatch',
      layout,
      rack,
      bay,
      locCode: loc.code,
      pallet: saved.pallet,
      expectedSku: expected.sku,
      expectedName: expected.name,
      expectedQty: expected.qty,
      foundSku: found.sku,
      foundName: found.name,
      foundLot: found.lot,
      foundQty: found.qty,
      condition: found.condition,
      issueRaised: found.issueRaised,
      evidence: found.evidence,
    });
  });
  return out;
}
