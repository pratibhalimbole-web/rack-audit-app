import { Ionicons } from '@expo/vector-icons';
import type { ColorValue } from 'react-native';
import type { NavItem } from './navConfig';

const ICON_MAP: Record<NavItem['icon'], keyof typeof Ionicons.glyphMap> = {
  home: 'home-outline',
  calendar: 'calendar-outline',
  tasks: 'checkbox-outline',
  scan: 'scan-outline',
  progress: 'bar-chart-outline',
};

export function NavIcon({ icon, color, size = 20 }: { icon: NavItem['icon']; color: ColorValue; size?: number }) {
  return <Ionicons name={ICON_MAP[icon]} size={size} color={color as string} />;
}
