// HTTP server. Two modes:
//  - local: one Store + optional one WA connection (the original single-user tool)
//  - serve: public multi-tenant free tool — every data route requires a valid
//    session token (?sid=), sessions are created via POST /api/session.
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store.js';
import type { WaConnection } from './connection.js';
import { SessionManager, SessionLimitError, RateLimitError } from './sessions.js';
import type { ReportStore } from './reports.js';
import type { Mailer } from './mailer.js';
import { unlockReport, resendReport, type UnlockDeps } from './unlock.js';
import { postLead } from './leads.js';
import { createAuditRouter } from './auditor/auditRoute.js';
import QRCode from 'qrcode';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface LocalServerOptions {
  mode: 'local';
  store: Store;
  conn: WaConnection | null; // null = offline mode
}

export interface ServeServerOptions {
  mode: 'serve';
  sessions: SessionManager;
  reports: ReportStore;
  mailer: Mailer;
  /** Public origin + base path, e.g. https://heyanaya.ai/whatsapp-audit */
  reportBaseUrl: string;
  leadsEndpoint: string;
  currency?: string;
  /** Last known SMTP verify result; null while unverified. Drives /health. */
  mailHealth?: () => boolean | null;
}

export type ServerOptions = LocalServerOptions | ServeServerOptions;

const VALID_PHONE = /^\d{8,15}$/;

export interface HealthInput {
  mode: 'local' | 'serve';
  uptimeSeconds: number;
  /** null = verify() has not answered yet. */
  mailOk: boolean | null;
  sessions: { active: number; max: number; paired: number } | null;
}

export interface HealthBody {
  ok: boolean;
  mode: 'local' | 'serve';
  uptimeSeconds: number;
  mail: 'ok' | 'unverified' | 'error' | 'n/a';
  sessions?: { active: number; max: number; paired: number };
  degraded: string[];
}

/**
 * What an uptime check sees. A live HTTP server is not the same as a working
 * tool: the report is emailed and nowhere else, so a serve process with dead
 * SMTP takes unlocks and delivers nothing. That reports 503 so an external
 * check pages, while an unverified mailer at boot does not.
 */
export function buildHealthPayload(input: HealthInput): { status: number; body: HealthBody } {
  const mail: HealthBody['mail'] =
    input.mode === 'local'
      ? 'n/a'
      : input.mailOk === null
        ? 'unverified'
        : input.mailOk
          ? 'ok'
          : 'error';
  const degraded: string[] = [];
  if (mail === 'error') degraded.push('smtp');
  // Full of sessions that never paired is an outage wearing a healthy face:
  // the process is fine, mail is fine, and every real clinic is turned away.
  if (input.sessions && input.sessions.active >= input.sessions.max && input.sessions.paired === 0) {
    degraded.push('capacity');
  }
  const body: HealthBody = {
    ok: degraded.length === 0,
    mode: input.mode,
    uptimeSeconds: Math.round(input.uptimeSeconds),
    mail,
    degraded,
  };
  if (input.sessions) body.sessions = input.sessions;
  return { status: degraded.length === 0 ? 200 : 503, body };
}

/**
 * Where /r/<token> sends the browser. That URL is one segment deeper than the
 * page, and the app may be mounted under a base path, so the target is
 * relative to the parent rather than absolute.
 */
export function reportRedirectTarget(token: string): string {
  return `../audit.html?report=${encodeURIComponent(token)}`;
}

/**
 * History arrives in batches and Baileys does not reliably report a final
 * 100%, so "settled" means either progress reached 100 or no batch has landed
 * for SYNC_QUIET_MS. Freezing before that emails a partial report that can
 * never be regenerated — the WhatsApp data is gone at the TTL.
 */
export const SYNC_QUIET_MS = 20_000;

export function isSyncSettled(
  progress: number | null,
  lastBatchAt: number | null,
  now: number = Date.now()
): boolean {
  if (progress !== null && progress >= 100) return true;
  if (lastBatchAt === null) return false;
  return now - lastBatchAt > SYNC_QUIET_MS;
}

/** Report tokens are database keys, never path segments. */
export function isSafeToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(token);
}

