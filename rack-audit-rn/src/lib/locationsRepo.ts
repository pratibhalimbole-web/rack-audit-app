import { fillAllBaysToFullLevels, LOCATIONS } from './mockData';
import { sb, supabaseConfigured } from './supabase';
import type { AuditLocationsTree, BayNode, CountLine, LayoutNode, LocationNode, Pallet, RackNode } from './types';

// Repo seam for the LOCATIONS tree — mirrors loadAllData's location-tree
// build (rack-audit-app.html ~1400-1418): group flat `locations` rows by
// layout/rack/bay, attach pallets/lines built from `count_records` grouped
// by pallet_id, then run the same fillAllBaysToFullLevels() pass the source
// runs after rebuilding from the DB.
export async function getLocationsTree(auditId: string): Promise<AuditLocationsTree> {
  if (!supabaseConfigured || !sb) {
    return LOCATIONS[auditId] ?? { layouts: [] };
  }

  const [{ data: locRows, error: e1 }, { data: countRows, error: e2 }] = await Promise.all([
    sb.from('locations').select('*').eq('audit_id', auditId),
    sb.from('count_records').select('*'),
  ]);
  if (e1) throw e1;
  if (e2) throw e2;

  const countsByLoc: Record<string, any[]> = {};
  (countRows ?? []).forEach((c) => {
    (countsByLoc[c.location_id] ??= []).push(c);
  });

  const tree: AuditLocationsTree = { layouts: [] };
  (locRows ?? []).forEach((loc) => {
    let layout: LayoutNode | undefined = tree.layouts.find((l) => l.name === loc.layout_name);
    if (!layout) {
      layout = { name: loc.layout_name, racks: [] };
      tree.layouts.push(layout);
    }
    let rack: RackNode | undefined = layout.racks.find((r) => r.code === loc.rack_code);
    if (!rack) {
      rack = { code: loc.rack_code, bays: [] };
      layout.racks.push(rack);
    }
    let bay: BayNode | undefined = rack.bays.find((b) => b.code === loc.bay_code);
    if (!bay) {
      bay = { code: loc.bay_code, locations: [] };
      rack.bays.push(bay);
    }

    const palletsByPalletId: Record<string, { pallet: string; lines: any[]; saved: boolean }> = {};
    (countsByLoc[loc.id] ?? []).forEach((c) => {
      const p = (palletsByPalletId[c.pallet_id] ??= { pallet: c.pallet_id, lines: [], saved: c.saved });
      p.lines.push({ id: c.id, sku: c.sku, name: c.sku_name, lot: c.lot, qty: c.qty, condition: c.condition });
    });

    const locationNode: LocationNode = {
      code: loc.location_code,
      status: loc.status,
      pallets: Object.values(palletsByPalletId),
      db_id: loc.id,
    };
    bay.locations.push(locationNode);
  });

  fillAllBaysToFullLevels({ [auditId]: tree });
  return tree;
}

export function findLayoutIn(tree: AuditLocationsTree, layoutName: string): LayoutNode | undefined {
  return tree.layouts.find((l) => l.name === layoutName);
}
export function findRackIn(tree: AuditLocationsTree, layoutName: string, rackCode: string): RackNode | undefined {
  return findLayoutIn(tree, layoutName)?.racks.find((r) => r.code === rackCode);
}
export function findBayIn(tree: AuditLocationsTree, layoutName: string, rackCode: string, bayCode: string): BayNode | undefined {
  return findRackIn(tree, layoutName, rackCode)?.bays.find((b) => b.code === bayCode);
}
export function findLocIn(tree: AuditLocationsTree, layoutName: string, rackCode: string, bayCode: string, locCode: string): LocationNode | undefined {
  return findBayIn(tree, layoutName, rackCode, bayCode)?.locations.find((l) => l.code === locCode);
}

type LocRef = { auditId: string; layout: string; rack: string; bay: string; loc: string };

