// Single source of truth for the 5 nav destinations — used by both the
// phone bottom Tabs and the tablet rail, per the user-confirmed decision
// that the rail simply mirrors the phone tabs rather than inventing a
// separate nav concept. Mirrors renderTabBar (rack-audit-app.html ~1693).
export type NavItem = {
  key: 'index' | 'schedule' | 'tasks' | 'scan' | 'progress' | 'maintenance';
  label: string;
  tabletLabel?: string; // Progress tab reads "Reported Audits" on tablet — source line ~1704
  icon: 'home' | 'calendar' | 'tasks' | 'scan' | 'progress' | 'maintenance';
};

export const NAV_ITEMS: NavItem[] = [
  { key: 'index', label: 'Home', icon: 'home' },
  { key: 'schedule', label: 'Audit Schedule', icon: 'calendar' },
  { key: 'tasks', label: 'Tasks', icon: 'tasks' },
  { key: 'scan', label: 'Scan', icon: 'scan' },
  { key: 'progress', label: 'Progress', tabletLabel: 'Reported Audits', icon: 'progress' },
  // Ports the "Pallet" admin web's Maintenance board (UI reference
  // screenshot) down to the inspector's own assigned-task list — see
  // src/lib/maintenance.ts.
  { key: 'maintenance', label: 'Maintenance', icon: 'maintenance' },
];
