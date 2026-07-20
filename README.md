# WhatsApp History Reader — Clinic Lead Auditor

Read-only tool: pair with a clinic's WhatsApp number, sync chat history into a local SQLite file, browse it, and run lead-conversion audits on it. It never sends a message.

Two ways to run it: **local mode** (your own machine, one number — below) and **serve mode** (the public free tool — see [Deploy the free tool](#deploy-the-free-tool)).

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

## Deploy the free tool

Serve mode turns this into a public tool: a visiting clinic scans a QR on `/` (or falls back to a pairing code), syncs, and lands on their audit at `/audit.html?sid=…`.

**Single-active-session policy:** the moment a new WhatsApp links, every other session — linked or still pairing — is unlinked and purged. Only one clinic is ever connected at a time; `MAX_SESSIONS` only caps how many visitors can be mid-pairing simultaneously.

```bash
docker build -t wa-lead-audit .
docker run -d -p 3000:3000 --name wa-lead-audit wa-lead-audit
# or without docker:
npm ci && npm run build && node dist/index.js serve
```

Environment variables (defaults in parentheses):

- `PORT` (3000)
- `DATA_DIR` (`./data` / `/data` in Docker) — per-session SQLite + auth dirs live here
- `SESSION_TTL_MIN` (120) — after this, the session's device is **logged out of WhatsApp and all its data is deleted**
- `MAX_SESSIONS` (10) — concurrent paired sessions; each one is a linked device connecting from your server's IP, keep this conservative
- `CREATES_PER_IP_PER_HOUR` (3) — session-creation rate limit

How it stays safe(ish):

- Every session gets an unguessable token; all data routes require it — there is no listing or cross-session path.
- Sessions are ephemeral: TTL reaper (and SIGTERM shutdown, and boot) unlink the device and `rm -rf` the session dir. A "delete my data now" button does the same on demand.
- Read-only Baileys usage — the tool never sends a WhatsApp message.

Put it behind an HTTPS reverse proxy (Caddy/nginx) on the subdomain; the rate limiter reads `X-Forwarded-For`, so forward it.

## Gotchas

- **Full history syncs only on a fresh pairing.** The `shouldSyncHistoryMessage: () => true` override is in place, but WhatsApp won't re-send history chunks it already delivered to a device — data synced before the override (e.g. the local `whatsapp.db` from before 2026-07-19) stays partial until you re-pair.
- The "Hide saved contacts" filter keys off address-book names, which are only captured on syncs after 2026-07-18. Older contact rows all count as unsaved.
- `whatsapp.db` (patient chats) and `auth_state/` (session keys) are gitignored — keep it that way.
- Local mode has no auth on the HTTP server — run it locally only. Serve mode is session-token scoped and safe to expose behind HTTPS.
