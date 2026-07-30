// Ported from rack-audit-app.html's fixture data (~lines 1089-1250: TODAY,
// INSPECTOR, INVENTORY_POOL, AUDITS, RACK_DIAGRAM_* constants, makeLoc/
// makeBay/makeRack/makeLayout/genRacks/fillBayLevels/seedDemoPalletIfEmpty).
// Values below are copied verbatim where the source hard-codes them (audit
// records, inventory pool, inspector) so this mock layer stays a faithful
// stand-in for the real Supabase-backed data, not a re-imagined dataset.
//
// AUD-0231's location tree is fully generated via fillBayLevels (matching
// the source's "every bay gets padded to a real multi-level rack" behavior)
// since Rack View (build step 5) specifically needs that richness. The
// other five audits get a smaller but structurally accurate tree for now —
// expand them the same way if/when a screen needs deeper Rack View data for
// those audits too.

import type {
  Audit,
  AuditLocationsTree,
  BayNode,
  Condition,
  InventoryItem,
  Inspector,
  LayoutNode,
  LocationNode,
  LocationStatus,
  MasterSlot,
  Pallet,
  QrPayload,
  QuickScanEntry,
  RackNode,
} from './types';
import { CONDITIONS } from './types';

export const TODAY = new Date('2026-07-08T00:00:00');

export const INSPECTOR: Inspector = {
  name: 'Arjun Sharma',
  initials: 'AS',
  warehouse: 'Warehouse-01',
  email: 'arjun.sharma@rams.digital',
  role: 'Inspector',
};

export const INVENTORY_POOL: InventoryItem[] = [
  { sku: 'SKU-1042', name: 'Steel Bracket 90', lot: 'L-2291' },
  { sku: 'SKU-2218', name: 'Pallet Support Pin', lot: 'L-2292' },
  { sku: 'SKU-3301', name: 'Plastic Crate Blue', lot: 'L-2304' },
  { sku: 'SKU-9011', name: 'Rack Label Kit', lot: 'L-2311' },
  { sku: 'SKU-5088', name: 'Corner Protector', lot: 'L-2319' },
  { sku: 'SKU-1180', name: 'Fastener Pack M10', lot: 'L-2322' },
  { sku: 'SKU-4410', name: 'Hex Bolt Set 8mm', lot: 'L-2340' },
  { sku: 'SKU-4411', name: 'Washer Pack Steel', lot: 'L-2341' },
  { sku: 'SKU-4412', name: 'Rubber Gasket Set', lot: 'L-2342' },
];

export const AUDITS: Audit[] = [
  {
    audit_id: 'AUD-0231', audit_name: 'Zone A Full Count', audit_type: 'Full', count_method: 'Blind (Enforced)',
    scope_type: 'Rack', scope_values: ['Rack A-05', 'Rack A-06'],
    team_members: ['Arjun Sharma', 'Meera Kulkarni', 'Priya Singh'],
    start_date: '2026-06-20', end_date: '2026-07-10', status: 'In Progress',
  },
  {
    audit_id: 'AUD-0233', audit_name: 'Spot Check — Layout C & E', audit_type: 'Spot Check', count_method: 'Blind (Enforced)',
    scope_type: 'Layout', scope_values: ['Layout C', 'Layout E'], team_members: ['Arjun Sharma'],
    start_date: '2026-07-09', end_date: '2026-07-09', status: 'Scheduled',
  },
  {
    audit_id: 'AUD-0234', audit_name: 'Cycle — Fast Movers, Layout B', audit_type: 'Cycle Count', count_method: 'Blind (Enforced)',
    scope_type: 'Layout', scope_values: ['Layout B'], team_members: ['Arjun Sharma', 'Rohan Kumar'],
    start_date: '2026-07-11', end_date: '2026-07-15', status: 'Scheduled',
  },
  {
    audit_id: 'AUD-0225', audit_name: 'Zone C Damaged Recheck', audit_type: 'Cycle Count', count_method: 'Blind (Enforced)',
    scope_type: 'Rack', scope_values: ['Rack C-04'], team_members: ['Arjun Sharma', 'Sanjay Patil'],
    start_date: '2026-06-24', end_date: '2026-06-30', status: 'Submitted',
  },
  {
    audit_id: 'AUD-0219', audit_name: 'Bay Recount — 01', audit_type: 'Spot Check', count_method: 'Blind (Enforced)',
    scope_type: 'Bay', scope_values: ['Bay 03'], team_members: ['Arjun Sharma'],
    start_date: '2026-06-28', end_date: '2026-07-05', status: 'In Progress',
  },
  {
    audit_id: 'AUD-0240', audit_name: 'Full Count — Layouts A & B', audit_type: 'Full', count_method: 'Blind (Enforced)',
    scope_type: 'Layout', scope_values: ['Layout A', 'Layout B'], team_members: ['Arjun Sharma', 'Meera Kulkarni'],
    start_date: '2026-07-08', end_date: '2026-07-22', status: 'Scheduled',
  },
];

