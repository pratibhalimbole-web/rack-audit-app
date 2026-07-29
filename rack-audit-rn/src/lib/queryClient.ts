import { QueryClient } from '@tanstack/react-query';

// One shared client for the whole app — repo functions (lib/*Repo.ts, added
// per-feature as screens are built) are the only things that call Supabase/
// mock data directly; screens/hooks only ever go through TanStack Query.
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
    },
  },
});
