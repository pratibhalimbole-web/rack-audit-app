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

// A location's physical Level (which row in the bay elevation) and Position
// (which slot within that row, 1-based) — reuses buildBayDiagram's own
// row/cell layout, so these numbers always agree with what's drawn on the
// canvas, whether or not the location carries explicit level/slot metadata.
export function locLevelPosition(bayObj: BayNode | undefined, locCode: string | null | undefined): { level: number | null; position: number | null } {
  if (!locCode) return { level: null, position: null };
  for (const row of buildBayDiagram(bayObj)) {
    const idx = row.cells.findIndex((c) => c?.code === locCode);
    if (idx !== -1) return { level: row.level, position: idx + 1 };
  }
  return { level: null, position: null };
}

// Which side of a level's 3 slots to start from.
export type ScanFrom = 'left' | 'right';
// 'first' = raster — every level restarts from `from` (Left-First-Up/Down).
// 'last' = snake — each new level continues from whichever slot the
// previous level ended on, instead of resetting (Left-Last-Up/Down).
export type ScanPattern = 'first' | 'last';
// Level progression within a bay: bottom(1)→top, or top→bottom(1).
export type ScanVertical = 'up' | 'down';
// 'bay' ("Bay's Level") — confined to whichever single bay the current
// selection is in: level by level within that one bay only (Bay 1 → L1,
// L2, L3…), never advancing into another bay on its own. 'rack' ("Bay
// wise") — level-major across the WHOLE rack instead: clear a level across
// every bay (Bay 1, Bay 2, Bay 3… all at L1) before moving to the next
// level, same as a real inspector/MHE working one elevation at a time
// instead of one bay at a time.
export type ScanScope = 'bay' | 'rack';

export type ScanSettings = { from: ScanFrom; pattern: ScanPattern; vertical: ScanVertical; scope: ScanScope };

// Walks one bay's levels in `vertical` order; within each level, slots run
// from `from` outward. Under the 'last' pattern the starting side flips
// after every level (a true boustrophedon/snake), so e.g. From Left +
// Left-Last-Up on a bay whose L1 ends at the rightmost slot continues
// L2 starting from that same rightmost slot, working back to the left —
// never resetting to the left edge mid-bay.
function buildOneBayOrder(from: ScanFrom, pattern: ScanPattern, vertical: ScanVertical, rows: DiagramRow[]): { order: LocationNode[]; endSide: ScanFrom } {
  const sorted = rows.slice().sort((a, b) => (vertical === 'up' ? a.level - b.level : b.level - a.level));
  const order: LocationNode[] = [];
  let side = from;
  sorted.forEach((row) => {
    const cells = side === 'left' ? row.cells : row.cells.slice().reverse();
    cells.forEach((cell) => {
      if (cell) order.push(cell);
    });
    if (pattern === 'last') side = side === 'left' ? 'right' : 'left';
  });
  return { order, endSide: side };
}

// `currentBayCode` only matters for scope 'bay' — it's the bay the order
// gets confined to (whichever bay the current selection is in). Ignored
// for scope 'rack', which always spans every bay.
export function buildScanOrder(
  settings: ScanSettings,
  bayDiagrams: { bay: { code: string }; rows: DiagramRow[] }[],
  currentBayCode?: string,
): LocationNode[] {
  if (settings.scope === 'bay') {
    const current = currentBayCode ? bayDiagrams.find((b) => b.bay.code === currentBayCode) : bayDiagrams[0];
    if (!current) return [];
    return buildOneBayOrder(settings.from, settings.pattern, settings.vertical, current.rows).order;
  }

  // 'rack' ("Bay wise") — level is the outer loop, bays are the inner
  // loop: every bay's row at this level gets pushed (in bay-array order,
  // or reversed under 'last'), then the level advances. Under 'last' both
  // the bay-sweep direction and the within-bay starting side flip after
  // each level, so the whole rack reads as one continuous snake instead of
  // resetting to the top-left corner every level.
  const maxLevel = bayDiagrams.reduce((max, { rows }) => Math.max(max, ...rows.map((r) => r.level)), 0);
  const levels: number[] = [];
  for (let l = 1; l <= maxLevel; l++) levels.push(l);
  const orderedLevels = settings.vertical === 'up' ? levels : levels.slice().reverse();

  const order: LocationNode[] = [];
  let side = settings.from;
  let bayForward = true;
  orderedLevels.forEach((level) => {
    const bays = bayForward ? bayDiagrams : bayDiagrams.slice().reverse();
    bays.forEach(({ rows }) => {
      const row = rows.find((r) => r.level === level);
      if (!row) return;
      const cells = side === 'left' ? row.cells : row.cells.slice().reverse();
      cells.forEach((cell) => {
        if (cell) order.push(cell);
      });
    });
    if (settings.pattern === 'last') {
      side = side === 'left' ? 'right' : 'left';
      bayForward = !bayForward;
    }
  });
  return order;
}
