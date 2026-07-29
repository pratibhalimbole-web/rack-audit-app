import { Platform } from 'react-native';
import type { ShadowToken } from './tokens';

// RN has no CSS-style multi-layer box-shadow — this turns one ShadowToken
// into the iOS shadow* props + Android `elevation`, applied as a single
// approximation of the source's two-layer CSS shadows (see tokens.ts).
export function applyShadow(token: ShadowToken) {
  if (Platform.OS === 'android') {
    return { elevation: token.elevation };
  }
  return {
    shadowColor: token.color,
    shadowOpacity: token.opacity,
    shadowRadius: token.radius,
    shadowOffset: { width: 0, height: Math.max(1, Math.round(token.radius / 3)) },
  };
}
