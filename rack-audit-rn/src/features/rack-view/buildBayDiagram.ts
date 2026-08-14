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
export function buildScanOrder(direction: ScanDirection, bayDiagrams: { rows: DiagramRow[] }[]): LocationNode[] {
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
