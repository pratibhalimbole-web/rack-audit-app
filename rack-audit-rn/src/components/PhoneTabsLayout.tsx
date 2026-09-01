import { router, Tabs } from 'expo-router';
import { NavIcon } from './NavIcon';
import { NAV_ITEMS } from './navConfig';
import { useCurrentOngoing } from '@/features/dashboard/hooks';
import { useDeviceClass } from '@/hooks/useDeviceClass';
import { useTheme } from '@/theme/ThemeProvider';

// Ports renderTabBar (rack-audit-app.html ~1693-1710): Home / Audit Schedule
// / Tasks / Scan / Progress, with Progress only shown while an audit is
// ongoing (source: `if (ongoing) items.push(...)`). Both "Scan" and
// "Progress" open as a screen over the current one rather than a persistent
// tab destination — Progress specifically always carries the ongoing
// audit's id (source: `railTo('progress', {auditId: ongoing.audit_id})`),
// so both are intercepted via `listeners.tabPress` rather than getting real
// tab screen content. Same bottom bar on tablet as phone — Progress just
// reads "Reported Audits" there (source line ~1704).
export default function PhoneTabsLayout() {
  const { tokens } = useTheme();
  const device = useDeviceClass();
  const ongoing = useCurrentOngoing();
  const hasOngoing = !!ongoing;
  const progressLabel = device === 'tablet' ? 'Reported Audits' : 'Progress';

  return (
    <Tabs
      // Every pushed screen (Audit Details, Rack View, Count Sheet, Warehouse
      // Map, ...) is registered here as a hidden Tabs.Screen (href: null),
      // not a real Stack push — see the comment further down. The default
      // backBehavior ('firstRoute') makes the hardware/header back button
      // always collapse to the first tab (Dashboard) no matter how many
      // screens deep the user actually navigated. 'history' makes back()
      // follow the real order screens were focused in instead.
      backBehavior="history"
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: tokens.primary,
        tabBarInactiveTintColor: tokens.slate400,
        tabBarStyle: { backgroundColor: tokens.card, borderTopColor: tokens.border },
        tabBarLabelStyle: { fontSize: tokens.text.xxs, fontWeight: tokens.fontWeight.semibold },
      }}
    >
      {NAV_ITEMS.filter((item) => item.key !== 'scan' && item.key !== 'progress').map((item) => (
        <Tabs.Screen
          key={item.key}
          name={item.key}
          options={{ title: item.label, tabBarIcon: ({ color }) => <NavIcon icon={item.icon} color={color} /> }}
        />
      ))}
      <Tabs.Screen
        name="scan-tab"
        options={{
          title: 'Scan',
          tabBarIcon: ({ color }) => <NavIcon icon="scan" color={color} />,
        }}
        listeners={{
          tabPress: (e) => {
            e.preventDefault();
            router.push('/scan');
          },
        }}
      />
      <Tabs.Screen
        name="progress"
        options={{
          title: progressLabel,
          tabBarIcon: ({ color }) => <NavIcon icon="progress" color={color} />,
          href: hasOngoing ? undefined : null,
        }}
        listeners={{
          tabPress: (e) => {
            if (!ongoing) return;
            e.preventDefault();
            router.push({ pathname: '/audit/[auditId]/progress', params: { auditId: ongoing.audit_id } } as never);
          },
        }}
      />
      {/* Every other route under (app)/ — Settings, and the whole audit/
          detail tree (Audit Details, Count Sheet, Rack View, Progress,
          Summary, Issue Details) — is a real pushable screen, not one of
          the 5 nav destinations. Without href:null, Tabs auto-adds an
          unlisted tab for any child route it doesn't otherwise recognize.
          Expo Router flattens nested dynamic routes into full path names
          (confirmed via the "No route named audit exists" dev warning —
          there's no single "audit" node to exclude), so each of the 6
          actual nested route names needs its own exclusion. */}
      <Tabs.Screen name="settings" options={{ href: null }} />
      {/* Audit Details already has its own back button (AppHeader) and is a
          drill-down destination, not one of the 5 nav tabs — the bottom bar
          offers no benefit here and just eats into the page. */}
      <Tabs.Screen name="audit/[auditId]/index" options={{ href: null, tabBarStyle: { display: 'none' } }} />
      <Tabs.Screen name="audit/[auditId]/count-sheet" options={{ href: null }} />
      <Tabs.Screen name="audit/[auditId]/progress" options={{ href: null }} />
      <Tabs.Screen name="audit/[auditId]/summary" options={{ href: null }} />
      {/* Rack View and the Warehouse Map already have their own back button
          (AppHeader), and their canvases are meant to fill the whole screen
          — the bottom tab bar would just eat into that space for no
          navigational benefit. */}
      <Tabs.Screen name="audit/[auditId]/rack/[rackId]" options={{ href: null, tabBarStyle: { display: 'none' } }} />
      <Tabs.Screen name="audit/[auditId]/zone-map" options={{ href: null, tabBarStyle: { display: 'none' } }} />
      <Tabs.Screen name="tasks/map" options={{ href: null, tabBarStyle: { display: 'none' } }} />
      <Tabs.Screen name="audit/[auditId]/issue/[lineId]" options={{ href: null }} />
      <Tabs.Screen name="audit/[auditId]/discrepancy/[key]" options={{ href: null }} />
    </Tabs>
  );
}
