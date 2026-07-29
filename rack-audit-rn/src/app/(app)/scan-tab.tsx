import { PlaceholderScreen } from '@/components/PlaceholderScreen';

// Never actually shown — PhoneTabsLayout intercepts this tab's press and
// pushes the /scan modal route instead (source: openQuickScan() opens over
// the current screen, it isn't a persistent tab destination). This file
// only needs to exist so <Tabs.Screen name="scan-tab"> has a route to bind.
export default function ScanTabPlaceholder() {
  return <PlaceholderScreen title="Scan" />;
}
