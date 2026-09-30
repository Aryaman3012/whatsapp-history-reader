import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { ReportStore } from '../src/reports.js';
import { unlockReport, resendReport, validateUnlock, type UnlockDeps } from '../src/unlock.js';

const GOOD = {
  clinic: 'Smile Dental',
  name: 'Dr Khan',
  phone: '+971 50 000 0000',
  email: 'owner@clinic.ae',
  avgTicketValue: 2000,
};
const META = { ip: '1.2.3.4', userAgent: 'test', referrer: null };

interface Harness {
  deps: UnlockDeps;
  sent: Array<{ to: string; subject: string }>;
  leads: Array<Record<string, unknown>>;
  dir: string;
  reports: ReportStore;
  waStore: Store;
  destroyed: string[];
}

function harness(
  opts: {
    messages?: number;
    mailFails?: boolean;
    leadFails?: number | boolean;
    syncSettled?: boolean;
  } = {}
): Harness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unlock-test-'));
  const waStore = new Store(path.join(dir, 'wa.sqlite'));
  const jid = '971500000001@s.whatsapp.net';
  waStore.upsertChat({ id: jid, name: 'Fatima' });
  const now = Math.floor(Date.now() / 1000);
  for (let i = 0; i < (opts.messages ?? 2); i++) {
    waStore.insertMessage({
      id: 'm' + i,
      chat_jid: jid,
      sender_jid: jid,
      sender_pn: '971500000001',
      sender_name: 'Fatima',
      message_text: 'Do you do braces?',
      message_type: 'conversation',
      timestamp: now - 3600 + i * 60,
      has_media: 0,
      media_url: null,
      is_from_me: 0,
      raw_json: null,
    });
  }
  const reports = new ReportStore(path.join(dir, 'reports.db'));
  const sent: Array<{ to: string; subject: string }> = [];
  const leads: Array<Record<string, unknown>> = [];

  let leadAttempts = 0;
  const destroyed: string[] = [];

  const deps: UnlockDeps = {
    sessions: {
      get: (sid) =>
        sid === 'sess-1'
          ? { store: waStore, phone: '971500000009', syncSettled: opts.syncSettled ?? true }
          : undefined,
    },
    destroySession: async (sid) => {
      destroyed.push(sid);
    },
    reports,
    mailer: {
      send: async (to, email) => {
        if (opts.mailFails) throw new Error('ECONNREFUSED');
        sent.push({ to, subject: email.subject });
      },
      verify: async () => true,
    },
    sendLead: async (payload) => {
      leads.push(payload);
      leadAttempts++;
      const failFor =
        opts.leadFails === true ? Infinity : typeof opts.leadFails === 'number' ? opts.leadFails : 0;
      return leadAttempts <= failFor
        ? { ok: false, leadId: null, error: 'boom' }
        : { ok: true, leadId: 'lead-1' };
    },
    reportBaseUrl: 'https://heyanaya.ai/whatsapp-audit',
    resendCounts: new Map(),
    sleep: async () => {},
  };
  return { deps, sent, leads, dir, reports, waStore, destroyed };
}

function cleanup(h: Harness): void {
  h.reports.close();
  h.waStore.close();
  fs.rmSync(h.dir, { recursive: true, force: true });
}

test('validateUnlock normalises the phone and rejects bad input', () => {
  const ok = validateUnlock(GOOD);
  assert.equal(ok.ok, true);
  assert.equal(ok.ok && ok.value.phone, '971500000000');

  const bads: unknown[] = [
    { ...GOOD, email: 'not-an-email' },
    { ...GOOD, email: '' },
    { ...GOOD, phone: '123' },
    { ...GOOD, clinic: '   ' },
    { ...GOOD, clinic: 'x'.repeat(300) },
    null,
    'nope',
  ];
  for (const bad of bads) {
    assert.equal(validateUnlock(bad).ok, false, `should reject ${JSON.stringify(bad)}`);
  }
});

test('a successful unlock stores the report, mails it, and posts the lead', async () => {
  const h = harness();
  try {
    const result = await unlockReport(h.deps, 'sess-1', GOOD, META);
    assert.deepEqual(result, { ok: true, email: 'owner@clinic.ae', delivered: true });

    const row = h.reports.getBySession('sess-1')!;
    assert.equal(row.clinic, 'Smile Dental');
    assert.equal(row.waPhone, '971500000009');
    assert.deepEqual(Object.keys(row.report).sort(), ['1y', '30d', '90d']);
    assert.equal(row.emailStatus, 'sent');
    assert.equal(row.leadId, 'lead-1');

    assert.equal(h.sent.length, 1);
    assert.equal(h.sent[0].to, 'owner@clinic.ae');
    assert.equal(h.leads.length, 1);
    assert.match(String(h.leads[0].auditReportUrl), new RegExp(row.id));
  } finally {
    cleanup(h);
  }
});

test('the report link is never returned to the browser', async () => {
  const h = harness();
  try {
    const result = await unlockReport(h.deps, 'sess-1', GOOD, META);
    assert.ok(!JSON.stringify(result).includes(h.reports.getBySession('sess-1')!.id));
  } finally {
    cleanup(h);
  }
});

test('unlocking before anything has synced is refused', async () => {
  const h = harness({ messages: 0 });
  try {
    const result = await unlockReport(h.deps, 'sess-1', GOOD, META);
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.status, 409);
    assert.equal(h.sent.length, 0);
    assert.equal(h.reports.getBySession('sess-1'), undefined);
  } finally {
    cleanup(h);
  }
});

