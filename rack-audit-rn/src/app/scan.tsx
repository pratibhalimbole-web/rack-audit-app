import { QuickScanScreen } from '@/features/quick-scan/QuickScanScreen';

// Ports renderQuickScan (rack-audit-app.html ~3926) — the global "Scan" tab.
// Presented as a modal (see root _layout.tsx Stack.Screen options), matching
// the source's openQuickScan() behavior of opening over whatever screen is
// currently active rather than being a real stack destination.
export default function ScanModalScreen() {
  return <QuickScanScreen />;
}
