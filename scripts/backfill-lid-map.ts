// One-time backfill: load LID↔PN mappings Baileys stored in ./auth_state
// into the lid_map table, then fill messages.sender_pn for existing rows.
// Run: npx tsx scripts/backfill-lid-map.ts
import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../src/store.js';

const AUTH_DIR = './auth_state';

const pairs: Array<{ lid: string; pn: string }> = [];
for (const file of fs.readdirSync(AUTH_DIR)) {
  // lid-mapping-<LID>_reverse.json contains the PN as a JSON string
  const match = file.match(/^lid-mapping-(\d+)_reverse\.json$/);
  if (!match) continue;
  const pn = JSON.parse(fs.readFileSync(path.join(AUTH_DIR, file), 'utf8'));
  if (typeof pn === 'string' && /^\d+$/.test(pn)) {
    pairs.push({ lid: match[1], pn });
  }
}

const store = new Store('./whatsapp.db');
const inserted = store.upsertLidMappingsBulk(pairs);
console.log(`[backfill] Loaded ${inserted} LID→PN mappings from ${AUTH_DIR}.`);

const { fromPnJid, fromLidMap } = store.backfillSenderPn();
console.log(`[backfill] sender_pn filled: ${fromPnJid} from PN jids, ${fromLidMap} via lid_map.`);