export function startServer(port: number, opts: ServerOptions): void {
  const app = express();
  app.use(express.json({ limit: '10kb' }));
  app.disable('x-powered-by');

  // Everything hangs off a router so the whole tool can be mounted under a
  // base path (e.g. /whatsapp-audit behind nginx). The pages use relative
  // URLs, so nothing else needs to know where it is mounted.
  const basePath = (process.env.BASE_PATH ?? '').replace(/\/+$/, '');
  const router = express.Router();

  // Registered before anything else: an uptime check must not depend on the
  // static mount, a session, or the store.
  router.get('/health', (_req, res) => {
    const health = buildHealthPayload({
      mode: opts.mode,
      uptimeSeconds: process.uptime(),
      mailOk: opts.mode === 'serve' ? (opts.mailHealth?.() ?? null) : null,
      sessions:
        opts.mode === 'serve'
          ? {
              active: opts.sessions.count(),
              max: opts.sessions.maxSessions(),
              paired: opts.sessions.pairedCount(),
            }
          : null,
    });
    res.status(health.status).json(health.body);
  });

  // Resolve which Store a request may read. In serve mode a missing/unknown
  // sid is a hard 401/404 — there is no cross-session access path.
  function resolveStore(req: express.Request): Store | null {
    if (opts.mode === 'local') return opts.store;
    const sid = String(req.query.sid ?? '');
    if (!sid) return null;
    return opts.sessions.get(sid)?.store ?? null;
  }

  function resolveConn(req: express.Request): WaConnection | null {
    if (opts.mode === 'local') return opts.conn;
    const sid = String(req.query.sid ?? '');
    if (!sid) return null;
    return opts.sessions.get(sid)?.conn ?? null;
  }

  function requireStore(req: express.Request, res: express.Response): Store | null {
    const store = resolveStore(req);
    if (!store) {
      res.status(401).json({ error: 'Missing or invalid session. Start at / to pair.' });
    }
    return store;
  }

  router.use(
    express.static(path.join(__dirname, '..', 'public'), {
      index: opts.mode === 'serve' ? 'start.html' : 'index.html',
    })
  );
  // The live audit route is local-mode only. In serve mode the report is
  // gated behind the unlock form and delivered by email, so exposing
  // /api/audit?sid=… would let anyone holding a sid read it ungated.
  if (opts.mode === 'local') router.use(createAuditRouter(requireStore));

  // ---- Session lifecycle (serve mode only) --------------------------------
  if (opts.mode === 'serve') {
    router.post('/api/session', (req, res) => {
      // No phone → QR pairing; phone → pairing-code flow.
      const rawPhone = String(req.body?.phone ?? '').replace(/[^\d]/g, '');
      const phone = rawPhone === '' ? null : rawPhone;
      if (phone !== null && !VALID_PHONE.test(phone)) {
        res.status(400).json({ error: 'Enter the WhatsApp number with country code, digits only (e.g. 9715XXXXXXXX).' });
        return;
      }
      const ip = String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? 'unknown')
        .split(',')[0]
        .trim();
      try {
        const session = opts.sessions.create(phone, ip);
        res.json({ sid: session.id });
      } catch (err) {
        if (err instanceof RateLimitError) res.status(429).json({ error: err.message });
        else if (err instanceof SessionLimitError) res.status(503).json({ error: err.message });
        else {
          console.error('[web] session create failed:', err);
          res.status(500).json({ error: 'Failed to start a session.' });
        }
      }
    });

    router.get('/api/session/:sid', (req, res) => {
      const session = opts.sessions.get(req.params.sid);
      if (!session) {
        res.status(404).json({ error: 'Session not found (it may have expired and been deleted).' });
        return;
      }
      res.json({
        status: session.conn.getStatus(),
        connected: session.conn.isConnected(),
        pairingCode: session.conn.getPairingCode(),
        hasQR: session.conn.getQR() !== null,
        syncProgress: session.conn.getSyncProgress(),
        syncSettled: isSyncSettled(session.conn.getSyncProgress(), session.conn.getLastSyncBatchAt()),
        stats: session.store.getStats(),
        expiresAt: null, // informational TTL is in the UI copy
      });
    });

    router.delete('/api/session/:sid', async (req, res) => {
      const destroyed = await opts.sessions.destroy(req.params.sid);
      res.json({ destroyed });
    });

    // ---- The gate: pair and sync first, then unlock the report ------------
    const unlockDeps: UnlockDeps = {
      sessions: {
        get: (sid) => {
          const s = opts.sessions.get(sid);
          if (!s) return undefined;
          return {
            store: s.store,
            phone: s.phone,
            syncSettled: isSyncSettled(s.conn.getSyncProgress(), s.conn.getLastSyncBatchAt()),
          };
        },
      },
      destroySession: (sid) => opts.sessions.destroy(sid),
      resendCounts: new Map<string, number>(),
      reports: opts.reports,
      mailer: opts.mailer,
      sendLead: (payload) => postLead(opts.leadsEndpoint, payload),
      reportBaseUrl: opts.reportBaseUrl,
      currency: opts.currency,
    };

    function clientIp(req: express.Request): string {
      return String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '')
        .split(',')[0]
        .trim();
    }

    router.post('/api/unlock', async (req, res) => {
      const sid = String(req.body?.sid ?? '');
      const result = await unlockReport(unlockDeps, sid, req.body, {
        ip: clientIp(req) || null,
        userAgent: String(req.headers['user-agent'] ?? '') || null,
        referrer: String(req.headers.referer ?? '') || null,
      });
      if (!result.ok) {
        res.status(result.status).json({ error: result.error });
        return;
      }
      // The link is deliberately absent: email is the only delivery path.
      res.json({ ok: true, email: result.email, delivered: result.delivered });
    });

    router.post('/api/unlock/resend', async (req, res) => {
      const result = await resendReport(unlockDeps, String(req.body?.sid ?? ''), req.body?.email);
      if (!result.ok) {
        res.status(result.status).json({ error: result.error });
        return;
      }
      res.json({ ok: true, email: result.email, delivered: result.delivered });
    });

    router.get('/api/report/:token', (req, res) => {
      const token = req.params.token;
      if (!isSafeToken(token)) {
        res.status(404).json({ error: 'Report not found.' });
        return;
      }
      const row = opts.reports.get(token);
      if (!row) {
        res.status(404).json({ error: 'Report not found.' });
        return;
      }
      res.json({ clinic: row.clinic, createdAt: row.createdAt, ranges: row.report });
    });

    router.get('/r/:token', (req, res) => {
      if (!isSafeToken(req.params.token)) {
        res.status(404).send('Report not found.');
        return;
      }
      res.redirect(reportRedirectTarget(req.params.token));
    });
  }

  // ---- Data routes (both modes; serve mode requires ?sid=) ----------------
  router.get('/api/chats', (req, res) => {
    const store = requireStore(req, res);
    if (store) res.json(store.getChats());
  });

  router.get('/api/chats/:jid/messages', (req, res) => {
    const store = requireStore(req, res);
    if (!store) return;
    const limit = Math.min(parseInt(String(req.query.limit ?? '50'), 10) || 50, 500);
    const offset = parseInt(String(req.query.offset ?? '0'), 10) || 0;
    res.json(store.getMessages(req.params.jid, limit, offset));
  });

  router.get('/api/search', (req, res) => {
    const store = requireStore(req, res);
    if (!store) return;
    const q = String(req.query.q ?? '').trim();
    res.json(q ? store.searchMessages(q) : []);
  });

  router.get('/api/stats', (req, res) => {
    const store = requireStore(req, res);
    if (store) res.json(store.getStats());
  });

  router.get('/api/qr', (req, res) => {
    const conn = resolveConn(req);
    res.json({
      qr: conn?.getQR() ?? null,
      connected: conn?.isConnected() ?? false,
      offline: opts.mode === 'local' && opts.conn === null,
    });
  });

  router.get('/api/pairing-code', (req, res) => {
    const conn = resolveConn(req);
    res.json({
      pairingCode: conn?.getPairingCode() ?? null,
      connected: conn?.isConnected() ?? false,
      offline: opts.mode === 'local' && opts.conn === null,
    });
  });

  router.get('/qr.png', async (req, res) => {
    const qr = resolveConn(req)?.getQR();
    if (!qr) {
      res.status(404).send('No QR code available');
      return;
    }
    const buffer = await QRCode.toBuffer(qr, { type: 'png', width: 320, margin: 1 });
    res.type('png').send(buffer);
  });

  router.get('/qr', (_req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'qr.html'));
  });

  app.use(basePath || '/', router);

  app.listen(port, () => {
    console.log(
      `[web] ${opts.mode} mode — UI available at http://localhost:${port}${basePath}/`
    );
  });
}
