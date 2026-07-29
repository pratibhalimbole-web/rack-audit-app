import { useQuery } from '@tanstack/react-query';
import { currentOngoing, mine } from '@/lib/auditLogic';
import { getAudits } from '@/lib/auditsRepo';

export function useAudits() {
  return useQuery({ queryKey: ['audits'], queryFn: getAudits });
}

export function useMyAudits() {
  const { data, ...rest } = useAudits();
  return { data: data ? mine(data) : undefined, ...rest };
}

export function useCurrentOngoing() {
  const { data } = useAudits();
  return data ? currentOngoing(data) : undefined;
}
