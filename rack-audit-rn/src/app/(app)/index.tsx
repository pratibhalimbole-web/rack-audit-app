import { DashboardPhone } from '@/features/dashboard/DashboardPhone';
import { DashboardTablet } from '@/features/dashboard/DashboardTablet';
import { useDeviceClass } from '@/hooks/useDeviceClass';

// Ports renderDashboard()'s STATE.device branch (rack-audit-app.html
// line 1776) — DashboardTablet is a structurally different screen, not a
// restyle, so it's a separate component rather than internal conditionals.
export default function DashboardScreen() {
  const device = useDeviceClass();
  return device === 'tablet' ? <DashboardTablet /> : <DashboardPhone />;
}
