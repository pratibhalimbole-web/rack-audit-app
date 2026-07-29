import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  deleteCountRecord as repoDeleteCountRecord,
  markLocationCompleted as repoMarkLocationCompleted,
  saveCountRecord as repoSaveCountRecord,
  updateSavedLine as repoUpdateSavedLine,
} from '@/lib/locationsRepo';
import type { AuditLocationsTree, CountLine } from '@/lib/types';

type LocRef = { auditId: string; layout: string; rack: string; bay: string; loc: string };

// Thin wrapper over the locationsRepo mutation functions: each mutates the
// cached tree object in place, then invalidates ['locations', auditId] so
// every screen reading that query (Count Sheet, Rack View, Dashboard,
// Audit Details) recomputes its rollup/lastSaved/etc. Local `busy` state
// replaces useMutation here since there's nothing else (no optimistic UI,
// no retry) that a full mutation object would add.
export function useCountSheetMutations(auditId: string | undefined) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['locations', auditId] });

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
      invalidate();
    } finally {
      setBusy(false);
    }
  };

  return {
    busy,
    saveRecord: (tree: AuditLocationsTree, ref: LocRef, lines: CountLine[]) => run(() => repoSaveCountRecord(tree, ref, lines)),
    completeLocation: (tree: AuditLocationsTree, ref: LocRef) => run(() => repoMarkLocationCompleted(tree, ref)),
    deleteRecord: (tree: AuditLocationsTree, ref: LocRef, pallet: string) => run(() => repoDeleteCountRecord(tree, ref, pallet)),
    updateSavedLine: (tree: AuditLocationsTree, ref: LocRef, pallet: string, lineIdx: number, patch: Partial<Pick<CountLine, 'qty' | 'condition'>>) =>
      run(() => repoUpdateSavedLine(tree, ref, pallet, lineIdx, patch)),
  };
}
