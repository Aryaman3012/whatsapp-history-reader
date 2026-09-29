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

### Conversion rate (LLM-assisted)

WhatsApp has no "booked" field, so conversion is read out of the conversation text by an LLM.

```bash
npx tsx scripts/conversion/extract-transcripts.ts <db> <work-dir> 300 20   # sample + batch
# classify each batches/batch-NN.json with an LLM agent -> verdicts/verdict-NN.json
npx tsx scripts/conversion/aggregate.ts <work-dir> <population>            # rate + cuts
```

Chats are classified into a 7-state funnel (not_patient, existing_patient, enquiry_ignored,
enquiry_no_intent, quoted_then_silent, booking_attempted, booked). Conversion rate =
booked / genuine new-patient enquiries, with a Wilson confidence interval.

Two limits to remember: transcripts don't mark which clinic messages are templates, so the
LLM over-credits auto-greetings as real replies (trust the code's `neverReplied` fact over the
LLM's `enquiry_ignored` state); and bookings made by phone or walk-in never appear in WhatsApp,
so the rate is a floor, not the clinic's true conversion.

## Deploy the free tool

Serve mode turns this into a public tool: a visiting clinic scans a QR on `/` (or falls back to a pairing code), syncs, fills in the unlock form, and receives its report **by email**. The report is never shown in the browser at unlock time, and the live `/api/audit` route is not mounted in serve mode — the only way to read a report is the emailed link.

**Sessions run concurrently.** Clinics arriving minutes apart each get their own session, and a new pairing never disturbs one already syncing. `MAX_SESSIONS` is the real cap: past it, new visitors are told the tool is busy rather than anyone being evicted.

On a VPS, `systemd/whatsapp-audit.service` is the unit `deploy.sh` restarts: copy it to
`/etc/systemd/system/`, put the secrets in `/etc/whatsapp-audit.env` (root-owned, 600), and
create `/var/lib/whatsapp-audit` owned by the service user. `nginx-whatsapp-audit.conf.example`
in the clinica-landing repo is the matching proxy config.

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
- `MAX_SESSIONS` (3) — concurrent sessions; each one is a linked device connecting from your server's IP, so raise it only with evidence
- `CREATES_PER_IP_PER_HOUR` (3) — session-creation rate limit
- `PAIRING_DEADLINE_MIN` (10) — an unpaired session loses its slot after this
- `UNPAIRED_GRACE_MIN` (5) — a paired session may be disconnected this long before it loses its slot
- `BASE_PATH` (empty) — mount the whole tool under a path, e.g. `/whatsapp-audit` behind nginx
- `REPORT_BASE_URL` (`http://localhost:$PORT`) — public origin **plus base path**, e.g. `https://heyanaya.ai/whatsapp-audit`. This is what goes in the emailed report link, so a wrong value emails dead links.
- `LEADS_ENDPOINT` (`https://leads.cashflohero.ai/v1/leads`) — where unlocks are captured as leads

Mail (the report is delivered by email and nowhere else, so none of this is optional in production):

- `SMTP_HOST` / `SMTP_PORT` (465) / `SMTP_SECURE` (true) — `smtp.gmail.com` for Google Workspace
- `SMTP_USER` / `SMTP_PASS` — the Workspace account and a **16-character app password**. App passwords require 2-Step Verification on that account. This is a secret: keep it in the service env file, never in the repo.
- `MAIL_FROM` (`reports@heyanaya.ai`) — must be the Workspace account itself or one of its "send mail as" aliases, or Gmail rewrites the header and DMARC alignment breaks
- `MAIL_REPLY_TO` — a real inbox, so a clinic replying to its report reaches a person
- `MAIL_CURRENCY` (`AED`) — currency shown in the email's revenue figure

With no `SMTP_HOST` set the mailer logs each message instead of sending it, which is how the unlock flow is exercisable locally.

## Keeping it up

`GET /health` (so `https://heyanaya.ai/whatsapp-audit/health` in production) is the
liveness check. It answers without touching a session or the store:

```json
{"ok":true,"mode":"serve","uptimeSeconds":8421,"mail":"ok","sessions":{"active":1,"max":3,"paired":1},"degraded":[]}
```

It returns **503 when SMTP is unusable**, not just when the process is dying. A serve
process with dead mail still accepts unlocks and still tells each clinic the report was
sent — that is the outage worth paging on, and a plain "is the port open" check misses it.
SMTP is re-verified every five minutes, so a password revoked at noon shows up by 12:05
rather than at the next restart. `mail: "unverified"` is the startup race and stays 200.

It also returns **503 when every slot is held by a session that never paired**
(`degraded: ["capacity"]`). That is the other outage that looks healthy: the process is up,
mail works, and every clinic arriving is told the tool is busy.

Point an external uptime check (healthchecks.io, UptimeRobot, whatever you already use) at
that URL every few minutes and send the alert to the same Slack channel as the leads.
Without it the failure is silent: the pitch page keeps loading, ads keep spending, and the
only symptom is that leads stop arriving.

The systemd unit restarts on any exit (`Restart=always`) and has no start limit, so a bad
`/etc/whatsapp-audit.env` produces a retry loop rather than a unit that gives up and stays
dead. `MemoryMax=1G` keeps a session leak from taking the whole VPS down with it. Remember
`systemctl enable whatsapp-audit` — without it none of this survives a reboot.

Baileys sockets reconnect on their own with a 2s→30s backoff, except after a `loggedOut`
(401), where reconnecting is both futile and a good way to escalate a ban. `connectTimeoutMs`
is 30s so a connect that will never complete fails into that backoff instead of hanging.

A slot is only worth holding while the session is paired, so the reaper ends a session
early in three cases besides the TTL: it never paired within `PAIRING_DEADLINE_MIN`
(default 10) — an abandoned QR screen; it paired and then went quiet for longer than
`UNPAIRED_GRACE_MIN` (default 5) — a reconnect loop that will not recover; or WhatsApp
logged it out. Without these, `MAX_SESSIONS` slots fill with sessions that can never
produce a report.

Sessions are still deliberately short-lived: the 2h TTL unlinks the device and deletes its
WhatsApp data. "Always up" applies to the service, never to a clinic's connection.

## Reports

A visitor pairs and syncs first; the report is gated behind a short form (clinic, name, mobile, email)
and **delivered only by email** — it is never shown in the browser at unlock time, and the link is not
returned by the API.

At unlock the report is computed once for all three ranges and stored in `DATA_DIR/reports.db`, keyed by
the email address it was sent to. That database is **not** purged with the sessions: the WhatsApp
connection and the synced chat history are still deleted at the TTL, while the finished report is kept
and the emailed link keeps working. Each unlock is also posted to `leads-api` as
`ad_variant: clinica-whatsapp-audit`, with the report link in the lead's notes.

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
