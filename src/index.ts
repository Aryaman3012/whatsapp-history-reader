// Entry point. Modes:
//   npm run dev -- offline         local: serve ./whatsapp.db only, no WhatsApp
//   npm run dev -- 919876543210    local: pair this number via code, sync into ./whatsapp.db
//   npm run dev                    local: pair via QR, sync into ./whatsapp.db
//   npm run dev -- serve           public free tool: multi-tenant ephemeral sessions
import path from 'node:path';
import { Store } from './store.js';
import { createWaConnection } from './connection.js';
import { SessionManager } from './sessions.js';
import { startServer } from './server.js';
import { ReportStore } from './reports.js';
import { createMailer } from './mailer.js';
import { LEADS_ENDPOINT } from './leads.js';

const PORT = parseInt(process.env.PORT ?? '3000', 10);

console.log('[app] WhatsApp History Reader (read-only) starting...');

const rawArg = process.argv[2]?.trim();

if (rawArg === 'serve') {
  const dataDir = process.env.DATA_DIR ?? './data';
  const ttlMin = parseInt(process.env.SESSION_TTL_MIN ?? '120', 10);
  const maxSessions = parseInt(process.env.MAX_SESSIONS ?? '10', 10);
  const createsPerIpPerHour = parseInt(process.env.CREATES_PER_IP_PER_HOUR ?? '3', 10);

  const sessions = new SessionManager({
    dataDir,
    ttlMs: ttlMin * 60_000,
    maxSessions,
    createsPerIpPerHour,
  });
  // Reports outlive the sessions that produced them: the WhatsApp data is
  // deleted at the TTL, the computed report is kept.
  const reports = new ReportStore(path.join(dataDir, 'reports.db'));
  const currency = process.env.MAIL_CURRENCY ?? 'AED';
  const mailer = createMailer({
    host: process.env.SMTP_HOST,
    port: process.env.SMTP_PORT ? parseInt(process.env.SMTP_PORT, 10) : undefined,
    secure: process.env.SMTP_SECURE !== 'false',
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    from: process.env.MAIL_FROM ?? 'reports@heyanaya.ai',
    replyTo: process.env.MAIL_REPLY_TO,
    currency,
  });
  void mailer.verify().then((ok) => {
    if (!ok) console.error('[app] SMTP is not usable — unlocks will record delivery failures.');
  });

  startServer(PORT, {
    mode: 'serve',
    sessions,
    reports,
    mailer,
    reportBaseUrl: process.env.REPORT_BASE_URL ?? `http://localhost:${PORT}`,
    leadsEndpoint: process.env.LEADS_ENDPOINT ?? LEADS_ENDPOINT,
    currency,
  });
  console.log(
    `[app] Serve mode — sessions under ${dataDir}, TTL ${ttlMin}min, ` +
      `max ${maxSessions} concurrent, ${createsPerIpPerHour} creations/IP/hour.`
  );

  const shutdown = async (signal: string) => {
    console.log(`[app] ${signal} — unlinking and purging all sessions...`);
    await sessions.shutdown();
    reports.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
} else {
  const offlineMode = rawArg === 'offline' || rawArg === '--offline';
  let pairingPhoneNumber: string | undefined;
  if (rawArg && !offlineMode) {
    const digits = rawArg.replace(/[^\d]/g, '');
    if (digits.length < 8 || digits.length > 15) {
      console.error(
        `[app] Invalid argument: "${rawArg}". Expected "serve", "offline", or digits with country code, e.g. 919876543210.`
      );
      process.exit(1);
    }
    pairingPhoneNumber = digits;
    console.log(`[app] Pairing-code mode enabled for +${digits}.`);
  }

  // Offline mode can point at an explicit DB: `npm run dev -- offline /path/db.sqlite`
  const dbPath =
    offlineMode && process.argv[3]?.trim() ? process.argv[3].trim() : './whatsapp.db';
  const store = new Store(dbPath);
  console.log(`[app] SQLite store initialized (${dbPath}, WAL mode).`);

  const conn = offlineMode
    ? null
    : createWaConnection({ store, authDir: './auth_state', pairingPhoneNumber });

  startServer(PORT, { mode: 'local', store, conn });

  if (offlineMode) {
    console.log('[app] Offline mode — serving local history only, not connecting to WhatsApp.');
  } else {
    console.log(
      pairingPhoneNumber
        ? '[app] Waiting for WhatsApp connection — enter the pairing code when it appears.'
        : '[app] Waiting for WhatsApp connection — scan the QR code when it appears.'
    );
  }
}
