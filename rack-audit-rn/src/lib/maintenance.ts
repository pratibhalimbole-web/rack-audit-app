import type { Audit, AuditLocationsTree, Condition, Priority } from './types';
import { conditionSeverity } from './conditionSeverity';
import { scopedIssues, summaryStats, type FlaggedLine, type ScopedIssue, type UiStatus } from './auditLogic';
import { TODAY } from './mockData';

// Ports the "Pallet" admin web's Inventory Reconciliation module (Rules and
// Action + Action Board, screens shared as reference) down to a
// field-inspector's own assigned-task list: Rules and Action is where an
// admin defines, per discrepancy type, the list of actions a reconciler can
// pick from; Action Board is where a specific reported issue gets ONE of
// those actions assigned to it and tracked through a status column. This
// app has no admin surface, so Maintenance only needs the inspector-facing
// result: one card per already-reported issue, carrying whichever action +
// status it was assigned.
export type MaintenanceIssueType = 'Mismatched SKU' | 'Damaged SKU' | 'Quantity Issue' | 'Manually Reported';

// Mirrors Rules and Action's per-discrepancy-type action list — the pool a
// reconciler assigns FROM via Action Board, not a per-card free-text field.
export const ACTIONS_BY_DISCREPANCY: Record<MaintenanceIssueType, string[]> = {
  'Mismatched SKU': ['Investigate Mismatched SKU', 'Correct SKU Placement'],
  'Damaged SKU': ['Move to Quarantine', 'Return to Vendor', 'Send for Quality Inspection'],
  'Quantity Issue': ['Recount', 'Investigate Quantity Variance', 'Verify Suggested Quantity Transfer'],
  'Manually Reported': ['Investigate Manual Report', 'Escalate to Supervisor'],
};

// Same status vocabulary an Audit task card uses (In Progress/Completed),
// so Maintenance's own status badge reads with the exact same Pill
// component/colors instead of its own separate label set. No "To Do" and
// no "Overdue" here on purpose — a follow-up only ever exists once an
// issue's already been reported, so it's already being worked ("In
// Progress") the moment it's created, right up until it's "Completed".
const BOARD_STATUSES: UiStatus[] = ['In Progress', 'Completed'];

export type MaintenanceTask = {
  id: string;
  auditId: string;
  auditName: string;
  issueType: MaintenanceIssueType;
  sku: string;
  name: string;
  layout: string;
  rack: string;
  bay: string;
  locCode: string;
  pallet: string;
  action: string;
  boardStatus: UiStatus;
  assignedDate: string;
  dueDate: string;
  priority: Priority;
  condition: Condition;
};

// A findings/action/status assignment isn't stored anywhere yet (no admin
// surface to assign it from) — deterministically derived from the issue's
// own identity instead, so the same card always shows the same action/
// status/due-date across renders and app restarts, rather than reshuffling
// randomly.
function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

function pick<T>(list: readonly T[], seed: number): T {
  return list[seed % list.length];
}

function dueDateFrom(auditEndDate: string, seed: number): string {
  const d = new Date(auditEndDate + 'T00:00:00');
  d.setDate(d.getDate() + ((seed % 21) - 10)); // spread ±10 days around the audit's end date
  return d.toISOString().slice(0, 10);
}

function priorityFromSeverity(sev: 'red' | 'amber' | 'green'): Priority {
  return sev === 'red' ? 'High' : sev === 'amber' ? 'Medium' : 'Low';
}

function taskFromScoped(s: ScopedIssue, audit: Audit): MaintenanceTask {
  const issueType: MaintenanceIssueType = s.kind === 'mismatch' ? 'Mismatched SKU' : s.condition !== 'Good' ? 'Damaged SKU' : 'Quantity Issue';
  const id = [audit.audit_id, s.layout, s.rack, s.bay, s.locCode, s.pallet].join('~');
  const seed = hashStr(id);
  const sev = s.kind === 'mismatch' ? 'red' : conditionSeverity(s.condition) === 'green' ? 'amber' : conditionSeverity(s.condition);
  return {
    id,
    auditId: audit.audit_id,
    auditName: audit.audit_name,
    issueType,
    sku: s.foundSku,
    name: s.foundName,
    layout: s.layout,
    rack: s.rack,
    bay: s.bay,
    locCode: s.locCode,
    pallet: s.pallet,
    action: pick(ACTIONS_BY_DISCREPANCY[issueType], seed),
    boardStatus: pick(BOARD_STATUSES, seed),
    assignedDate: audit.start_date,
    dueDate: dueDateFrom(audit.end_date, seed),
    priority: priorityFromSeverity(sev),
    condition: s.condition,
  };
}

function taskFromManual(f: FlaggedLine, audit: Audit): MaintenanceTask {
  const id = [audit.audit_id, f.layout, f.rack, f.bay, f.locCode, f.pallet, f.sku].join('~');
  const seed = hashStr(id);
  return {
    id,
    auditId: audit.audit_id,
    auditName: audit.audit_name,
    issueType: 'Manually Reported',
    sku: f.sku,
    name: f.name,
    layout: f.layout,
    rack: f.rack,
    bay: f.bay,
    locCode: f.locCode,
    pallet: f.pallet,
    action: pick(ACTIONS_BY_DISCREPANCY['Manually Reported'], seed),
    boardStatus: pick(BOARD_STATUSES, seed),
    assignedDate: audit.start_date,
    dueDate: dueDateFrom(audit.end_date, seed),
    priority: priorityFromSeverity(conditionSeverity(f.condition)),
    condition: f.condition,
  };
}

// Same source data as Reported Audits' three case sections (scopedIssues +
// Manual Mode's flagged lines) — Maintenance is that same pool of findings,
// re-surfaced as assigned action-tasks instead of raw discrepancy cards.
export function buildMaintenanceTasks(audits: Audit[], treeMap: Record<string, AuditLocationsTree | undefined>): MaintenanceTask[] {
  const out: MaintenanceTask[] = [];
  audits.forEach((a) => {
    const tree = treeMap[a.audit_id];
    scopedIssues(tree).forEach((s) => out.push(taskFromScoped(s, a)));
    summaryStats(tree)
      .flagged.filter((f) => f.source === 'manual')
      .forEach((f) => out.push(taskFromManual(f, a)));
  });
  // dueDateFrom spreads around each source audit's own end_date, so which
  // bucket a task lands in is really just whatever that audit happens to
  // be scheduled — nothing guarantees the Tasks board's Today/This Week
  // columns ever actually have a Maintenance card in them. Pin the first
  // couple of tasks explicitly so both columns always have real content to
  // demo, same as the reference board.
  const addDays = (n: number) => {
    const d = new Date(TODAY);
    d.setDate(d.getDate() + n);
    return d.toISOString().slice(0, 10);
  };
  if (out[0]) out[0] = { ...out[0], dueDate: addDays(0) };
  if (out[1]) out[1] = { ...out[1], dueDate: addDays(3) };
  return out;
}

export function maintenanceLocationLabel(t: MaintenanceTask): string {
  return `${t.layout} · Rack ${t.rack}, Bay ${t.bay} · ${t.locCode}`;
}
