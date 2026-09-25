// Report delivery. The report is emailed and nowhere else, so this module is
// the only delivery path in the product — keep the template pure and the
// transport injectable so both stay testable without a network.
import nodemailer, { type Transporter } from 'nodemailer';
import type { AuditReportResponse } from './auditor/auditRoute.js';

export interface BuiltEmail {
  subject: string;
  text: string;
  html: string;
}

export interface MailerConfig {
  host?: string;
  port?: number;
  secure?: boolean;
  user?: string;
  pass?: string;
  from: string;
  replyTo?: string;
  currency?: string;
}

export interface Mailer {
  send(to: string, email: BuiltEmail): Promise<void>;
  verify(): Promise<boolean>;
}

function money(amount: number, currency: string): string {
  return `${currency} ${Math.round(amount).toLocaleString('en-US')}`;
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string
  );
}

export function buildReportEmail(args: {
  clinic: string;
  report: AuditReportResponse;
  reportUrl: string;
  currency?: string;
}): BuiltEmail {
  const { clinic, report, reportUrl } = args;
  const currency = args.currency ?? 'AED';
  const missed = report.zeroReply.neverReplied;
  const total = report.zeroReply.total;
  const atRisk = money(report.revenueAtRisk.estimatedRevenueAtRisk, currency);

  const subject = `${clinic}: ${missed} patient enquiries never got a reply`;

  const text = [
    `Your WhatsApp lead audit for ${clinic} is ready.`,
    ``,
    `${missed} of ${total} patient enquiries never got a reply.`,
    `That is about ${atRisk} of treatment value left unanswered.`,
    ``,
    `Read the full report here:`,
    reportUrl,
    ``,
    `This link is private — anyone with it can read the report, so don't forward it further than you mean to.`,
    `Your WhatsApp connection has already been removed and the chat history we synced is deleted.`,
  ].join('\n');

  const html = `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#1a1a1a;line-height:1.55">
<p>Your WhatsApp lead audit for <strong>${escapeHtml(clinic)}</strong> is ready.</p>
<p style="font-size:20px;margin:24px 0 4px"><strong>${missed}</strong> of ${total} patient enquiries never got a reply.</p>
<p style="margin:0 0 24px;color:#555">That is about <strong>${escapeHtml(atRisk)}</strong> of treatment value left unanswered.</p>
<p><a href="${escapeHtml(reportUrl)}" style="background:#1a7f4b;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;display:inline-block">Read the full report</a></p>
<p style="font-size:13px;color:#777;margin-top:28px">This link is private — anyone with it can read the report. Your WhatsApp connection has already been removed and the chat history we synced is deleted.</p>
</body></html>`;

  return { subject, text, html };
}

export function createMailer(config: MailerConfig, transport?: Transporter): Mailer {
  // No SMTP host configured (local development): print the mail instead of
  // sending it, so the unlock flow is exercisable offline.
  const logOnly = !config.host && !transport;
  const tx =
    transport ??
    (config.host
      ? nodemailer.createTransport({
          host: config.host,
          port: config.port ?? 465,
          secure: config.secure ?? true,
          auth: config.user ? { user: config.user, pass: config.pass } : undefined,
        })
      : nodemailer.createTransport({ streamTransport: true, newline: 'unix', buffer: true }));

  if (logOnly) {
    console.warn('[mail] No SMTP_HOST configured — report emails will be logged, not sent.');
  }

  return {
    async send(to: string, email: BuiltEmail): Promise<void> {
      const info = await tx.sendMail({
        from: config.from,
        replyTo: config.replyTo,
        to,
        subject: email.subject,
        text: email.text,
        html: email.html,
      });
      if (logOnly) {
        console.log(`[mail] (not sent — no SMTP configured) to=${to} subject=${email.subject}`);
        console.log(String((info as { message?: Buffer }).message ?? ''));
      }
    },
    async verify(): Promise<boolean> {
      try {
        await tx.verify();
        return true;
      } catch (err) {
        console.error('[mail] SMTP verify failed:', err);
        return false;
      }
    },
  };
}
