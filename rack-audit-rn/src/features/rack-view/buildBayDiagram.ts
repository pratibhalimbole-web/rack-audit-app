import { RACK_DIAGRAM_LEVELS, RACK_DIAGRAM_SLOTS_PER_LEVEL } from '@/lib/mockData';
import type { BayNode, LocationNode } from '@/lib/types';

export type DiagramRow = { level: number; cells: (LocationNode | null)[] };

// Ports buildBayDiagram() (rack-audit-app.html ~2834-2865): groups a bay's
// locations by level/slot metadata when present (a fillBayLevels-generated
// bay), or by straight index math otherwise, into level rows rendered
// bottom-up (level 1 at the bottom, matching a real rack's elevation).
export function buildBayDiagram(bayObj: BayNode | undefined): DiagramRow[] {
  const locs = bayObj?.locations ?? [];
  const perLevel = RACK_DIAGRAM_SLOTS_PER_LEVEL;
  const hasLevelMeta = locs.length > 0 && locs[0].level != null;

  const byLevel = new Map<number, (LocationNode | undefined)[]>();
  if (hasLevelMeta) {
    locs.forEach((loc) => {
      if (loc.level == null) return;
      if (!byLevel.has(loc.level)) byLevel.set(loc.level, []);
      byLevel.get(loc.level)![((loc.slot ?? 1) - 1)] = loc;
    });
  }

  const levels = hasLevelMeta
    ? Math.max(RACK_DIAGRAM_LEVELS, ...Array.from(byLevel.keys()))
    : Math.max(RACK_DIAGRAM_LEVELS, Math.ceil(locs.length / perLevel));

  const rows: DiagramRow[] = [];
  for (let level = levels; level >= 1; level--) {
    const startIdx = (level - 1) * perLevel;
    const cells: (LocationNode | null)[] = [];
    for (let slot = 0; slot < perLevel; slot++) {
      const loc = hasLevelMeta ? (byLevel.get(level) ?? [])[slot] : locs[startIdx + slot];
      cells.push(loc ?? null);
    }
    rows.push({ level, cells });
  }
  return rows;
}

export type ScanDirection = 'up' | 'down' | 'left' | 'right';

// 'rack' (the original/default behavior) treats the direction as a
// rack-wide MHE-vs-no-MHE pattern that alternates bay-to-bay — see
// buildRackwiseScanOrder. 'bay' instead treats it as a per-bay setting:
// every bay is walked the exact same way, independently, in natural
// left-to-right bay order, one bay fully cleared before the next — no
// rack-wide alternation at all.
export type ScanScope = 'rack' | 'bay';

// Mirrors how a real audit actually walks a rack, MHE or not — never a
// flat bay-after-bay list. 'left'/'right' is the horizontal case: an MHE-
// free inspector clears one full level across every bay before moving up,
// alternating sweep direction each level (bay1→bay4, then bay4→bay1) so
// they're never walking back past bays they just finished. 'up'/'down' is
// the vertical case: an MHE inspector clears one whole bay top-to-bottom
// (or bottom-to-top) without lowering the fork between bays, so the next
// bay starts at whatever level the fork is already sitting at — hence each
// bay alternates level direction too. `right`/`down` are the "start at the
// near end" defaults; `left`/`up` start from the far end instead.
function buildRackwiseScanOrder(direction: ScanDirection, bayDiagrams: { rows: DiagramRow[] }[]): LocationNode[] {
  const order: LocationNode[] = [];
  if (direction === 'left' || direction === 'right') {
    const maxLevel = bayDiagrams.reduce((max, { rows }) => Math.max(max, ...rows.map((r) => r.level)), 0);
    let forward = direction === 'right';
    for (let level = 1; level <= maxLevel; level++) {
      const bayOrder = forward ? bayDiagrams : bayDiagrams.slice().reverse();
      bayOrder.forEach(({ rows }) => {
        const row = rows.find((r) => r.level === level);
        row?.cells.forEach((cell) => {
          if (cell) order.push(cell);
        });
      });
      forward = !forward;
    }
  } else {
    let ascending = direction === 'up';
    bayDiagrams.forEach(({ rows }) => {
      const sortedAsc = rows.slice().sort((a, b) => a.level - b.level);
      const levelOrder = ascending ? sortedAsc : sortedAsc.slice().reverse();
      levelOrder.forEach((row) => {
        row.cells.forEach((cell) => {
          if (cell) order.push(cell);
        });
      });
      ascending = !ascending;
    });
  }
  return order;
}

// Bays in their natural left-to-right order (bayDiagrams' own array order,
// never reversed), each one fully walked in the exact same chosen
// direction before moving to the next — no bay-to-bay alternation, since
// the direction here describes how to work *inside* one bay, not a
// rack-wide MHE pattern. 'left'/'right' controls slot order within each of
// that bay's levels (levels still bottom(1)→top, always ascending);
// 'up'/'down' controls level order within the bay (slots stay natural
// left-to-right) — same per-axis meaning the rackwise mode uses, just
// never reversed or alternated bay-to-bay.
function buildWithinBayScanOrder(direction: ScanDirection, bayDiagrams: { rows: DiagramRow[] }[]): LocationNode[] {
  const order: LocationNode[] = [];
  bayDiagrams.forEach(({ rows }) => {
    const sortedAsc = rows.slice().sort((a, b) => a.level - b.level);
    if (direction === 'left' || direction === 'right') {
      sortedAsc.forEach((row) => {
        const cells = direction === 'right' ? row.cells : row.cells.slice().reverse();
        cells.forEach((cell) => {
          if (cell) order.push(cell);
        });
      });
    } else {
      const levelOrder = direction === 'up' ? sortedAsc : sortedAsc.slice().reverse();
      levelOrder.forEach((row) => {
        row.cells.forEach((cell) => {
          if (cell) order.push(cell);
        });
      });
    }
  });
  return order;
}

export function buildScanOrder(direction: ScanDirection, bayDiagrams: { rows: DiagramRow[] }[], scope: ScanScope = 'rack'): LocationNode[] {
  return scope === 'bay' ? buildWithinBayScanOrder(direction, bayDiagrams) : buildRackwiseScanOrder(direction, bayDiagrams);
}
