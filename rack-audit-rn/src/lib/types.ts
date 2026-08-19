// Domain types mirroring rack-audit-app.html's data shapes:
// AUDITS (source ~line 1115), LOCATIONS tree (~1229), INVENTORY_POOL/
// CONDITIONS/QR_POOL/QUICK_SCAN_POOL (~1090-1444). Kept as the single
// source of truth for both the mock fixtures (lib/mockData.ts) and the
// Supabase-backed repo functions (lib/*Repo.ts), so screens never care
// which backend produced the data.

export type Condition = 'Good' | 'Damaged' | 'Broken' | 'Wet' | 'Open Package' | 'Other';

export const CONDITIONS: Condition[] = ['Good', 'Damaged', 'Broken', 'Wet', 'Open Package', 'Other'];

export type AuditType = 'Full' | 'Cycle Count' | 'Spot Check';
export type AuditStatus = 'Scheduled' | 'In Progress' | 'Submitted' | 'Reconciled' | 'Closed';
export type Priority = 'High' | 'Medium' | 'Low';

export type Audit = {
  audit_id: string;
  audit_name: string;
  audit_type: AuditType;
  count_method: string;
  // 'Zone' is coarser than 'Layout': a Layout-scoped audit still drills
  // down to individual bays (Audit Details' bay-chip grid, Rack View), but
  // a Zone-scoped audit only ever works at the whole-zone grain — Audit
  // Details shows zone chips instead of bay chips, and Resume Audit opens
  // the whole-warehouse zone map (every zone in the warehouse, this
  // audit's scope_values highlighted, the rest grayed out) rather than a
  // specific rack in Rack View.
  scope_type: 'Layout' | 'Rack' | 'Bay' | 'Zone';
  scope_values: string[];
  team_members: string[];
  start_date: string; // ISO date
  end_date: string; // ISO date
  status: AuditStatus;
  priority?: Priority;
  // Set from the "SKU Type" field on the admin app's Create Audit form when
  // this audit is only checking one specific SKU across its scope (e.g. only
  // iPhone boxes) rather than every pallet — drives which pallets Rack View
  // highlights as relevant to scan.
  target_sku?: string;
};

export type EvidenceStroke = { color: string; points: { x: number; y: number }[] };
export type EvidenceImage = { strokes?: EvidenceStroke[] };
export type EvidenceVideo = { durationSec: number };
export type EvidenceAudio = { durationSec: number; playing: boolean; bars: number[] };
export type Evidence = {
  note: string;
  noteOpen: boolean;
  audio: EvidenceAudio | null;
  images: EvidenceImage[];
  videos: EvidenceVideo[];
};

export type CountLine = {
  id?: string; // db_id when Supabase-backed
  sku: string;
  name: string;
  lot: string;
  qty: number;
  condition: Condition;
  evidence?: Evidence;
  // Persisted "Raise Issue" flag — set the moment an inspector raises an
  // issue in Rack View (Mismatch, quantity/damage discrepancy, or any
  // Manual Mode report), so it survives navigation/reload instead of living
  // only in that screen's session state. Reported Audits/Audit Summary can
  // surface these directly instead of only re-deriving issues from
  // condition/qty comparisons at read-time.
  issueRaised?: boolean;
  // How this line was captured — 'manual' for a Rack View Manual Mode
  // report (selectable outside the audit's assigned target_sku scope),
  // 'scan' (the default) for the normal scoped Reconciliation flow. Lets
  // downstream views distinguish an out-of-scope report from a normal
  // in-scope one, which is otherwise structurally identical.
  source?: 'scan' | 'manual';
  // Quantity and damage are independently-entered, independently-raisable
  // findings on a matched-SKU pallet (an inspector can find a quantity
  // problem, a damage problem, both, or neither) — each gets its own
  // evidence and its own raised flag rather than sharing the line's single
  // `evidence`/`issueRaised`, which stay reserved for the SKU-identity
  // level (Mismatch) and Manual Mode reports.
  qtyEvidence?: Evidence;
  damageEvidence?: Evidence;
  qtyIssueRaised?: boolean;
  damageIssueRaised?: boolean;
  // Damage's own cascading detail: which phase of the pallet's lifecycle the
  // damage relates to, and what was actually observed — the Observation
  // options offered depend on which Activity Phase is selected.
  activityPhase?: ActivityPhase;
  observation?: string;
  // Overall read on the physical pallet at this location, answered right
  // after Selected Location Details and independent of the SKU-level
  // Quantity/Damage findings below it.
  palletConditionGood?: boolean;
};