// Physical rack shape for the Rack View diagram — independent of how many
// Pallet LPNs a given audit's scope actually has (source lines 1142-1149).
export const RACK_DIAGRAM_LEVELS = 13;
export const RACK_DIAGRAM_SLOTS_PER_LEVEL = 3;
export const RACK_DIAGRAM_FULL_COUNT = Array.from({ length: RACK_DIAGRAM_LEVELS }, (_, i) => i + 1).reduce(
  (sum, level) => sum + (level % 2 === 0 ? 2 : 3),
  0,
);

export function makeLoc(code: string, status: LocationStatus, level?: number, slot?: number): LocationNode {
  return { code, status, pallets: [], level, slot };
}
export function makeBay(code: string, locations: LocationNode[]): BayNode {
  return { code, locations };
}
export function makeRack(code: string, bays: BayNode[]): RackNode {
  return { code, bays };
}
export function makeLayout(name: string, racks: RackNode[]): LayoutNode {
  return { name, racks };
}

// Every pallet in a Rack View-diagrammed bay should already carry a SKU —
// never overwrites a location that already has real pallets (source
// seedDemoPalletIfEmpty, lines 1167-1180). Left unsaved so it still reads as
// an in-progress pallet to resume.
//
// codePrefix (the bay's own code, e.g. "A-05-B01") is folded into the
// generated pallet LPN — level+slot alone repeats every bay (fillBayLevels
// resets to level 1 at the start of each one), which produced the same
// "P-0101" pallet ID in every bay across the whole rack. A pallet ID must be
// unique across the whole audit, so the bay has to be part of it.
function seedDemoPalletIfEmpty(loc: LocationNode, seedIdx: number, codePrefix: string): LocationNode {
  if (loc.pallets.length) return loc;
  const item = INVENTORY_POOL[seedIdx % INVENTORY_POOL.length];
  const condition: Condition = CONDITIONS[seedIdx % CONDITIONS.length];
  const pallet: Pallet = {
    pallet: loc.level != null
      ? `P-${codePrefix.replace(/[^A-Za-z0-9]/g, '')}-${String(loc.level).padStart(2, '0')}${String(loc.slot).padStart(2, '0')}`
      : `P-${loc.code.replace(/[^A-Za-z0-9]/g, '')}`,
    lines: [{ sku: item.sku, name: item.name, lot: item.lot, qty: 10 + (seedIdx % 30), condition }],
  };
  loc.pallets.push(pallet);
  return loc;
}

// Alternates 3/2 pallets per level (odd/even) — source lines 1193-1207.
export function fillBayLevels(codePrefix: string, existingLocs: LocationNode[]): LocationNode[] {
  const startLevel = Math.floor(existingLocs.length / RACK_DIAGRAM_SLOTS_PER_LEVEL) + 1;
  existingLocs.forEach((l, i) => {
    l.level = 1;
    l.slot = i + 1;
    seedDemoPalletIfEmpty(l, i, codePrefix);
  });
  const rest: LocationNode[] = [];
  let seedIdx = existingLocs.length;
  for (let level = startLevel; level <= RACK_DIAGRAM_LEVELS; level++) {
    const palletsThisLevel = level % 2 === 0 ? 2 : 3;
    for (let slot = 1; slot <= palletsThisLevel; slot++) {
      const loc = makeLoc(`${codePrefix}-${String(level).padStart(2, '0')}${String(slot).padStart(2, '0')}`, 'Not Started', level, slot);
      seedDemoPalletIfEmpty(loc, seedIdx++, codePrefix);
      rest.push(loc);
    }
  }
  return [...existingLocs, ...rest];
}

