import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import Constants from 'expo-constants';

// Mirrors rack-audit-app.html's `sb` setup (lines 1074-1080): falls back to
// `null` when not configured so the app runs entirely on mock fixture data.
// Sourced from app.config values (EXPO_PUBLIC_* env) instead of hardcoded
// constants — same "anon key is fine to ship client-side, RLS is the real
// boundary" reasoning as the source's comment.
const extra = (Constants.expoConfig?.extra ?? {}) as Record<string, string | undefined>;
const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL ?? extra.supabaseUrl ?? '';
const SUPABASE_ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? extra.supabaseAnonKey ?? '';

// Metro's dev server itself evaluates this module under plain Node (not
// just the RN runtime on-device) while statically resolving the bundle —
// there's no `window` global in that pass, only on an actual device/
// simulator (React Native aliases `window` to `global`) or the web. A real
// client built there crashes the whole Metro process: Realtime's
// createClient() throws on Node < 22's missing native WebSocket, and even
// past that, GoTrueClient's session restore reads AsyncStorage, which
// itself reads `window` and throws ReferenceError with none defined. None
// of that Node-side evaluation ever needs a working client, so this skips
// construction there entirely rather than special-casing both failures.
const hasRuntimeWindow = typeof window !== 'undefined';

// `let`, not `const` — devSkipLogin flips this off at runtime so every repo
// call site (they all gate on this same binding) falls back to mock data
// instead of querying real, RLS-protected tables with no authenticated
// session, which otherwise renders as blank screens everywhere.
export let supabaseConfigured = hasRuntimeWindow && SUPABASE_URL.startsWith('http') && !!SUPABASE_ANON_KEY;

export const sb: SupabaseClient | null = supabaseConfigured
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        storage: AsyncStorage,
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: false,
      },
    })
  : null;

export function disableSupabaseForDevSkip(): void {
  supabaseConfigured = false;
}
