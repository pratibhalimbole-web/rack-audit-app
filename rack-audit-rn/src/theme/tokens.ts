// Ported 1:1 (same key groupings, same hex/rgba values) from the CSS custom
// properties in rack-audit-app.html (:root, :root[data-theme="dark"],
// :root[data-theme="light"] — lines ~10-146). Keep this file's shape in sync
// with that source of truth rather than re-deriving values by eye.
//
// RN has no multi-layer box-shadow — `shadow` below collapses the source's
// two-layer shadows into one representative {color, opacity, radius,
// elevation} used via theme/shadow.ts's `applyShadow()` helper, not ported
// as literal CSS shadow strings.

export type RagTone = {
  base: string;
  strong: string;
  soft: string;
  border: string;
};

export type AccentTone = {
  base: string;
  strong: string;
  soft: string;
  border: string;
};

export type ShadowToken = {
  color: string;
  opacity: number;
  radius: number;
  elevation: number;
};

export type ThemeTokens = {
  mode: 'light' | 'dark';

  background: string;
  foreground: string;
  card: string;
  cardForeground: string;
  popover: string;
  popoverForeground: string;
  primary: string;
  primaryForeground: string;
  secondary: string;
  secondaryForeground: string;
  muted: string;
  mutedForeground: string;
  accent: string;
  accentForeground: string;
  destructive: string;
  destructiveForeground: string;
  border: string;
  inputBackground: string;
  ring: string;

  rag: {
    red: RagTone;
    amber: RagTone;
    green: RagTone;
  };
  accentBlue: AccentTone;
  accentPurple: AccentTone;

  slate400: string;
  slate300: string;
  tableSurface: string;
  tableRowHover: string;

  shadow: ShadowToken;
  shadowCard: ShadowToken;
  shadowPress: ShadowToken;
  scrim: string;
  tabbarBg: string;
  tabbarHighlight: string;

  sidebar: string;
  sidebarForeground: string;
  sidebarPrimary: string;
  sidebarAccent: string;
  sidebarBorder: string;

  // Fixed brand color — same in both themes, matches source's separate
  // theme-invariant :root{ --brand-navy... } block (line 146).
  brandNavy: string;
  brandNavyDark: string;
  brandNavyInk: string;

  radius: {
    sm: number; // --radius (4px)
    lg: number; // --radius-lg (8px)
    xl: number; // --radius-xl (12px)
    xxl: number; // --radius-2xl (20px)
  };
  iconSize: number;

  // --text-2xs..--text-xl (source lines 62-67)
  text: {
    xxs: number;
    xs: number;
    sm: number;
    base: number;
    lg: number;
    xl: number;
  };
  fontWeight: {
    normal: '400';
    medium: '500';
    semibold: '600';
    bold: '700';
    extrabold: '800';
  };
};

const fontWeight = {
  normal: '400' as const,
  medium: '500' as const,
  semibold: '600' as const,
  bold: '700' as const,
  extrabold: '800' as const,
};

const radius = { sm: 4, lg: 8, xl: 12, xxl: 20 };
const text = { xxs: 10, xs: 11, sm: 12.5, base: 13.5, lg: 15, xl: 17 };
const iconSize = 16;

const brand = {
  brandNavy: '#1b59f8',
  brandNavyDark: '#133eb7',
  brandNavyInk: '#ffffff',
};