// Ports saveRecord() (rack-audit-app.html ~3881-3906): pushes the in-progress
// lines as a new saved pallet record, flips Not-Started -> In-Progress. The
// mock path mutates the tree object in place (same object getLocationsTree
// returned, so it's the same reference TanStack Query has cached) — callers
// must invalidate the ['locations', auditId] query afterward to re-render.
export async function saveCountRecord(tree: AuditLocationsTree, ref: LocRef, lines: CountLine[]): Promise<void> {
  const locObj = findLocIn(tree, ref.layout, ref.rack, ref.bay, ref.loc);
  if (!locObj) return;
  const recordId = `${ref.loc}-${locObj.pallets.length + 1}`;
  const saved: Pallet = { pallet: recordId, lines: lines.map((l) => ({ ...l })), saved: true };
  locObj.pallets.push(saved);
  if (locObj.status === 'Not Started') locObj.status = 'In Progress';

  if (supabaseConfigured && sb && locObj.db_id) {
    const rows = saved.lines.map((l) => ({
      audit_id: ref.auditId,
      location_id: locObj.db_id,
      pallet_id: recordId,
      sku: l.sku,
      sku_name: l.name,
      lot: l.lot,
      qty: l.qty,
      condition: l.condition,
      saved: true,
    }));
    const { data, error } = await sb.from('count_records').insert(rows).select();
    if (error) throw error;
    (data ?? []).forEach((row, i) => {
      if (saved.lines[i]) saved.lines[i].id = row.id;
    });
    const { error: e2 } = await sb.from('locations').update({ status: locObj.status }).eq('id', locObj.db_id);
    if (e2) throw e2;
  }
}

// Ports completeLocation() (~3907-3923).
export async function markLocationCompleted(tree: AuditLocationsTree, ref: LocRef): Promise<void> {
  const locObj = findLocIn(tree, ref.layout, ref.rack, ref.bay, ref.loc);
  if (!locObj) return;
  locObj.status = 'Completed';
  if (supabaseConfigured && sb && locObj.db_id) {
    const { error } = await sb.from('locations').update({ status: 'Completed' }).eq('id', locObj.db_id);
    if (error) throw error;
  }
}

// Ports deleteRecord() (~3863-3880).
export async function deleteCountRecord(tree: AuditLocationsTree, ref: LocRef, pallet: string): Promise<void> {
  const locObj = findLocIn(tree, ref.layout, ref.rack, ref.bay, ref.loc);
  if (!locObj) return;
  locObj.pallets = locObj.pallets.filter((p) => p.pallet !== pallet);
  if (locObj.status === 'In Progress' && !locObj.pallets.some((p) => p.saved)) locObj.status = 'Not Started';
  if (supabaseConfigured && sb && locObj.db_id) {
    const { error } = await sb.from('count_records').delete().eq('location_id', locObj.db_id).eq('pallet_id', pallet);
    if (error) throw error;
    if (locObj.status === 'Not Started') {
      const { error: e2 } = await sb.from('locations').update({ status: 'Not Started' }).eq('id', locObj.db_id);
      if (e2) throw e2;
    }
  }
}

// Ports setSavedLineQty/setSavedLineCondition + syncSavedLine (~3834-3848).
export async function updateSavedLine(
  tree: AuditLocationsTree,
  ref: LocRef,
  pallet: string,
  lineIdx: number,
  patch: Partial<Pick<CountLine, 'qty' | 'condition'>>,
): Promise<void> {
  const locObj = findLocIn(tree, ref.layout, ref.rack, ref.bay, ref.loc);
  const p = locObj?.pallets.find((pp) => pp.pallet === pallet);
  const line = p?.lines[lineIdx];
  if (!line) return;
  Object.assign(line, patch);
  if (supabaseConfigured && sb && line.id) {
    const { error } = await sb.from('count_records').update(patch).eq('id', line.id);
    if (error) throw error;
  }
}