export type ActivityPhase = 'Installation' | 'Operation & Maintenance' | 'Design Discrepancy';

export const ACTIVITY_PHASES: ActivityPhase[] = ['Installation', 'Operation & Maintenance', 'Design Discrepancy'];

// Same 5 observations for every phase for now — swap in real per-phase lists
// once they're defined.
export const OBSERVATIONS_BY_PHASE: Record<ActivityPhase, string[]> = {
  Installation: ['Deformation', 'Visible Crack', 'Missing Baseplate', 'Deflection or Tilting up', 'Damaged or Sheared Anchor Bolt'],
  'Operation & Maintenance': ['Deformation', 'Visible Crack', 'Missing Baseplate', 'Deflection or Tilting up', 'Damaged or Sheared Anchor Bolt'],
  'Design Discrepancy': ['Deformation', 'Visible Crack', 'Missing Baseplate', 'Deflection or Tilting up', 'Damaged or Sheared Anchor Bolt'],
};

export type Pallet = {
  pallet: string;
  lines: CountLine[];
  saved?: boolean;
};

export type LocationStatus = 'Not Started' | 'In Progress' | 'Completed';

export type LocationNode = {
  code: string;
  status: LocationStatus;
  pallets: Pallet[];
  level?: number;
  slot?: number;
  db_id?: string;
};

export type BayNode = {
  code: string;
  locations: LocationNode[];
};

export type RackNode = {
  code: string;
  bays: BayNode[];
};

export type LayoutNode = {
  name: string;
  racks: RackNode[];
};

export type AuditLocationsTree = {
  layouts: LayoutNode[];
};

export type Inspector = {
  name: string;
  initials: string;
  warehouse: string;
  email: string;
  role: string;
};

export type InventoryItem = {
  sku: string;
  name: string;
  lot: string;
};

// What the warehouse's master slotting plan says SHOULD be at a location —
// independent of whatever an inspector actually finds there during a count.
// Most locations' master slot matches what's seeded as "found" (no
// discrepancy); a handful are deliberately overridden to differ, so the
// Mismatch SKUs view has real, inspectable discrepancies to show.
export type MasterSlot = {
  sku: string;
  name: string;
  lot: string;
  qty: number;
};

export type QrPayload = {
  layout: string;
  rack: string;
  bay: string;
  loc: string;
};

// Quick Scan's single scan point: an inspector scans a SKU wherever it's
// actually found — on the open floor (rack/bay/loc absent), or inside a rack
// (rack/bay/loc present, alongside the zone it's in — already unambiguous,
// so it's shown immediately). A floor find's `zone` is deliberately NOT
// trusted/shown up front: the inspector must pin it on the Pin Location
// screen (src/features/quick-scan/PinLocationScreen.tsx) before the app
// reveals a match/mismatch, so the check reflects what they actually
// verified rather than the QR's own claim. Zones reuse the same Layout
// names already used to group racks
// (Layout A/B/C…) rather than a separate warehouse hierarchy.
export type SkuScanCode = {
  sku: string;
  zone?: string;
  rack?: string;
  bay?: string;
  loc?: string;
};

// What the WMS says a SKU's zone SHOULD be — the SKU-keyed counterpart to
// MasterSlot (which is keyed by location instead). Quick Scan compares a
// scan's actual zone against this regardless of whether the SKU turned up
// on the floor or in a rack.
export type SkuZoneExpectation = {
  sku: string;
  name: string;
  expectedZone: string;
};

// A standalone open-floor storage area — genuinely no Layout, no Rack, no
// Bay underneath it, just a marked-off region on the warehouse floor where
// pallets sit directly (e.g. a staging lane or a returns dock). Distinct
// from a "zone" (a Layout, which does hold Racks/Bays) and from "floor
// find within a zone" (the open floor of an actual Layout) — this is a
// third kind of place a SKU can turn up that has no rack structure at all.
export type FloorArea = {
  id: string;
  label: string;
};