// Layout-scoped audits show every rack in the layout — source lines 1212-1224.
export function genRacks(
  rackCodes: string[],
  baysPerRack: number,
  locsPerBay: number,
  fullyDoneRacks: number,
  partialRackBayDone: number,
): RackNode[] {
  return rackCodes.map((rc, ri) =>
    makeRack(
      rc,
      Array.from({ length: baysPerRack }, (_, bi) => {
        const bayCode = 'B-0' + (bi + 1);
        const doneAll = ri < fullyDoneRacks;
        const partial = ri === fullyDoneRacks && bi < partialRackBayDone;
        const locs = Array.from({ length: locsPerBay }, (_, li) => {
          const locCode = `${rc}-${bayCode}-0${li + 1}`;
          const status: LocationStatus = doneAll ? 'Completed' : partial ? (li === 0 ? 'Completed' : 'Not Started') : 'Not Started';
          return makeLoc(locCode, status);
        });
        return makeBay(bayCode, locs);
      }),
    ),
  );
}

export const LOCATIONS: Record<string, AuditLocationsTree> = {
  'AUD-0231': {
    layouts: [
      makeLayout('Layout A', [
        makeRack('A-05', [
          makeBay('B-01', fillBayLevels('A-05-B01', [makeLoc('A-05-B01-01', 'Completed'), makeLoc('A-05-B01-02', 'Completed'), makeLoc('A-05-B01-03', 'Completed')])),
          makeBay('B-02', fillBayLevels('A-05-B02', [makeLoc('A-05-B02-01', 'Completed'), makeLoc('A-05-B02-02', 'Completed'), makeLoc('A-05-B02-03', 'In Progress')])),
          makeBay('B-03', fillBayLevels('A-05-B03', [makeLoc('A-05-B03-01', 'Not Started'), makeLoc('A-05-B03-02', 'Not Started'), makeLoc('A-05-B03-03', 'Not Started')])),
          makeBay('B-04', fillBayLevels('A-05-B04', [makeLoc('A-05-B04-01', 'Not Started'), makeLoc('A-05-B04-02', 'Not Started'), makeLoc('A-05-B04-03', 'Not Started')])),
        ]),
        makeRack('A-06', [
          makeBay('B-01', fillBayLevels('A-06-B01', [makeLoc('A-06-B01-01', 'Completed'), makeLoc('A-06-B01-02', 'Completed'), makeLoc('A-06-B01-03', 'Completed')])),
          makeBay('B-02', fillBayLevels('A-06-B02', [makeLoc('A-06-B02-01', 'Completed'), makeLoc('A-06-B02-02', 'Completed'), makeLoc('A-06-B02-03', 'Not Started')])),
          makeBay('B-03', fillBayLevels('A-06-B03', [makeLoc('A-06-B03-01', 'Not Started'), makeLoc('A-06-B03-02', 'Not Started'), makeLoc('A-06-B03-03', 'Not Started')])),
          makeBay('B-04', fillBayLevels('A-06-B04', [makeLoc('A-06-B04-01', 'Not Started'), makeLoc('A-06-B04-02', 'Not Started'), makeLoc('A-06-B04-03', 'Not Started')])),
        ]),
      ]),
    ],
  },
  'AUD-0233': {
    layouts: [
      makeLayout('Layout C', [
        makeRack('B-07', [
          makeBay('B-07-01', [makeLoc('B-07-01-01', 'Not Started'), makeLoc('B-07-01-02', 'Not Started')]),
          makeBay('B-07-02', [makeLoc('B-07-02-01', 'Not Started'), makeLoc('B-07-02-02', 'Not Started')]),
        ]),
      ]),
      makeLayout('Layout E', [
        makeRack('E-01', [
          makeBay('E-01-01', [makeLoc('E-01-01-01', 'Not Started'), makeLoc('E-01-01-02', 'Not Started')]),
          makeBay('E-01-02', [makeLoc('E-01-02-01', 'Not Started'), makeLoc('E-01-02-02', 'Not Started')]),
        ]),
      ]),
    ],
  },
  'AUD-0234': { layouts: [makeLayout('Layout B', genRacks(['B-01', 'B-02', 'B-03', 'B-04'], 3, 3, 1, 1))] },
  'AUD-0225': {
    layouts: [
      makeLayout('Layout A', [
        makeRack('C-04', [
          makeBay('C-04-01', [makeLoc('C-04-01-01', 'Completed'), makeLoc('C-04-01-02', 'Completed'), makeLoc('C-04-01-03', 'Completed')]),
        ]),
      ]),
    ],
  },
  'AUD-0219': {
    layouts: [
      makeLayout('Layout A', [
        makeRack('01', [
          makeBay(
            '03',
            Array.from({ length: RACK_DIAGRAM_LEVELS }, (_, li) =>
              Array.from({ length: RACK_DIAGRAM_SLOTS_PER_LEVEL }, (_, pi) => {
                const level = li + 1;
                const pallet = pi + 1;
                const n = li * RACK_DIAGRAM_SLOTS_PER_LEVEL + pi + 1;
                const status: LocationStatus = n === 1 ? 'In Progress' : n % 7 === 0 ? 'Completed' : 'Not Started';
                return makeLoc(`${String(level).padStart(2, '0')}-${String(pallet).padStart(2, '0')}`, status);
              }),
            ).flat(),
          ),
        ]),
      ]),
    ],
  },
  'AUD-0240': {
    layouts: [
      makeLayout('Layout A', genRacks(['A-20', 'A-21', 'A-22'], 3, 3, 1, 1)),
      makeLayout('Layout B', genRacks(['B-20', 'B-21'], 2, 2, 0, 1)),
    ],
  },
};

