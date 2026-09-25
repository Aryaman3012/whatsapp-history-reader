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
}

export type ServerOptions = LocalServerOptions | ServeServerOptions;

const VALID_PHONE = /^\d{8,15}$/;

/**
 * Where /r/<token> sends the browser. That URL is one segment deeper than the
 * page, and the app may be mounted under a base path, so the target is
 * relative to the parent rather than absolute.
 */
export function reportRedirectTarget(token: string): string {
  return `../audit.html?report=${encodeURIComponent(token)}`;
}

/** Report tokens are database keys, never path segments. */
export function isSafeToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(token);
}

export function startServer(port: number, opts: ServerOptions): void {
  const app = express();
  app.use(express.json({ limit: '10kb' }));
  app.disable('x-powered-by');

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

  app.use(express.static(path.join(__dirname, '..', 'public'), { index: opts.mode === 'serve' ? 'start.html' : 'index.html' }));
  app.use(createAuditRouter(requireStore));

  // ---- Session lifecycle (serve mode only) --------------------------------
  if (opts.mode === 'serve') {
    app.post('/api/session', (req, res) => {
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

    app.get('/api/session/:sid', (req, res) => {
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
        stats: session.store.getStats(),
        expiresAt: null, // informational TTL is in the UI copy
      });
    });

    app.delete('/api/session/:sid', async (req, res) => {
      const destroyed = await opts.sessions.destroy(req.params.sid);
      res.json({ destroyed });
    });

    // ---- The gate: pair and sync first, then unlock the report ------------
    const unlockDeps: UnlockDeps = {
      sessions: {
        get: (sid) => {
          const s = opts.sessions.get(sid);
          return s ? { store: s.store, phone: s.phone } : undefined;
        },
      },
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

    app.post('/api/unlock', async (req, res) => {
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

    app.post('/api/unlock/resend', async (req, res) => {
      const result = await resendReport(unlockDeps, String(req.body?.sid ?? ''), req.body?.email);
      if (!result.ok) {
        res.status(result.status).json({ error: result.error });
        return;
      }
      res.json({ ok: true, email: result.email, delivered: result.delivered });
    });

    app.get('/api/report/:token', (req, res) => {
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

    app.get('/r/:token', (req, res) => {
      if (!isSafeToken(req.params.token)) {
        res.status(404).send('Report not found.');
        return;
      }
      res.redirect(reportRedirectTarget(req.params.token));
    });
  }

  // ---- Data routes (both modes; serve mode requires ?sid=) ----------------
  app.get('/api/chats', (req, res) => {
    const store = requireStore(req, res);
    if (store) res.json(store.getChats());
  });

  app.get('/api/chats/:jid/messages', (req, res) => {
    const store = requireStore(req, res);
    if (!store) return;
    const limit = Math.min(parseInt(String(req.query.limit ?? '50'), 10) || 50, 500);
    const offset = parseInt(String(req.query.offset ?? '0'), 10) || 0;
    res.json(store.getMessages(req.params.jid, limit, offset));
  });

  app.get('/api/search', (req, res) => {
    const store = requireStore(req, res);
    if (!store) return;
    const q = String(req.query.q ?? '').trim();
    res.json(q ? store.searchMessages(q) : []);
  });

  app.get('/api/stats', (req, res) => {
    const store = requireStore(req, res);
    if (store) res.json(store.getStats());
  });

  app.get('/api/qr', (req, res) => {
    const conn = resolveConn(req);
    res.json({
      qr: conn?.getQR() ?? null,
      connected: conn?.isConnected() ?? false,
      offline: opts.mode === 'local' && opts.conn === null,
    });
  });

  app.get('/api/pairing-code', (req, res) => {
    const conn = resolveConn(req);
    res.json({
      pairingCode: conn?.getPairingCode() ?? null,
      connected: conn?.isConnected() ?? false,
      offline: opts.mode === 'local' && opts.conn === null,
    });
  });

  app.get('/qr.png', async (req, res) => {
    const qr = resolveConn(req)?.getQR();
    if (!qr) {
      res.status(404).send('No QR code available');
      return;
    }
    const buffer = await QRCode.toBuffer(qr, { type: 'png', width: 320, margin: 1 });
    res.type('png').send(buffer);
  });

  app.get('/qr', (_req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'qr.html'));
  });

  app.listen(port, () => {
    console.log(`[web] ${opts.mode} mode — UI available at http://localhost:${port}`);
  });
}
