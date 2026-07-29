import type { Ionicons } from '@expo/vector-icons';
import type { AuditType } from './types';

// Ports auditTypeIcon (rack-audit-app.html line 2002): Full -> box, Cycle
// Count -> sync, Spot Check -> pin.
export const AUDIT_TYPE_ICON: Record<AuditType, keyof typeof Ionicons.glyphMap> = {
  Full: 'cube-outline',
  'Cycle Count': 'sync-outline',
  'Spot Check': 'location-outline',
};
