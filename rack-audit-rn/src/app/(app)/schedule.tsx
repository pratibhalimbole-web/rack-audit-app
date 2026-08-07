import { ScheduleScreen } from '@/features/schedule/ScheduleScreen';
import { ScheduleTablet } from '@/features/schedule/ScheduleTablet';
import { useDeviceClass } from '@/hooks/useDeviceClass';

export default function ScheduleRoute() {
  const device = useDeviceClass();
  return device === 'tablet' ? <ScheduleTablet /> : <ScheduleScreen />;
}
