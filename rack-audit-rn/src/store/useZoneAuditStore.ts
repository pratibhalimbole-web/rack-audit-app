import { create } from 'zustand';
import type { Condition } from '@/lib/types';

// Mirrors ZoneAuditMapScreen's local scannedByZone (just the fields Audit
// Details' pick-list progress and Reported Audits' zone-issue cards need —
// evidence objects stay screen-local) into a shared, auditId-keyed store, so
// both screens can read live scan state without owning the scan session
// themselves. Same transient/no-persistence convention as useQuickScanPinStore.
export type ZoneScanRecord = {
  sku: string;
  name: string;
  label: string;
  qty: number | null;
  condition: Condition | null;
  qtyIssueRaised?: boolean;
  damageIssueRaised?: boolean;
  locationIssueRaised?: boolean;
  // The zone this SKU is actually expected in, per the WMS pick list — null
  // when it's not on ANY zone's expected list ("No Expectation on Record").
  expectedZone: string | null;
  // The zone it was actually scanned in (may differ from expectedZone).
  scannedZone: string;
};

type ZoneAuditState = {
  // auditId -> zoneId -> scanned lines
  scansByAudit: Record<string, Record<string, ZoneScanRecord[]>>;
  setZoneScans: (auditId: string, zoneId: string, scans: ZoneScanRecord[]) => void;
};

export const useZoneAuditStore = create<ZoneAuditState>((set) => ({
  scansByAudit: {},
  setZoneScans: (auditId, zoneId, scans) =>
    set((state) => ({
      scansByAudit: {
        ...state.scansByAudit,
        [auditId]: { ...(state.scansByAudit[auditId] ?? {}), [zoneId]: scans },
      },
    })),
}));
