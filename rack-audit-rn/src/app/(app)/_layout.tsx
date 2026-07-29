import PhoneTabsLayout from '@/components/PhoneTabsLayout';

// Bottom tab bar on every device class — the design calls for the same
// bottom nav on tablet too, not a separate side rail.
export default function AppLayout() {
  return <PhoneTabsLayout />;
}
