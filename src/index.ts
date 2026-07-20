// Entry point. Modes:
//   npm run dev -- offline         local: serve ./whatsapp.db only, no WhatsApp
//   npm run dev -- 919876543210    local: pair this number via code, sync into ./whatsapp.db
//   npm run dev                    local: pair via QR, sync into ./whatsapp.db
//   npm run dev -- serve           public free tool: multi-tenant ephemeral sessions
import { Store } from './store.js';
import { createWaConnection } from './connection.js';
import { SessionManager } from './sessions.js';
import { startServer } from './server.js';

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
  startServer(PORT, { mode: 'serve', sessions });
  console.log(
    `[app] Serve mode — sessions under ${dataDir}, TTL ${ttlMin}min, ` +
      `max ${maxSessions} concurrent, ${createsPerIpPerHour} creations/IP/hour.`
  );

  const shutdown = async (signal: string) => {
    console.log(`[app] ${signal} — unlinking and purging all sessions...`);
    await sessions.shutdown();
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

  const store = new Store('./whatsapp.db');
  console.log('[app] SQLite store initialized (./whatsapp.db, WAL mode).');

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
