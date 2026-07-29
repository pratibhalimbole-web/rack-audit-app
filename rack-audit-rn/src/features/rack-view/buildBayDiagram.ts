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
