import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { useColorScheme as useSystemColorScheme } from 'react-native';
import { darkTheme, lightTheme, type ThemeTokens } from './tokens';

// Mirrors the source app's theme mechanism: an explicit user choice
// (rack-audit-app.html's `data-theme` attribute, set by `setTheme()`) wins
// over the OS preference, but the OS preference (`prefers-color-scheme`) is
// still the *default* until the user picks explicitly. Persisted so the
// choice survives app restarts, same as the toolbar toggle's intent.
const STORAGE_KEY = 'rack-audit:theme-mode';
type ThemeMode = 'light' | 'dark';

type ThemeContextValue = {
  mode: ThemeMode;
  tokens: ThemeTokens;
  setMode: (mode: ThemeMode) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const systemScheme = useSystemColorScheme();
  const [explicitMode, setExplicitMode] = useState<ThemeMode | null>(null);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY).then((stored) => {
      if (stored === 'light' || stored === 'dark') setExplicitMode(stored);
      setHydrated(true);
    });
  }, []);

  const mode: ThemeMode = explicitMode ?? (systemScheme === 'dark' ? 'dark' : 'light');
  const tokens = mode === 'dark' ? darkTheme : lightTheme;

  const setMode = (next: ThemeMode) => {
    setExplicitMode(next);
    AsyncStorage.setItem(STORAGE_KEY, next).catch(() => {});
  };

  const value = useMemo(() => ({ mode, tokens, setMode }), [mode, tokens]);

  // Avoid a flash of the wrong theme before AsyncStorage resolves.
  if (!hydrated) return null;

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme() must be used within a <ThemeProvider>');
  return ctx;
}