// AUD-0231's curated pallet + AUD-0225's real counted history (source lines
// 1233-1250) — reassigned/pushed after the generated trees above so these
// specific, intentionally-authored records aren't overwritten by the demo
// seeding inside fillBayLevels.
LOCATIONS['AUD-0231'].layouts[0].racks[0].bays[1].locations[2].pallets = [
  { pallet: 'P-10481', lines: [{ sku: 'SKU-1042', name: 'Steel Bracket 90', lot: 'L-2291', qty: 46, condition: 'Good' }], saved: true },
];
LOCATIONS['AUD-0225'].layouts[0].racks[0].bays[0].locations[0].pallets.push({
  pallet: 'P-20011',
  lines: [
    { sku: 'SKU-3301', name: 'Plastic Crate Blue', lot: 'L-2304', qty: 18, condition: 'Good' },
    { sku: 'SKU-5088', name: 'Corner Protector', lot: 'L-2319', qty: 6, condition: 'Damaged' },
  ],
  saved: true,
});
LOCATIONS['AUD-0225'].layouts[0].racks[0].bays[0].locations[1].pallets.push({
  pallet: 'P-20012',
  lines: [
    { sku: 'SKU-9011', name: 'Rack Label Kit', lot: 'L-2311', qty: 12, condition: 'Good' },
    { sku: 'SKU-1180', name: 'Fastener Pack M10', lot: 'L-2322', qty: 3, condition: 'Broken' },
  ],
  saved: true,
});
// Reconciliation form supports scanning multiple SKUs under one pallet LPN —
// P-1202 exercises that: three distinct SKUs, each independently flagged,
// counted on the same pallet. Reported Audits groups flagged lines by pallet
// so this shows as one card listing all three, not three separate cards.
LOCATIONS['AUD-0225'].layouts[0].racks[0].bays[0].locations[2].pallets.push({
  pallet: 'P-1202',
  lines: [
    { sku: 'SKU-4410', name: 'Hex Bolt Set 8mm', lot: 'L-2340', qty: 4, condition: 'Damaged' },
    { sku: 'SKU-4411', name: 'Washer Pack Steel', lot: 'L-2341', qty: 2, condition: 'Broken' },
    { sku: 'SKU-4412', name: 'Rubber Gasket Set', lot: 'L-2342', qty: 6, condition: 'Wet' },
  ],
  saved: true,
});

