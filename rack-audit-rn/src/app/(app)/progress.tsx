import { PlaceholderScreen } from '@/components/PlaceholderScreen';

// Never actually shown — PhoneTabsLayout intercepts this tab's press and
// pushes /audit/[auditId]/progress for the ongoing audit instead (source:
// railTo('progress', {auditId: ongoing.audit_id})). This file only needs to
// exist so <Tabs.Screen name="progress"> has a route to bind, matching
// scan-tab.tsx's role for the Scan tab.
export default function ProgressTabPlaceholder() {
  return <PlaceholderScreen title="Progress" />;
}
