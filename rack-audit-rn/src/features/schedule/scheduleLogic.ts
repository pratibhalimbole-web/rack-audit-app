import type { Audit } from '@/lib/types';

// Ports the pure calendar/lane-assignment logic from rack-audit-app.html
// (~3319-3442) — kept framework-agnostic (no JSX) so the month/week/day
// screens can all build off the same week-row data shape.

export function scheduleTypeKey(auditType: Audit['audit_type']): 'spot' | 'full' | 'cycle' {
  return { 'Spot Check': 'spot', Full: 'full', 'Cycle Count': 'cycle' }[auditType] as 'spot' | 'full' | 'cycle';
}

// Sunday-first Date#getDay() (0-6) remapped to Monday-first (0-6).
export function mondayIndex(jsDay: number): number {
  return (jsDay + 6) % 7;
}

const pad2 = (n: number) => String(n).padStart(2, '0');
export const CAL_TO_ISO = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

export const CAL_VISIBLE_LANES = 3;

export type ScheduleBar = { audit: Audit; colStart: number; colSpan: number; spanStartISO: string; lane: number };

// Greedy interval-scheduling lane assignment — each bar takes the first lane
// whose existing bars don't overlap its column range, same technique a Gantt
// chart uses to stack non-overlapping bars (source ~3366-3375).
export function assignScheduleLanes(bars: Omit<ScheduleBar, 'lane'>[]): ScheduleBar[] {
  const lanes: { colStart: number; colEnd: number }[][] = [];
  return bars.map((bar) => {
    const colEnd = bar.colStart + bar.colSpan - 1;
    let lane = lanes.findIndex((placed) => placed.every((p) => colEnd < p.colStart || bar.colStart > p.colEnd));
    if (lane === -1) {
      lane = lanes.length;
      lanes.push([]);
    }
    lanes[lane].push({ colStart: bar.colStart, colEnd });
    return { ...bar, lane };
  });
}

export type WeekRowData = {
  weekDates: Date[];
  visibleBars: ScheduleBar[];
  hiddenByCol: number[];
  laneRows: ScheduleBar[][];
};

// Ports buildScheduleWeekRow() (~3385-3442) minus the HTML — every audit
// whose [start_date, end_date] touches this Mon-Sun week, clipped to the
// columns it spans within the row, then lane-assigned.
export function buildWeekRowData(weekDates: Date[], auditPool: Audit[]): WeekRowData {
  const weekStartISO = CAL_TO_ISO(weekDates[0]);
  const weekEndISO = CAL_TO_ISO(weekDates[6]);

  const bars: Omit<ScheduleBar, 'lane'>[] = auditPool
    .filter((a) => a.start_date <= weekEndISO && a.end_date >= weekStartISO)
    .map((a) => {
      const spanStartISO = a.start_date > weekStartISO ? a.start_date : weekStartISO;
      const spanEndISO = a.end_date < weekEndISO ? a.end_date : weekEndISO;
      const colStart = mondayIndex(new Date(`${spanStartISO}T00:00:00`).getDay());
      const colSpan = Math.round((new Date(`${spanEndISO}T00:00:00`).getTime() - new Date(`${spanStartISO}T00:00:00`).getTime()) / 86400000) + 1;
      return { audit: a, colStart, colSpan, spanStartISO };
    })
    .sort((x, y) => x.colStart - y.colStart || y.colSpan - x.colSpan);

  const placed = assignScheduleLanes(bars);
  const visibleBars = placed.filter((b) => b.lane < CAL_VISIBLE_LANES);
  const hiddenByCol = [0, 0, 0, 0, 0, 0, 0];
  placed
    .filter((b) => b.lane >= CAL_VISIBLE_LANES)
    .forEach((b) => {
      for (let c = b.colStart; c < b.colStart + b.colSpan; c++) hiddenByCol[c]++;
    });

  const laneRows = Array.from({ length: CAL_VISIBLE_LANES }, (_, lane) => visibleBars.filter((b) => b.lane === lane)).filter((row) => row.length);

  return { weekDates, visibleBars, hiddenByCol, laneRows };
}

export function dayAuditGroups(dateISO: string, auditPool: Audit[]): { type: Audit['audit_type']; audits: Audit[] }[] {
  const dayAudits = auditPool.filter((a) => a.start_date <= dateISO && a.end_date >= dateISO);
  return (['Spot Check', 'Full', 'Cycle Count'] as const)
    .map((type) => ({ type, audits: dayAudits.filter((a) => a.audit_type === type) }))
    .filter((g) => g.audits.length);
}
