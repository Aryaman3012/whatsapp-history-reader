# WhatsApp History Reader — Clinic Lead Auditor

Read-only tool: pair with a clinic's WhatsApp number, sync chat history into a local SQLite file, browse it, and run lead-conversion audits on it. It never sends a message.

## Run it

Requires Node 20+.

```bash
npm install
npm run dev -- 919876543210     # your clinic's number: digits only, country code first
```

Then pair the phone:

1. Get the pairing code: `curl localhost:3000/api/pairing-code` (also printed in the terminal).
2. On the clinic phone: **WhatsApp → Settings → Linked Devices → Link a Device → Link with phone number instead** → enter the code.
3. Codes expire in ~2 minutes and are issued once per process — if it says "device cannot connect", restart the server for a fresh code.
4. Wait for the terminal to show `History sync batch` lines. A few thousand messages take under a minute.

Open **http://localhost:3000** — chat list, search, "Hide saved contacts" filter.

### When you're done syncing

```bash
npx tsx scripts/logout.ts       # unlinks the device from the WhatsApp account, deletes ./auth_state
```

Do this rather than leaving an unofficial client linked — reduces ban risk. The synced data stays in `whatsapp.db`.

### Browse later, without WhatsApp

```bash
npm run dev -- offline          # serves whatever is already in whatsapp.db, no connection
```

## Run the audit

With the server up (either mode), open **http://localhost:3000/audit.html**.

API: `GET /api/audit` (all chats) or `/api/audit/<chatJid>` (one chat). Query params:

- `startHour`, `endHour`, `daysOfWeek=1,2,3,4,5` — clinic business hours (defaults built in)
- `conversionRate`, `avgTicketValue` — for revenue-at-risk estimates
- `range=30d|90d|1y` — analysis window

Example: `curl 'localhost:3000/api/audit?startHour=9&endHour=19&avgTicketValue=2000&range=90d'`

## Tests / typecheck

```bash
npx tsx --test tests/auditor.test.ts    # plain `node --test` can't resolve the .js imports
npx tsc --noEmit
```

## One-time maintenance scripts

```bash
npx tsx scripts/backfill-lid-map.ts   # fill messages.sender_pn from auth_state LID↔phone mappings
npx tsx scripts/cleanup-noise.ts      # purge protocol/system rows synced before the ingest filters existed
```

Both already ran on the current DB; only needed again after a fresh sync from scratch.

## Gotchas

- **Full history doesn't sync yet.** Baileys skips `FULL` history chunks by default even with `syncFullHistory: true` — you only get recent messages. Fix before the next pairing: pass `shouldSyncHistoryMessage: () => true` to `makeWASocket` in `src/connection.ts`.
- The "Hide saved contacts" filter keys off address-book names, which are only captured on syncs after 2026-07-18. Older contact rows all count as unsaved.
- `whatsapp.db` (patient chats) and `auth_state/` (session keys) are gitignored — keep it that way.
- Prototype: no auth on the HTTP server. Run locally only.
