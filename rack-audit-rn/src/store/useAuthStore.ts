import { create } from 'zustand';
import { INSPECTOR } from '@/lib/mockData';
import { disableSupabaseForDevSkip, sb, supabaseConfigured } from '@/lib/supabase';
import type { Inspector } from '@/lib/types';

// Mirrors rack-audit-app.html's boot/auth flow: `boot()` restores a
// Supabase session and calls loadAllData(); when `sb` is null the source
// just goes straight to the dashboard with mock data (see the `!sb` guard
// at the goHome/boot call sites). Ported as a status machine instead of the
// source's STATE.stack=['login'] shortcut, so route-level `Stack.Protected`
// guards can key off one value.
type AuthStatus = 'loading' | 'authed' | 'anon';

type AuthState = {
  status: AuthStatus;
  inspector: Inspector | null;
  error: string | null;
  hydrate: () => Promise<void>;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  devSkipLogin: () => void;
};

export const useAuthStore = create<AuthState>((set) => ({
  status: 'loading',
  inspector: null,
  error: null,

  hydrate: async () => {
    if (!supabaseConfigured || !sb) {
      // Pure mock-data mode — same as the source's `if (!sb)` shortcut
      // straight to the dashboard.
      set({ status: 'authed', inspector: INSPECTOR });
      return;
    }
    const { data } = await sb.auth.getSession();
    if (data.session) {
      const { data: profile } = await sb
        .from('profiles')
        .select('*')
        .eq('id', data.session.user.id)
        .single();
      set({
        status: 'authed',
        inspector: profile
          ? { name: profile.full_name, initials: profile.initials, warehouse: profile.warehouse, email: profile.email, role: profile.role }
          : INSPECTOR,
      });
    } else {
      set({ status: 'anon' });
    }
  },

  signIn: async (email, password) => {
    if (!supabaseConfigured || !sb) {
      // No backend configured — mock mode always "succeeds".
      set({ status: 'authed', inspector: INSPECTOR, error: null });
      return;
    }
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if (error || !data.session) {
      set({ error: error?.message ?? 'Sign in failed' });
      return;
    }
    set({ status: 'authed', inspector: INSPECTOR, error: null });
  },

  signOut: async () => {
    if (sb) await sb.auth.signOut();
    set({ status: 'anon', inspector: null });
  },

  // TEMP DEV-ONLY: skips real Supabase auth entirely and enters with mock
  // INSPECTOR data, even when supabaseConfigured is true — for previewing
  // the app without needing real credentials. Remove before this build is
  // considered production-ready.
  devSkipLogin: () => {
    disableSupabaseForDevSkip();
    set({ status: 'authed', inspector: INSPECTOR, error: null });
  },
}));
