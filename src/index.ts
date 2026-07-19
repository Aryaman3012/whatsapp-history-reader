// SPIKE: prototype quality — see hardening list before reuse
import { initStore } from './store.js';
import { startConnection } from './connection.js';
import { startServer } from './server.js';

console.log('[app] WhatsApp History Reader (read-only) starting...');

// Modes: `npm run dev -- offline` (serve local DB only, no WhatsApp connection)
//        `npm run dev -- 919876543210` (pairing-code mode; digits, country code first)
const rawArg = process.argv[2]?.trim();
const offlineMode = rawArg === 'offline' || rawArg === '--offline';
let pairingPhoneNumber: string | undefined;
if (rawArg && !offlineMode) {
  const digits = rawArg.replace(/[^\d]/g, '');
  if (digits.length < 8 || digits.length > 15) {
    console.error(`[app] Invalid argument: "${rawArg}". Expected "offline" or digits with country code, e.g. 919876543210.`);
    process.exit(1);
  }
  pairingPhoneNumber = digits;
  console.log(`[app] Pairing-code mode enabled for +${digits}.`);
}

initStore('./whatsapp.db');
console.log('[app] SQLite store initialized (./whatsapp.db, WAL mode).');

startServer(3000, { offline: offlineMode });

if (offlineMode) {
  console.log('[app] Offline mode — serving local history only, not connecting to WhatsApp.');
} else {
  startConnection(pairingPhoneNumber).catch((err) => {
    console.error('[app] WhatsApp connection failed:', err);
  });
  console.log(
    pairingPhoneNumber
      ? '[app] Waiting for WhatsApp connection — enter the pairing code when it appears.'
      : '[app] Waiting for WhatsApp connection — scan the QR code when it appears.'
  );
}
