import { AUDITS } from './mockData';
import { sb, supabaseConfigured } from './supabase';
import type { Audit } from './types';

// Repo seam (per the architecture plan): screens/hooks only ever call
// through here, never straight at Supabase or the mock arrays — this is the
// one place that decides mock vs real backend, replacing the source's
// scattered `if (!sb) ...` null-checks (loadAllData, ~line 1374) with a
// single seam per domain concept.
export async function getAudits(): Promise<Audit[]> {
  if (!supabaseConfigured || !sb) return AUDITS;

  const { data, error } = await sb.from('audit_plans').select('*');
  if (error) throw error;
  return (data ?? []).map((r) => ({
    audit_id: r.audit_id,
    audit_name: r.audit_name,
    audit_type: r.audit_type,
    count_method: r.count_method,
    scope_type: r.scope_type,
    scope_values: r.scope_values ?? [],
    team_members: r.team_members ?? [],
    start_date: r.start_date,
    end_date: r.end_date,
    status: r.status,
    priority: r.priority,
  }));
}

export async function submitAudit(auditId: string): Promise<void> {
  if (!supabaseConfigured || !sb) {
    const audit = AUDITS.find((a) => a.audit_id === auditId);
    if (audit) audit.status = 'Submitted';
    return;
  }
  const { error } = await sb.from('audit_plans').update({ status: 'Submitted' }).eq('audit_id', auditId);
  if (error) throw error;
}
