import { missingLines, scopedIssues, summaryStats, type FlaggedLine, type ScopedIssue } from './auditLogic';
import { TODAY } from './mockData';
import type { AuditLocationsTree, Evidence } from './types';
import type { ZoneScanRecord } from '@/store/useZoneAuditStore';

// A single reconciliation finding, resolved down to one physical Inventory
// Unit ID wherever a scan actually identified one — shared by Reconciliation
// Findings (the board) and its own Issue Details screen, both of which need
// to build the exact same list to re-locate one finding by identity.
export type FindingType = 'Mismatched SKU' | 'Missing SKU' | 'Damage' | 'Manual Report';

export type Finding = {
  discId: string;
  auditId: string;
  auditName: string;
  findingType: FindingType;
  sku: string;
  skuName: string;
  unitId: string;
  layout: string;
  rack: string;
  bay: string;
  locCode: string;
  pallet: string;
  inspectedOn: string;
  evidence?: Evidence;
  note?: string;
};

export type WithAudit<T> = T & { auditId: string; auditName: string };

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

// Deterministic, not random — the same underlying finding always shows the
// same Discrepancy ID across renders/restarts, since there's no backend
// issuing real sequential IDs here.
export function discIdFor(seedKey: string): string {
  return `DISC-${String(1000 + (hashStr(seedKey) % 9000)).padStart(4, '0')}`;
}

export function fmtInspected(): string {
  // No real per-scan timestamp is tracked anywhere in this app yet — using
  // TODAY (not a fabricated clock time) rather than inventing one.
  return TODAY.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

// Same composite identity discIdFor's seed is built from — round-trips a
// specific Finding through a route param without needing to persist
// findings anywhere (they're always recomputed fresh from the tree).
export function findingRouteId(f: Finding): string {
  return [f.auditId, f.findingType, f.locCode, f.pallet, f.sku, f.unitId].map(encodeURIComponent).join('~');
}

export function buildFindings(
  candidates: { audit_id: string; audit_name: string }[],
  treeMap: Record<string, AuditLocationsTree | undefined>,
  zoneIssueLines: ZoneScanRecord[],
  zoneAuditId: string | undefined,
  zoneAuditName: string | undefined,
): Finding[] {
  const out: Finding[] = [];

  const scoped: WithAudit<ScopedIssue>[] = candidates.flatMap((a) =>
    scopedIssues(treeMap[a.audit_id]).map((s): WithAudit<ScopedIssue> => ({ ...s, auditId: a.audit_id, auditName: a.audit_name })),
  );
  scoped.forEach((s) => {
    const type: FindingType = s.kind === 'mismatch' ? 'Mismatched SKU' : s.condition !== 'Good' ? 'Damage' : 'Mismatched SKU';
    const units = s.unitIds?.length ? s.unitIds : [s.pallet];
    units.forEach((unitId) => {
      out.push({
        discId: discIdFor(`${s.auditId}|${s.locCode}|${s.pallet}|${s.foundSku}|${unitId}|${type}`),
        auditId: s.auditId,
        auditName: s.auditName,
        findingType: type,
        sku: s.foundSku,
        skuName: s.foundName,
        unitId,
        layout: s.layout,
        rack: s.rack,
        bay: s.bay,
        locCode: s.locCode,
        pallet: s.pallet,
        inspectedOn: fmtInspected(),
        evidence: s.evidence,
      });
    });
  });

  const manualLines: WithAudit<FlaggedLine>[] = candidates.flatMap((a) =>
    summaryStats(treeMap[a.audit_id])
      .flagged.filter((f) => f.source === 'manual')
      .map((f): WithAudit<FlaggedLine> => ({ ...f, auditId: a.audit_id, auditName: a.audit_name })),
  );
  manualLines.forEach((f) => {
    const units = f.unitIds?.length ? f.unitIds : [f.pallet];
    units.forEach((unitId) => {
      out.push({
        discId: discIdFor(`${f.auditId}|${f.locCode}|${f.pallet}|${f.sku}|${unitId}|manual`),
        auditId: f.auditId,
        auditName: f.auditName,
        findingType: 'Manual Report',
        sku: f.sku,
        skuName: f.name,
        unitId,
        layout: f.layout,
        rack: f.rack,
        bay: f.bay,
        locCode: f.locCode,
        pallet: f.pallet,
        inspectedOn: fmtInspected(),
        evidence: f.evidence,
      });
    });
  });

  const missingByAudit = candidates.flatMap((a) => missingLines(treeMap[a.audit_id]).map((m) => ({ ...m, auditId: a.audit_id, auditName: a.audit_name })));
  missingByAudit.forEach((m) => {
    m.missingUnitIds.forEach((unitId) => {
      out.push({
        discId: discIdFor(`${m.auditId}|${m.locCode}|${m.pallet}|${m.sku}|${unitId}|missing`),
        auditId: m.auditId,
        auditName: m.auditName,
        findingType: 'Missing SKU',
        sku: m.sku,
        skuName: m.name,
        unitId,
        layout: m.layout,
        rack: m.rack,
        bay: m.bay,
        locCode: m.locCode,
        pallet: m.pallet,
        inspectedOn: fmtInspected(),
      });
    });
  });

  zoneIssueLines.forEach((l) => {
    const auditId = zoneAuditId ?? '';
    const auditName = zoneAuditName ?? '';
    out.push({
      discId: discIdFor(`${auditId}|${l.sku}|${l.label}|zone`),
      auditId,
      auditName,
      findingType: 'Mismatched SKU',
      sku: l.sku,
      skuName: l.name,
      unitId: l.label,
      layout: l.scannedZone,
      rack: '—',
      bay: '—',
      locCode: l.scannedZone,
      pallet: '—',
      inspectedOn: fmtInspected(),
    });
  });

  return out;
}
