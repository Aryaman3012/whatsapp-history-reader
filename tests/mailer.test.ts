import { test } from 'node:test';
import assert from 'node:assert/strict';
import nodemailer from 'nodemailer';
import { buildReportEmail, createMailer } from '../src/mailer.js';
import type { AuditReportResponse } from '../src/auditor/auditRoute.js';

const report = {
  range: '30d',
  summary: { zeroReplyRate: 42, zeroReplyCount: 21, totalLeads: 50 },
  zeroReply: { neverReplied: 21, total: 50, percentage: 42 },
  revenueAtRisk: {
    zeroReplyLeads: 21,
    atRiskLeads: 30,
    conversionRate: 0.3,
    avgTicketValue: 2000,
    estimatedRevenueAtRisk: 18000,
  },
} as unknown as AuditReportResponse;

const url = 'https://heyanaya.ai/whatsapp-audit/r/tok123';

test('the email carries the headline numbers and the link in both parts', () => {
  const mail = buildReportEmail({ clinic: 'Smile Dental', report, reportUrl: url });
  assert.match(mail.subject, /Smile Dental/);
  for (const part of [mail.text, mail.html]) {
    assert.ok(part.includes('21'), 'never-replied count missing');
    assert.ok(part.includes(url), 'report link missing');
    assert.ok(part.includes('18,000'), 'revenue at risk missing');
  }
});

test('a plain-text part always ships alongside the HTML', () => {
  const mail = buildReportEmail({ clinic: 'Smile Dental', report, reportUrl: url });
  assert.ok(mail.text.length > 40);
  assert.ok(!mail.text.includes('<'), 'text part must not contain markup');
});

test('send hands the built message to the transport', async () => {
  const sent: string[] = [];
  const spy = {
    sendMail: async (opts: Record<string, unknown>) => {
      sent.push(JSON.stringify(opts));
      return { messageId: 'x' };
    },
    verify: async () => true,
  } as unknown as nodemailer.Transporter;

  const mailer = createMailer({ from: 'reports@heyanaya.ai', replyTo: 'hello@heyanaya.ai' }, spy);
  await mailer.send('owner@clinic.ae', buildReportEmail({ clinic: 'Smile Dental', report, reportUrl: url }));

  assert.equal(sent.length, 1);
  assert.match(sent[0], /owner@clinic.ae/);
  assert.match(sent[0], /reports@heyanaya.ai/);
  assert.match(sent[0], /hello@heyanaya.ai/);
});

test('send rejects when the transport fails, so callers can record it', async () => {
  const failing = {
    sendMail: async () => {
      throw new Error('ECONNREFUSED');
    },
    verify: async () => false,
  } as unknown as nodemailer.Transporter;
  const mailer = createMailer({ from: 'reports@heyanaya.ai' }, failing);
  await assert.rejects(
    () => mailer.send('owner@clinic.ae', buildReportEmail({ clinic: 'C', report, reportUrl: url })),
    /ECONNREFUSED/
  );
});