test('a double submit returns the first report without sending twice', async () => {
  const h = harness();
  try {
    await unlockReport(h.deps, 'sess-1', GOOD, META);
    const first = h.reports.getBySession('sess-1')!.id;
    const second = await unlockReport(h.deps, 'sess-1', GOOD, META);
    assert.equal(second.ok, true);
    assert.equal(h.sent.length, 1, 'must not send a second email');
    assert.equal(h.leads.length, 1, 'must not create a second lead');
    assert.equal(h.reports.getBySession('sess-1')!.id, first);
  } finally {
    cleanup(h);
  }
});

test('an unknown session is rejected', async () => {
  const h = harness();
  try {
    const result = await unlockReport(h.deps, 'ghost', GOOD, META);
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.status, 401);
  } finally {
    cleanup(h);
  }
});

test('a mail failure is recorded and reported as undelivered, not as success', async () => {
  const h = harness({ mailFails: true });
  try {
    const result = await unlockReport(h.deps, 'sess-1', GOOD, META);
    assert.deepEqual(result, { ok: true, email: 'owner@clinic.ae', delivered: false });
    const row = h.reports.getBySession('sess-1')!;
    assert.match(String(row.emailStatus), /ECONNREFUSED/);
    assert.equal(row.emailAttempts, 3);
  } finally {
    cleanup(h);
  }
});

test('a lead failure never blocks delivery', async () => {
  const h = harness({ leadFails: true });
  try {
    const result = await unlockReport(h.deps, 'sess-1', GOOD, META);
    assert.equal(result.ok && result.delivered, true);
    assert.match(String(h.reports.getBySession('sess-1')!.leadStatus), /boom/);
  } finally {
    cleanup(h);
  }
});

test('resend corrects the address and sends the stored report again', async () => {
  const h = harness();
  try {
    await unlockReport(h.deps, 'sess-1', GOOD, META);
    const result = await resendReport(h.deps, 'sess-1', 'right@clinic.ae');
    assert.deepEqual(result, { ok: true, email: 'right@clinic.ae', delivered: true });
    assert.equal(h.sent.length, 2);
    assert.equal(h.sent[1].to, 'right@clinic.ae');
    assert.equal(h.reports.getBySession('sess-1')!.email, 'right@clinic.ae');
    assert.equal(h.leads.length, 1, 'resend must not create another lead');
  } finally {
    cleanup(h);
  }
});

test('resend with no prior unlock is rejected', async () => {
  const h = harness();
  try {
    const result = await resendReport(h.deps, 'sess-1', 'right@clinic.ae');
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.status, 404);
  } finally {
    cleanup(h);
  }
});

test('unlocking while history is still arriving is refused', async () => {
  // Messages exist, but the sync has not settled. Freezing here would email a
  // partial report permanently — the WhatsApp data is gone at the TTL, so the
  // real numbers can never be recovered.
  const h = harness({ syncSettled: false });
  try {
    const result = await unlockReport(h.deps, 'sess-1', GOOD, META);
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.status, 409);
    assert.equal(h.sent.length, 0);
    assert.equal(h.reports.getBySession('sess-1'), undefined);
  } finally {
    cleanup(h);
  }
});

test('the WhatsApp session is released as soon as the report is frozen', async () => {
  // Holding the slot for the full TTL after the visitor has left puts the tool
  // at capacity after MAX_SESSIONS visitors per two hours — and keeps a device
  // linked that no longer needs to be.
  const h = harness();
  try {
    await unlockReport(h.deps, 'sess-1', GOOD, META);
    assert.deepEqual(h.destroyed, ['sess-1']);
  } finally {
    cleanup(h);
  }
});

test('resend still works after the session is gone', async () => {
  const h = harness();
  try {
    await unlockReport(h.deps, 'sess-1', GOOD, META);
    const result = await resendReport(h.deps, 'sess-1', 'right@clinic.ae');
    assert.equal(result.ok, true);
    assert.equal(h.sent[1].to, 'right@clinic.ae');
  } finally {
    cleanup(h);
  }
});

test('resend is rate limited per session', async () => {
  const h = harness();
  try {
    await unlockReport(h.deps, 'sess-1', GOOD, META);
    for (let i = 0; i < 3; i++) {
      assert.equal((await resendReport(h.deps, 'sess-1', `a${i}@clinic.ae`)).ok, true);
    }
    const blocked = await resendReport(h.deps, 'sess-1', 'a4@clinic.ae');
    assert.equal(blocked.ok, false);
    assert.equal(!blocked.ok && blocked.status, 429);
  } finally {
    cleanup(h);
  }
});

test('a transient lead failure is retried rather than lost', async () => {
  // Lead capture is the point of the feature; leads-api restarting during a
  // deploy must not cost the lead.
  const h = harness({ leadFails: 1 });
  try {
    await unlockReport(h.deps, 'sess-1', GOOD, META);
    assert.equal(h.leads.length, 2, 'should have retried once');
    assert.equal(h.reports.getBySession('sess-1')!.leadId, 'lead-1');
  } finally {
    cleanup(h);
  }
});

test('a double submit mid-send does not claim delivery failed', async () => {
  // email_status is only written once the send finishes; until then it is
  // 'queued', which must not be reported to the visitor as a failure.
  const h = harness();
  try {
    const first = unlockReport(h.deps, 'sess-1', GOOD, META);
    const second = await unlockReport(h.deps, 'sess-1', GOOD, META);
    await first;
    assert.equal(second.ok && second.delivered, true);
  } finally {
    cleanup(h);
  }
});
