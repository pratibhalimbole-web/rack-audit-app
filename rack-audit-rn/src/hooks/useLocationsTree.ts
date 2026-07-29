import { useQueries, useQuery } from '@tanstack/react-query';
import { allLocations, lastSaved, rollup, type LocationEntry, type Rollup } from '@/lib/auditLogic';
import { getLocationsTree } from '@/lib/locationsRepo';
import type { AuditLocationsTree } from '@/lib/types';

// Repo-backed selector layer over LOCATIONS/getLocationsTree, shared by
// Dashboard (rollup + lastSaved per audit) and, later, Audit Details/Rack
// View (which need the same tree plus allLocations()). Kept here rather than
// duplicated per feature since the underlying query key/fetch is identical.
export function useLocationsTree(auditId: string | undefined) {
  return useQuery({
    queryKey: ['locations', auditId],
    queryFn: () => getLocationsTree(auditId as string),
    enabled: !!auditId,
  });
}

export function useAuditProgress(auditId: string | undefined): {
  rollup: Rollup;
  lastSaved: LocationEntry | null;
  isLoading: boolean;
} {
  const { data, isLoading } = useLocationsTree(auditId);
  return { rollup: rollup(data), lastSaved: lastSaved(data), isLoading };
}

export type AuditProgress = { rollup: Rollup; lastSaved: LocationEntry | null; allLocations: LocationEntry[] };

// Batches one query per audit id via useQueries (rather than calling
// useLocationsTree in a .map(), which would break the rules of hooks) — used
// by the tablet Dashboard's overview totals and the phone Dashboard's list.
export function useAuditProgressMap(auditIds: string[]): { map: Record<string, AuditProgress>; isLoading: boolean } {
  const results = useQueries({
    queries: auditIds.map((auditId) => ({
      queryKey: ['locations', auditId],
      queryFn: () => getLocationsTree(auditId),
    })),
  });

  const map: Record<string, AuditProgress> = {};
  auditIds.forEach((auditId, i) => {
    const tree: AuditLocationsTree | undefined = results[i]?.data;
    map[auditId] = { rollup: rollup(tree), lastSaved: lastSaved(tree), allLocations: allLocations(tree) };
  });

  return { map, isLoading: results.some((r) => r.isLoading) };
}
