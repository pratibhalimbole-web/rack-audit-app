import type { Condition } from './types';

// Ports conditionSeverity() (rack-audit-app.html ~1106): Good is unflagged
// (green), Damaged/Broken is an outright defect (red), everything else needs
// a look but isn't necessarily bad (amber) — same split summaryStats() uses
// for Audit Summary's flagged-items list, so a collapsed SKU row's pill
// agrees with what that screen would call out for the same line.
export function conditionSeverity(condition: Condition): 'red' | 'amber' | 'green' {
  if (condition === 'Good') return 'green';
  if (condition === 'Damaged' || condition === 'Broken') return 'red';
  return 'amber';
}