export const QR_POOL: QrPayload[] = [
  { layout: 'Layout A', rack: 'A-05', bay: 'B-02', loc: 'A-05-B02-03' },
  { layout: 'Layout A', rack: 'A-06', bay: 'B-02', loc: 'A-06-B02-03' },
  { layout: 'Layout A', rack: 'A-05', bay: 'B-03', loc: 'A-05-B03-01' },
  { layout: 'Layout B', rack: 'B-20', bay: 'B-02', loc: 'B-20-B-02-01' },
  { layout: 'Layout D', rack: 'D-01', bay: 'B-01', loc: 'D-01-B01-01' },
  { layout: 'Layout A', rack: 'A-09', bay: 'B-01', loc: 'A-09-B01-01' },
];

export const QUICK_SCAN_POOL: QuickScanEntry[] = [
  { kind: 'location', code: QR_POOL[0] },
  { kind: 'location', code: QR_POOL[1] },
  { kind: 'pallet', code: 'P-10483' },
  { kind: 'location', code: QR_POOL[3] },
  { kind: 'sku', code: { sku: 'SKU-2218', name: 'Pallet Support Pin', lot: 'L-2292' } },
  { kind: 'location', code: QR_POOL[2] },
];

// Pads every bay in a locations map up to a full multi-level rack (source
// fillAllBaysToFullLevels, line 1315) — takes a map parameter rather than
// closing over the global LOCATIONS so locationsRepo.ts can run the same
// pass over a single freshly-built Supabase tree (`{ [auditId]: tree }`).
export function fillAllBaysToFullLevels(locationsMap: Record<string, AuditLocationsTree>): void {
  Object.values(locationsMap).forEach((tree) =>
    tree.layouts.forEach((layout) =>
      layout.racks.forEach((rack) =>
        rack.bays.forEach((bay) => {
          if (bay.locations.length < RACK_DIAGRAM_FULL_COUNT) {
            bay.locations = fillBayLevels(`${rack.code}-${bay.code}`, bay.locations);
          }
        }),
      ),
    ),
  );
}

// Same sine-wave bar shape recordEvidenceAudio uses for a freshly-recorded
// clip — shared so a seeded demo note and a live in-app recording look the
// same, not two different fake waveforms (source line 1325).
export function generateWaveformBars(): number[] {
  return Array.from({ length: 40 }, (_, i) => 6 + Math.round(10 * Math.abs(Math.sin(i * 0.7))));
}

export const DEFECT_NOTES = [
  'Lack of safety locking pin.',
  'Visible surface corrosion near the weld joint.',
  'Component shows early signs of bending under load.',
  'Packaging torn, contents partially exposed.',
  'Missing labels on second unit in the pallet.',
  'Anchor bolt sheared, needs replacement.',
];

// Annotation colors offered on the "New Attachment" image marker modal —
// first one selected by default, matching the source's pre-checked blue.
export const ANNOTATION_COLORS = ['#1b59f8', '#8b5cf6', '#22d3ee', '#16a34a', '#db2777', '#be123c', '#f97316'];

function allLocationNodesInMap(locationsMap: Record<string, AuditLocationsTree>): LocationNode[] {
  const out: LocationNode[] = [];
  Object.values(locationsMap).forEach((tree) =>
    tree.layouts.forEach((ly) => ly.racks.forEach((r) => r.bays.forEach((b) => b.locations.forEach((l) => out.push(l))))),
  );
  return out;
}

// A reported issue (any flagged, non-"Good" line) reads as hollow without
// evidence backing it up — an inspector who flagged something in real usage
// would have photographed/noted it. Seeds a plausible note + audio + photo +
// video bundle onto every flagged line that doesn't already have real
// evidence, so Reported Audit Details always has something to show rather
// than empty "No X attached" states everywhere (source line 1345).
export function seedEvidenceForFlaggedLines(locationsMap: Record<string, AuditLocationsTree>): void {
  let seedIdx = 0;
  allLocationNodesInMap(locationsMap).forEach((loc) => {
    (loc.pallets || []).forEach((p) => {
      (p.lines || []).forEach((line) => {
        if (line.condition === 'Good' || line.evidence) return;
        line.evidence = {
          note: DEFECT_NOTES[seedIdx % DEFECT_NOTES.length],
          noteOpen: true,
          audio: { durationSec: 20, playing: false, bars: generateWaveformBars() },
          images: Array.from({ length: 1 + (seedIdx % 3) }, () => ({})),
          videos: Array.from({ length: 1 + (seedIdx % 2) }, () => ({ durationSec: 20 })),
        };
        seedIdx++;
      });
    });
  });
}

