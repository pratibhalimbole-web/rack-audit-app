import { useWindowDimensions } from 'react-native';

export type DeviceClass = 'phone' | 'tablet';

// Replaces the source app's STATE.device flag. Threshold matches common
// RN/tablet convention (~768 logical px) rather than the source's toolbar
// toggle (which just swapped a fixed device-frame width in the web
// prototype) — on a real device this is driven by actual screen width.
const TABLET_MIN_WIDTH = 768;

export function useDeviceClass(): DeviceClass {
  const { width } = useWindowDimensions();
  return width >= TABLET_MIN_WIDTH ? 'tablet' : 'phone';
}
