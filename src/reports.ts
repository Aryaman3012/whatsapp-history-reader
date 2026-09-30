// Persistent store for frozen audit reports. Deliberately separate from the
// per-session databases: sessions (and their WhatsApp data) are purged at the
// TTL, reports are kept.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { AuditReportResponse } from './auditor/auditRoute.js';

export type FrozenReport = Record<string, AuditReportResponse>;

export interface NewReport {
  sessionId: string;
  email: string;
  name: string | null;
  phone: string;
  clinic: string;
  avgTicketValue: number | null;
  waPhone: string | null;
  report: FrozenReport;
  ip: string | null;
  userAgent: string | null;
  referrer: string | null;
}

export interface ReportRow {
  id: string;
  createdAt: number;
  sessionId: string;
  email: string;
  name: string | null;
  phone: string;
  clinic: string;
  avgTicketValue: number | null;
  waPhone: string | null;
  report: FrozenReport;
  leadId: string | null;
  leadStatus: string | null;
  emailStatus: string | null;
  emailSentAt: number | null;
  emailAttempts: number;
}

interface RawRow {
  id: string;
  created_at: number;
  session_id: string;
  email: string;
  name: string | null;
  phone: string;
  clinic: string;
  avg_ticket_value: number | null;
  wa_phone: string | null;
  report_json: string;
  lead_id: string | null;
  lead_status: string | null;
  email_status: string | null;
  email_sent_at: number | null;
  email_attempts: number;
}

export class ReportStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS reports (
        id               TEXT PRIMARY KEY,
        created_at       INTEGER NOT NULL,
        session_id       TEXT NOT NULL,
        email            TEXT NOT NULL,
        name             TEXT,
        phone            TEXT NOT NULL,
        clinic           TEXT NOT NULL,
        avg_ticket_value INTEGER,
        wa_phone         TEXT,
        report_json      TEXT NOT NULL,
        lead_id          TEXT,
        lead_status      TEXT,
        email_status     TEXT,
        email_sent_at    INTEGER,
        email_attempts   INTEGER NOT NULL DEFAULT 0,
        ip               TEXT,
        user_agent       TEXT,
        referrer         TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_reports_email   ON reports(email, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_reports_session ON reports(session_id);
    `);
  }

  private hydrate(raw: RawRow | undefined): ReportRow | undefined {
    if (!raw) return undefined;
    return {
      id: raw.id,
      createdAt: raw.created_at,
      sessionId: raw.session_id,
      email: raw.email,
      name: raw.name,
      phone: raw.phone,
      clinic: raw.clinic,
      avgTicketValue: raw.avg_ticket_value,
      waPhone: raw.wa_phone,
      report: JSON.parse(raw.report_json) as FrozenReport,
      leadId: raw.lead_id,
      leadStatus: raw.lead_status,
      emailStatus: raw.email_status,
      emailSentAt: raw.email_sent_at,
      emailAttempts: raw.email_attempts,
    };
  }

  create(input: NewReport): ReportRow {
    const id = crypto.randomBytes(24).toString('base64url');
    this.db
      .prepare(
        `INSERT INTO reports (id, created_at, session_id, email, name, phone, clinic,
           avg_ticket_value, wa_phone, report_json, email_status, email_attempts,
           ip, user_agent, referrer)
         VALUES (@id, @created_at, @session_id, @email, @name, @phone, @clinic,
           @avg_ticket_value, @wa_phone, @report_json, 'queued', 0, @ip, @user_agent, @referrer)`
      )
      .run({
        id,
        created_at: Date.now(),
        session_id: input.sessionId,
        email: input.email,
        name: input.name,
        phone: input.phone,
        clinic: input.clinic,
        avg_ticket_value: input.avgTicketValue,
        wa_phone: input.waPhone,
        report_json: JSON.stringify(input.report),
        ip: input.ip,
        user_agent: input.userAgent,
        referrer: input.referrer,
      });
    return this.get(id)!;
  }

  get(id: string): ReportRow | undefined {
    return this.hydrate(
      this.db.prepare('SELECT * FROM reports WHERE id = ?').get(id) as RawRow | undefined
    );
  }

  getBySession(sessionId: string): ReportRow | undefined {
    return this.hydrate(
      this.db
        .prepare('SELECT * FROM reports WHERE session_id = ? ORDER BY created_at DESC LIMIT 1')
        .get(sessionId) as RawRow | undefined
    );
  }

  setEmailStatus(id: string, status: string, attempts: number): void {
    this.db
      .prepare(
        'UPDATE reports SET email_status = ?, email_attempts = ?, email_sent_at = ? WHERE id = ?'
      )
      .run(status, attempts, status === 'sent' ? Date.now() : null, id);
  }

  setEmail(id: string, email: string): void {
    this.db.prepare('UPDATE reports SET email = ? WHERE id = ?').run(email, id);
  }

  setLeadStatus(id: string, leadId: string | null, status: string): void {
    this.db.prepare('UPDATE reports SET lead_id = ?, lead_status = ? WHERE id = ?').run(leadId, status, id);
  }

  close(): void {
    this.db.close();
  }
}
