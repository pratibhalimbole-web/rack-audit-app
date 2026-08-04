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
  scope_type: 'Layout' | 'Rack' | 'Bay';
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

export type QuickScanEntry =
  | { kind: 'location'; code: QrPayload }
  | { kind: 'pallet'; code: string }
  | { kind: 'sku'; code: { sku: string; name: string; lot: string } };
