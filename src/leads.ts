// Lead capture into the existing leads-api. Nothing in that service changes:
// it accepts unknown ad_variants without migration, stores the whole body in
// raw_json, and caps request bodies at 256KB — so this sends a summary, never
// the report itself.
import type { AuditReportResponse } from './auditor/auditRoute.js';

export const LEADS_ENDPOINT = 'https://leads.cashflohero.ai/v1/leads';

export interface LeadInput {
  clinic: string;
  name: string | null;
  phone: string;
  email: string;
  avgTicketValue: number | null;
  report: AuditReportResponse;
  reportUrl: string;
  userAgent?: string | null;
  referrer?: string | null;
}

export function buildLeadPayload(input: LeadInput): Record<string, unknown> {
  const r = input.report;
  const missed = r.zeroReply.neverReplied;
  const total = r.zeroReply.total;
  const atRisk = Math.round(r.revenueAtRisk.estimatedRevenueAtRisk);

  return {
    ad_variant: 'clinica-whatsapp-audit',
    channel: 'form',
    source: 'whatsapp-audit',
    name: input.name,
    phone: input.phone,
    email: input.email,
    clinic: input.clinic,
    notes:
      `WhatsApp audit: ${missed} of ${total} enquiries never replied to ` +
      `(${Math.round(r.zeroReply.percentage)}%), ~${atRisk} at risk over ${r.range}. ` +
      `Report: ${input.reportUrl}`,
    // Compact summary only — never the conversation rows.
    audit_never_replied: missed,
    audit_total_leads: total,
    audit_zero_reply_pct: Math.round(r.zeroReply.percentage),
    audit_revenue_at_risk: atRisk,
    audit_avg_ticket_value: input.avgTicketValue,
    audit_range: r.range,
    audit_report_url: input.reportUrl,
    user_agent: input.userAgent ?? null,
    referrer: input.referrer ?? null,
  };
}

export async function postLead(
  endpoint: string,
  payload: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch
): Promise<{ ok: boolean; leadId: string | null; error?: string }> {
  try {
    const res = await fetchImpl(endpoint, {
      method: 'POST',
      // text/plain matches every other landing and dodges the CORS preflight.
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) return { ok: false, leadId: null, error: `lead POST returned ${res.status}` };
    const data = (await res.json().catch(() => ({}))) as { id?: string };
    return { ok: true, leadId: data.id ?? null };
  } catch (err) {
    return { ok: false, leadId: null, error: String(err instanceof Error ? err.message : err) };
  }
}
