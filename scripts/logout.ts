// One-shot: connect, de-register this linked device from the WhatsApp account
// (sock.logout()), then remove the invalidated ./auth_state credentials.
// Run: npx tsx scripts/logout.ts
import makeWASocket, { useMultiFileAuthState, DisconnectReason } from 'baileys';
import { Boom } from '@hapi/boom';
import fs from 'node:fs';

const AUTH_DIR = './auth_state';

const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
if (!state.creds.registered) {
  console.log('[logout] No registered session in ./auth_state — nothing to disconnect.');
  process.exit(0);
}

const timeout = setTimeout(() => {
  console.error('[logout] Timed out after 60s without completing logout.');
  process.exit(1);
}, 60_000);

const sock = makeWASocket({
  auth: state,
  markOnlineOnConnect: false,
  syncFullHistory: false,
});
sock.ev.on('creds.update', saveCreds);

sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
  if (connection === 'open') {
    console.log('[logout] Connected — sending logout (unlinks this device from the account)...');
    try {
      await sock.logout();
      console.log('[logout] Logged out. Device is no longer linked.');
    } catch (err) {
      console.error('[logout] logout() failed:', err);
      process.exit(1);
    }
    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    console.log('[logout] Removed ./auth_state (credentials are invalid after logout).');
    clearTimeout(timeout);
    process.exit(0);
  }
  if (connection === 'close') {
    const statusCode = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
    if (statusCode === DisconnectReason.loggedOut) {
      // Server killed the session before our logout round-trip finished — same outcome.
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
      console.log('[logout] Session reported logged out. Removed ./auth_state.');
      clearTimeout(timeout);
      process.exit(0);
    }
    console.log(`[logout] Connection closed (status ${statusCode ?? 'unknown'}) before logout completed.`);
  }
});