fillAllBaysToFullLevels(LOCATIONS);
seedEvidenceForFlaggedLines(LOCATIONS);

// The warehouse's master slotting plan — what SKU/quantity is SUPPOSED to be
// at a location, independent of whatever an inspector actually finds there.
// Keyed by location code, since a location's slot assignment doesn't vary
// by audit. Most locations' master slot is set to match what's already
// seeded as "found" (so no discrepancy), matching the fact that most real
// counts match the plan; a deterministic minority (every 17th location) is
// deliberately offset — either a quantity variance or an outright SKU swap
// — so the Mismatch SKUs view has real, inspectable discrepancies rather
// than a coincidental 1:1 match everywhere.
export const MASTER_INVENTORY: Record<string, MasterSlot> = {};

function buildMasterInventory(locationsMap: Record<string, AuditLocationsTree>): void {
  let mismatchIdx = 0;
  allLocationNodesInMap(locationsMap).forEach((loc, idx) => {
    const found = loc.pallets[0]?.lines[0];
    if (!found) return;
    let master: MasterSlot = { sku: found.sku, name: found.name, lot: found.lot, qty: found.qty };
    if (idx % 17 === 3) {
      if (mismatchIdx % 2 === 0) {
        master = { ...master, qty: master.qty + 3 + (mismatchIdx % 5) };
      } else {
        const swap = INVENTORY_POOL[(mismatchIdx + 2) % INVENTORY_POOL.length];
        if (swap.sku !== master.sku) master = { sku: swap.sku, name: swap.name, lot: swap.lot, qty: master.qty };
      }
      mismatchIdx++;
    }
    MASTER_INVENTORY[loc.code] = master;
  });
}
buildMasterInventory(LOCATIONS);

export type ExpectedSkuLine = { sku: string; name: string; lot: string; qty: number };

// What a pallet at this location is SUPPOSED to hold, per the pick list —
// the reconciliation form shows this before scanning so an inspector can
// scan against a known checklist rather than guessing, since a real pallet
// can carry several SKUs (the reconciliation form supports scanning more
// than one). Most locations' expected list is a single line matching
// MASTER_INVENTORY (the common, no-surprise case); a deterministic subset
// get 2-4 lines, one of which is deliberately off (wrong qty) so the
// checklist has real "expected vs. found" variance to demonstrate, same
// spirit as buildMasterInventory's every-17th mismatch.
export const EXPECTED_SKUS: Record<string, ExpectedSkuLine[]> = {};

function buildExpectedSkus(locationsMap: Record<string, AuditLocationsTree>): void {
  allLocationNodesInMap(locationsMap).forEach((loc, idx) => {
    const master = MASTER_INVENTORY[loc.code];
    if (!master) return;
    const lineCount = idx % 5 === 0 ? 4 : idx % 3 === 0 ? 2 : 1;
    const lines: ExpectedSkuLine[] = [{ sku: master.sku, name: master.name, lot: master.lot, qty: master.qty }];
    for (let i = 1; i < lineCount; i++) {
      const extra = INVENTORY_POOL[(idx + i) % INVENTORY_POOL.length];
      if (lines.some((l) => l.sku === extra.sku)) continue;
      lines.push({ sku: extra.sku, name: extra.name, lot: extra.lot, qty: 4 + ((idx + i * 3) % 16) });
    }
    if (lines.length > 1 && idx % 6 === 0) {
      lines[1] = { ...lines[1], qty: lines[1].qty + 2 };
    }
    EXPECTED_SKUS[loc.code] = lines;
  });
}
buildExpectedSkus(LOCATIONS);
