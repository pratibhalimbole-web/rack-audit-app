import { ProgressScreen } from '@/features/progress/ProgressScreen';
import { ReportedAuditsBoard } from '@/features/progress/ReportedAuditsBoard';
import { useDeviceClass } from '@/hooks/useDeviceClass';

// Ports renderProgress()'s STATE.device branch (rack-audit-app.html line
// 4173) — ReportedAuditsBoard is a structurally different tablet-only
// screen, not a restyle of the phone rack/bay breakdown.
export default function ProgressRoute() {
  const device = useDeviceClass();
  return device === 'tablet' ? <ReportedAuditsBoard /> : <ProgressScreen />;
}
