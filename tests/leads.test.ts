import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLeadPayload, postLead, type LeadInput } from '../src/leads.js';
import type { AuditReportResponse } from '../src/auditor/auditRoute.js';

function reportWith(conversationCount: number): AuditReportResponse {
  return {
    range: '30d',
    totalConversations: conversationCount,
    summary: { zeroReplyRate: 42, zeroReplyCount: 21, totalLeads: 50 },
    zeroReply: { neverReplied: 21, total: 50, percentage: 42 },
    afterHoursLeadShare: { percentage: 61 },
    revenueAtRisk: {
      zeroReplyLeads: 21,
      atRiskLeads: 30,
      conversionRate: 0.3,
      avgTicketValue: 2000,
      estimatedRevenueAtRisk: 18000,
    },
    conversations: Array.from({ length: conversationCount }, (_, i) => ({
      chatJid: `9715000${i}@s.whatsapp.net`,
      chatName: `Patient number ${i} with a fairly long display name`,
    })),
  } as unknown as AuditReportResponse;
}

const input: LeadInput = {
  clinic: 'Smile Dental',
  name: 'Dr Khan',
  phone: '971500000000',
  email: 'owner@clinic.ae',
  avgTicketValue: 2000,
  report: reportWith(3),
  reportUrl: 'https://heyanaya.ai/whatsapp-audit/r/tok123',
};

test('the payload uses the field names leads-api actually reads', () => {
  // leads-api reads camelCase off the body: `body.adVariant`, `body.userAgent`.
  // A snake_case key is silently ignored and the lead falls through to
  // inferAdVariant()'s 'clinica' catch-all — the wrong bucket and the wrong
  // Slack channel, with nothing to notice it by.
  const p = buildLeadPayload({ ...input, userAgent: 'Mozilla/5.0' });
  assert.equal(p.adVariant, 'clinica-whatsapp-audit');
  assert.equal(p.userAgent, 'Mozilla/5.0');
  assert.ok(!('ad_variant' in p), 'snake_case ad_variant is ignored by leads-api');
  assert.ok(!('user_agent' in p), 'snake_case user_agent is ignored by leads-api');
});

test('the payload carries the variant, contact fields and the report link', () => {
  const p = buildLeadPayload(input);
  assert.equal(p.adVariant, 'clinica-whatsapp-audit');
  assert.equal(p.channel, 'form');
  assert.equal(p.source, 'whatsapp-audit');
  assert.equal(p.clinic, 'Smile Dental');
  assert.equal(p.phone, '971500000000');
  assert.equal(p.email, 'owner@clinic.ae');
  assert.match(String(p.notes), /tok123/);
  assert.match(String(p.notes), /21/);
});

test('the payload stays small no matter how many conversations the report holds', () => {
  const big = JSON.stringify(buildLeadPayload({ ...input, report: reportWith(500) }));
  assert.ok(big.length < 8000, `payload was ${big.length} bytes — leads-api caps bodies at 256KB`);
  assert.ok(!big.includes('Patient number 4'), 'per-conversation rows must not be sent');
});

test('postLead sends text/plain and returns the lead id', async () => {
  let seen: { url: string; init: RequestInit } | null = null;
  const fakeFetch = (async (url: string, init: RequestInit) => {
    seen = { url, init };
    return new Response(JSON.stringify({ ok: true, id: 'lead-1' }), { status: 200 });
  }) as unknown as typeof fetch;

  const result = await postLead('https://example.test/v1/leads', { a: 1 }, fakeFetch);
  assert.deepEqual(result, { ok: true, leadId: 'lead-1' });
  assert.equal(
    (seen!.init.headers as Record<string, string>)['Content-Type'],
    'text/plain;charset=utf-8'
  );
});

test('postLead reports failure instead of throwing', async () => {
  const failing = (async () => {
    throw new Error('network down');
  }) as unknown as typeof fetch;
  const result = await postLead('https://example.test/v1/leads', { a: 1 }, failing);
  assert.equal(result.ok, false);
  assert.match(String(result.error), /network down/);
});

test('postLead reports a non-2xx response as a failure', async () => {
  const rejecting = (async () => new Response('too large', { status: 413 })) as unknown as typeof fetch;
  const result = await postLead('https://example.test/v1/leads', { a: 1 }, rejecting);
  assert.equal(result.ok, false);
  assert.match(String(result.error), /413/);
});
