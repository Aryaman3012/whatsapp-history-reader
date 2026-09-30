// The gate. A visitor pairs and syncs first; this is what happens when they
// ask for the report: freeze it, store it, email it, and record the lead.
// The report is never returned to the browser — email is the only delivery
// path, so the link exists nowhere else.
import { buildAuditReport } from './auditor/auditRoute.js';
import type { Store } from './store.js';
import type { ReportStore, ReportRow, FrozenReport } from './reports.js';
import { buildReportEmail, type Mailer } from './mailer.js';
import { buildLeadPayload } from './leads.js';

export const FROZEN_RANGES = ['30d', '90d', '1y'] as const;

const EMAIL_RE = /^[^\s@]+@[^\s@.]+\.[^\s@]{2,}$/;
const MAX_FIELD = 200;
const SEND_ATTEMPTS = 3;
const LEAD_ATTEMPTS = 3;
const MAX_RESENDS_PER_SESSION = 3;

export interface UnlockInput {
  clinic: string;
  name: string | null;
  phone: string;
  email: string;
  avgTicketValue: number | null;
}

export interface UnlockSession {
  store: Store;
  phone: string | null;
  /** False while history is still arriving — freezing then emails a partial report. */
  syncSettled: boolean;
}

export interface UnlockDeps {
  sessions: { get(sid: string): UnlockSession | undefined };
  /** Unlink and purge the WhatsApp session once its report is frozen. */
  destroySession?: (sid: string) => Promise<unknown>;
  /** Resend counters per session; the server owns one for the process. */
  resendCounts?: Map<string, number>;
  reports: ReportStore;
  mailer: Mailer;
  sendLead: (
    payload: Record<string, unknown>
  ) => Promise<{ ok: boolean; leadId: string | null; error?: string }>;
  reportBaseUrl: string;
  currency?: string;
  sleep?: (ms: number) => Promise<void>;
}

export interface UnlockMeta {
  ip: string | null;
  userAgent: string | null;
  referrer: string | null;
}

export type UnlockResult =
  | { ok: true; email: string; delivered: boolean }
  | { ok: false; status: number; error: string };

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

export function validateUnlock(
  raw: unknown
): { ok: true; value: UnlockInput } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'Missing form data.' };
  const body = raw as Record<string, unknown>;

  const clinic = str(body.clinic);
  if (!clinic || clinic.length > MAX_FIELD) return { ok: false, error: 'Enter your clinic name.' };

  const name = str(body.name).slice(0, MAX_FIELD) || null;

  const phone = str(body.phone).replace(/[^\d]/g, '');
  if (phone.length < 8 || phone.length > 15) {
    return { ok: false, error: 'Enter your mobile number with country code.' };
  }

  const email = str(body.email).toLowerCase();
  if (!email || email.length > MAX_FIELD || !EMAIL_RE.test(email)) {
    return { ok: false, error: 'Enter a valid email address — the report is sent there.' };
  }

  const rawTicket = body.avgTicketValue;
  const ticketNumber = typeof rawTicket === 'number' ? rawTicket : Number(str(rawTicket));
  const avgTicketValue =
    Number.isFinite(ticketNumber) && ticketNumber > 0 ? Math.round(ticketNumber) : null;

  return { ok: true, value: { clinic, name, phone, email, avgTicketValue } };
}

function freeze(store: Store, avgTicketValue: number | null): FrozenReport {
  const options = avgTicketValue ? { avgTicketValue } : {};
  const frozen: FrozenReport = {};
  for (const range of FROZEN_RANGES) {
    frozen[range] = buildAuditReport(store, range, options);
  }
  return frozen;
}

/** Sends with bounded retries. Returns the status string to record. */
async function deliver(
  deps: UnlockDeps,
  row: ReportRow,
  to: string
): Promise<{ delivered: boolean; status: string; attempts: number }> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const email = buildReportEmail({
    clinic: row.clinic,
    report: row.report['30d'],
    reportUrl: `${deps.reportBaseUrl}/r/${row.id}`,
    currency: deps.currency,
  });

  let lastError = 'unknown error';
  for (let attempt = 1; attempt <= SEND_ATTEMPTS; attempt++) {
    try {
      await deps.mailer.send(to, email);
      return { delivered: true, status: 'sent', attempts: attempt };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (attempt < SEND_ATTEMPTS) await sleep(attempt * 500);
    }
  }
  return { delivered: false, status: `error: ${lastError}`, attempts: SEND_ATTEMPTS };
}

