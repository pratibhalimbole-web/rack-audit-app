import { create } from 'zustand';

// Passes a Pin Location result back from the pushed pin-location screen to
// whichever Quick Scan card opened it — Expo Router's router.push() has no
// return-value mechanism, so this transient store (no persistence, unlike
// useAuthStore which survives app restarts) fills that gap. Same plain
// create() convention as useAuthStore, just without the async hydrate step.
export type QuickScanPinTarget = {
  itemId: string;
  skuLabel: string;
  expectedZone: string | null;
  // How many already-scanned SKUs (from this Quick Scan session) landed in
  // each zone — drives the "scanned here" activity indicator on the map.
  scannedZoneCounts: Record<string, number>;
};

export type QuickScanPinResult = {
  itemId: string;
  zone: string;
  rack?: string;
  bay?: string;
  loc?: string;
};

type QuickScanPinState = {
  target: QuickScanPinTarget | null;
  result: QuickScanPinResult | null;
  openPin: (target: QuickScanPinTarget) => void;
  submitResult: (result: QuickScanPinResult) => void;
  clear: () => void;
};

export const useQuickScanPinStore = create<QuickScanPinState>((set) => ({
  target: null,
  result: null,
  openPin: (target) => set({ target, result: null }),
  submitResult: (result) => set({ result }),
  clear: () => set({ target: null, result: null }),
}));
