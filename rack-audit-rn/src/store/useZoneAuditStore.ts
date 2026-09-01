import { create } from 'zustand';

// Mirrors just enough of ZoneAuditMapScreen's local scannedByZone (unique
// SKU + label pairs — that's all pick-list progress needs) into a shared,
// auditId-keyed store, so Audit Details' zone pick-list chips can show
// live scan progress without that screen needing to own or replay the
// full ZoneScanLine shape (evidence, condition, etc. stay screen-local).
// Same transient/no-persistence convention as useQuickScanPinStore.
export type ZoneScanRecord = { sku: string; label: string };

type ZoneAuditState = {
  // auditId -> zoneId -> scanned {sku,label} pairs
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
