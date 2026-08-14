import { PinLocationScreen } from '@/features/quick-scan/PinLocationScreen';

// Presented as a modal, matching how /scan itself opens — Quick Scan's
// "Pin Exact Location" needed a real full screen (dropdowns + a 3D-style
// map) rather than the small WarehouseMapModal popup it used before.
export default function PinLocationRoute() {
  return <PinLocationScreen />;
}
