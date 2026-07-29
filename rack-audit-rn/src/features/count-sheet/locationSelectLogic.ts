import { findBayIn, findLayoutIn, findRackIn } from '@/lib/locationsRepo';
import type { AuditLocationsTree } from '@/lib/types';

export type LocSelect = { layout: string | null; rack: string | null; bay: string | null; loc: string | null };

export type LocField = 'layout' | 'rack' | 'bay' | 'loc';

// Ports initLocSelect() (rack-audit-app.html ~2118-2135): auto-fills a level
// ONLY when it's fixed (exactly one option) — the moment a level has more
// than one, it and everything below stay unselected.
export function initLocSelect(tree: AuditLocationsTree): LocSelect {
  const layouts = tree.layouts;
  if (layouts.length !== 1) return { layout: null, rack: null, bay: null, loc: null };
  const layout = layouts[0].name;
  const racks = layouts[0].racks;
  if (racks.length !== 1) return { layout, rack: null, bay: null, loc: null };
  const rack = racks[0].code;
  const bays = racks[0].bays;
  if (bays.length !== 1) return { layout, rack, bay: null, loc: null };
  const bay = bays[0].code;
  const locs = bays[0].locations;
  const loc = locs.length === 1 ? locs[0].code : null;
  return { layout, rack, bay, loc };
}

// Ports chooseSheetOption's downstream re-resolution (~2684-2703): picking a
// field invalidates everything below it; each downstream level is
// auto-filled only when exactly one option remains, otherwise left null so
// the inspector still makes a real choice.
export function applyFieldChange(tree: AuditLocationsTree, sel: LocSelect, field: LocField, value: string): LocSelect {
  const next: LocSelect = { ...sel, [field]: value };
  if (field === 'layout') {
    const racks = (next.layout ? findLayoutIn(tree, next.layout)?.racks : []) ?? [];
    next.rack = racks.length === 1 ? racks[0].code : null;
  }
  if (field === 'layout' || field === 'rack') {
    const bays = (next.layout && next.rack ? findRackIn(tree, next.layout, next.rack)?.bays : []) ?? [];
    next.bay = bays.length === 1 ? bays[0].code : null;
  }
  if (field === 'layout' || field === 'rack' || field === 'bay') {
    const locs = (next.layout && next.rack && next.bay ? findBayIn(tree, next.layout, next.rack, next.bay)?.locations : []) ?? [];
    next.loc = locs.length === 1 ? locs[0].code : null;
  }
  return next;
}

// Ports getLocContext() (~2104-2112).
export function locContext(tree: AuditLocationsTree, sel: LocSelect) {
  const layouts = tree.layouts;
  const layoutObj = sel.layout ? findLayoutIn(tree, sel.layout) : undefined;
  const racks = layoutObj?.racks ?? [];
  const rackObj = sel.rack ? findRackIn(tree, sel.layout ?? '', sel.rack) : undefined;
  const bayObj = sel.bay && rackObj ? findBayIn(tree, sel.layout ?? '', sel.rack ?? '', sel.bay) : undefined;
  return { layouts, layoutObj, racks, rackObj, bayObj };
}
