import { useLocalSearchParams } from 'expo-router';
import { ProgressScreen } from '@/features/progress/ProgressScreen';
import { ReportedAuditsBoard } from '@/features/progress/ReportedAuditsBoard';
import { useDeviceClass } from '@/hooks/useDeviceClass';

// Ports renderProgress()'s STATE.device branch (rack-audit-app.html line
// 4173) — ReportedAuditsBoard is a structurally different tablet-only
// screen, not a restyle of the phone rack/bay breakdown. Passes this
// route's own auditId through so "View Full Rack/Bay Breakdown" from Audit
// Details locks the board to that one task instead of the universal
// cross-audit view (which is still what the bottom-tab "Reported Audits"
// entry point reaches, with no auditId param).
export default function ProgressRoute() {
  const device = useDeviceClass();
  const { auditId } = useLocalSearchParams<{ auditId: string }>();
  return device === 'tablet' ? <ReportedAuditsBoard auditId={auditId} /> : <ProgressScreen />;
}