export const lightTheme: ThemeTokens = {
  mode: 'light',
  background: '#ffffff',
  foreground: '#0f172a',
  card: '#ffffff',
  cardForeground: '#0f172a',
  popover: '#ffffff',
  popoverForeground: '#000000',
  primary: '#1b59f8',
  primaryForeground: '#ffffff',
  secondary: '#f1f5f9',
  secondaryForeground: '#0f172a',
  muted: '#f8fafc',
  mutedForeground: '#64748b',
  accent: '#f1f5f9',
  accentForeground: '#0f172a',
  destructive: '#ef4444',
  destructiveForeground: '#ffffff',
  border: '#e2e8f0',
  inputBackground: '#ffffff',
  ring: '#1b59f8',

  rag: {
    red: { base: '#ef4444', strong: '#b91c1c', soft: '#fef2f2', border: '#fecaca' },
    amber: { base: '#d97706', strong: '#b45309', soft: '#fef9c3', border: '#fde68a' },
    green: { base: '#22c55e', strong: '#15803d', soft: '#dcfce7', border: '#bbf7d0' },
  },
  accentBlue: { base: '#1b59f8', strong: '#133eb7', soft: '#dbeafe', border: '#bfdbfe' },
  accentPurple: { base: '#7c3aed', strong: '#6d28d9', soft: '#ede9fe', border: '#ddd6fe' },

  slate400: '#94a3b8',
  slate300: '#cbd5e1',
  tableSurface: '#ffffff', // var(--card) in light theme
  tableRowHover: 'rgba(15,23,42,0.04)',

  shadow: { color: '#1e293b', opacity: 0.14, radius: 4, elevation: 3 },
  shadowCard: { color: '#2563eb', opacity: 0.05, radius: 18, elevation: 1 },
  shadowPress: { color: '#0f172a', opacity: 0.06, radius: 1, elevation: 1 },
  scrim: 'rgba(255,255,255,.82)',
  tabbarBg: 'rgba(255,255,255,.4)',
  tabbarHighlight: 'rgba(255,255,255,.7)',

  sidebar: '#ffffff',
  sidebarForeground: '#0f172a',
  sidebarPrimary: '#1b59f8',
  sidebarAccent: '#f1f5f9',
  sidebarBorder: '#e2e8f0',

  ...brand,
  radius,
  iconSize,
  text,
  fontWeight,
};

export const darkTheme: ThemeTokens = {
  mode: 'dark',
  background: '#0a0a0a',
  foreground: '#ffffff',
  card: '#171717',
  cardForeground: '#ffffff',
  popover: '#171717',
  popoverForeground: '#ffffff',
  primary: '#3b82f6',
  primaryForeground: '#ffffff',
  secondary: '#262626',
  secondaryForeground: '#ffffff',
  muted: '#262626',
  mutedForeground: '#a3a3a3',
  accent: '#262626',
  accentForeground: '#ffffff',
  destructive: '#ef4444',
  destructiveForeground: '#ffffff',
  border: 'rgba(250,250,250,.10)',
  inputBackground: '#262626',
  ring: '#3b82f6',

  rag: {
    red: { base: '#f87171', strong: '#fca5a5', soft: 'rgba(239,68,68,.18)', border: 'rgba(239,68,68,.40)' },
    amber: { base: '#fbbf24', strong: '#fcd34d', soft: 'rgba(217,119,6,.18)', border: 'rgba(217,119,6,.40)' },
    green: { base: '#4ade80', strong: '#86efac', soft: 'rgba(34,197,94,.16)', border: 'rgba(34,197,94,.40)' },
  },
  accentBlue: { base: '#60a5fa', strong: '#93c5fd', soft: 'rgba(59,130,246,.18)', border: 'rgba(59,130,246,.40)' },
  accentPurple: { base: '#a78bfa', strong: '#c4b5fd', soft: 'rgba(124,58,237,.20)', border: 'rgba(124,58,237,.45)' },

  slate400: '#737373',
  slate300: '#525252',
  tableSurface: '#262626', // var(--muted) in dark theme
  tableRowHover: 'rgba(250,250,250,.05)',

  shadow: { color: '#000000', opacity: 0.4, radius: 2, elevation: 4 },
  shadowCard: { color: '#000000', opacity: 0.12, radius: 18, elevation: 2 },
  shadowPress: { color: '#000000', opacity: 0.3, radius: 1, elevation: 1 },
  scrim: 'rgba(23,23,23,.82)',
  tabbarBg: 'rgba(23,23,23,.4)',
  tabbarHighlight: 'rgba(255,255,255,.1)',

  sidebar: '#171717',
  sidebarForeground: '#ffffff',
  sidebarPrimary: '#3b82f6',
  sidebarAccent: '#262626',
  sidebarBorder: 'rgba(250,250,250,.10)',

  ...brand,
  radius,
  iconSize,
  text,
  fontWeight,
};

export function ragToneFor(tokens: ThemeTokens, tone: 'red' | 'amber' | 'green'): RagTone {
  return tokens.rag[tone];
}
