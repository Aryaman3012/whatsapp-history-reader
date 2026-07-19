# WhatsApp History Reader — Clinic Lead Auditor

Read-only WhatsApp chat history reader for auditing clinic leads: pair with the clinic's WhatsApp number, sync chat history into SQLite, then browse and search it offline. Never sends messages.

**Stack:** Baileys 7 (rc) · better-sqlite3 · Express · single-page UI. Server runs on port 3000.

## Run

```bash
npm install

npm run dev -- offline        # serve the local DB only — no WhatsApp connection
npm run dev -- 919876543210   # pair via code (digits, country code first) and sync
npm run dev                   # pair via QR (open /qr) and sync
```

UI at http://localhost:3000. Pairing codes expire in ~2 minutes and are only issued once per process start — restart to get a fresh one (`GET /api/pairing-code`).

## What the auditor shows

- **Personal chats only** — groups are stored but excluded from the list, search, and stats.
- **Sender phone numbers** — WhatsApp increasingly hides numbers behind `@lid` aliases; the app resolves them via Baileys' alt-key fields, contact records, and a persisted `lid_map`, so every lead shows a real number.
- **Hide saved contacts** toggle — most clinics don't save patient numbers, so unsaved senders ≈ leads. Off by default: clinics that do save patients aren't filtered out. "Saved" means an address-book name (`saved_name`), not a push name.
- **Deleted-message markers** — revoked messages are kept as `deleted` rows (an audit signal), while protocol noise and system events are dropped.
- **Edited messages** — WhatsApp `MESSAGE_EDIT` wrappers are unwrapped; the edited text is applied to the original message, or kept standalone if the original isn't stored.

## API

| Route | Purpose |
|---|---|
| `/api/chats` | Chat list with `display_name`, `chat_pn`, `is_saved` |
| `/api/chats/:jid/messages` | Messages (paged), incl. `sender_pn` |
| `/api/search?q=` | Full-text-ish search across personal chats |
| `/api/stats` | Counts and date range (personal chats only) |
| `/api/qr`, `/api/pairing-code` | Connection status, pairing |

## Scripts

```bash
npx tsx scripts/backfill-lid-map.ts   # import LID→PN mappings from ./auth_state into lid_map, fill messages.sender_pn
npx tsx scripts/cleanup-noise.ts      # one-time purge of protocol/stub rows already in the DB
npx tsx scripts/logout.ts             # connect once, de-register the linked device, delete ./auth_state
```

Run the logout script (or unlink from the phone) when a sync session is done — don't leave an unofficial client linked long-term.

## Data (`./whatsapp.db`)

- `messages` — id, chat_jid, sender_jid, **sender_pn**, sender_name, text, type, timestamp, raw_json
- `chats` — id, name, timestamps; names for individual chats resolve through contacts at query time
- `contacts` — id, **saved_name** (address book) vs **push_name**, lid, pn
- `lid_map` — LID digits → phone digits, fed by contact records, message keys, and the backfill script

## Known gaps

- **Full history isn't synced yet.** Baileys' default `shouldSyncHistoryMessage` skips `FULL` sync chunks even with `syncFullHistory: true` — only the recent bootstrap is stored. Fix: pass `shouldSyncHistoryMessage: () => true` to `makeWASocket` in `src/connection.ts`, then pair fresh (WhatsApp won't re-send chunks it already delivered).
- **`is_saved` is only accurate for data synced after the saved/push name split** (2026-07-18). Earlier contact rows conflated both names; a re-sync corrects them.
- Prototype quality throughout (see `SPIKE` markers): no auth on the HTTP server, no tests — run it locally only.