export async function unlockReport(
  deps: UnlockDeps,
  sid: string,
  raw: unknown,
  meta: UnlockMeta
): Promise<UnlockResult> {
  const parsed = validateUnlock(raw);
  if (!parsed.ok) return { ok: false, status: 400, error: parsed.error };

  const session = deps.sessions.get(sid);
  if (!session) {
    return { ok: false, status: 401, error: 'Your session expired. Reload and connect again.' };
  }

  // A double-clicked form must not freeze a second report or send twice.
  // 'queued' means the first send is still in flight — not a failure.
  const existing = deps.reports.getBySession(sid);
  if (existing) {
    return {
      ok: true,
      email: existing.email,
      delivered: existing.emailStatus === 'sent' || existing.emailStatus === 'queued',
    };
  }

  if (session.store.getStats().totalMessages === 0 || !session.syncSettled) {
    return { ok: false, status: 409, error: 'Still syncing your history — try again in a moment.' };
  }

  const { clinic, name, phone, email, avgTicketValue } = parsed.value;
  const row = deps.reports.create({
    sessionId: sid,
    email,
    name,
    phone,
    clinic,
    avgTicketValue,
    waPhone: session.phone,
    report: freeze(session.store, avgTicketValue),
    ip: meta.ip,
    userAgent: meta.userAgent,
    referrer: meta.referrer,
  });

  const sendResult = await deliver(deps, row, email);
  deps.reports.setEmailStatus(row.id, sendResult.status, sendResult.attempts);

  // The lead is captured whether or not the mail got through — a delivery
  // failure is exactly when someone should be calling this clinic. Capture is
  // the whole point of the feature, so a transient leads-api blip is retried
  // rather than written off.
  const payload = buildLeadPayload({
    clinic,
    name,
    phone,
    email,
    avgTicketValue,
    report: row.report['30d'],
    reportUrl: `${deps.reportBaseUrl}/r/${row.id}`,
    userAgent: meta.userAgent,
    referrer: meta.referrer,
  });
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  let lead = await deps.sendLead(payload);
  for (let attempt = 2; attempt <= LEAD_ATTEMPTS && !lead.ok; attempt++) {
    await sleep((attempt - 1) * 500);
    lead = await deps.sendLead(payload);
  }
  deps.reports.setLeadStatus(row.id, lead.leadId, lead.ok ? 'sent' : `error: ${lead.error}`);

  // The report is frozen and stored, so the WhatsApp link has done its job:
  // unlink now rather than holding a session slot — and a linked device — for
  // the rest of the TTL.
  if (deps.destroySession) {
    void deps.destroySession(sid).catch(() => {
      /* the TTL reaper is the backstop */
    });
  }

  return { ok: true, email, delivered: sendResult.delivered };
}

export async function resendReport(
  deps: UnlockDeps,
  sid: string,
  rawEmail: unknown
): Promise<UnlockResult> {
  const email = str(rawEmail).toLowerCase();
  if (!email || email.length > MAX_FIELD || !EMAIL_RE.test(email)) {
    return { ok: false, status: 400, error: 'Enter a valid email address.' };
  }
  // Deliberately not requiring a live session: the WhatsApp link is dropped as
  // soon as the report is frozen, and the report outlives it. Knowing the sid
  // is the credential, exactly as it is for the rest of the session's data.
  const row = deps.reports.getBySession(sid);
  if (!row) return { ok: false, status: 404, error: 'No report to resend yet.' };

  const counts = deps.resendCounts;
  if (counts) {
    const used = counts.get(sid) ?? 0;
    if (used >= MAX_RESENDS_PER_SESSION) {
      return { ok: false, status: 429, error: 'Too many resends. Run the audit again if you need it.' };
    }
    counts.set(sid, used + 1);
  }

  deps.reports.setEmail(row.id, email);
  const sendResult = await deliver(deps, { ...row, email }, email);
  deps.reports.setEmailStatus(row.id, sendResult.status, sendResult.attempts);
  return { ok: true, email, delivered: sendResult.delivered };
}
