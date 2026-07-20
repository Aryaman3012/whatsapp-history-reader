// Per-session SQLite store. Each Store instance owns one database file —
// multi-tenant serve mode creates one per paired session; local mode uses one.
import Database from 'better-sqlite3';

export interface ContactRow {
  id: string;
  name: string | null;
  phone: string | null;
  saved_name: string | null;
  push_name: string | null;
  lid: string | null;
  pn: string | null;
  created_at: string;
}

export interface ChatRow {
  id: string;
  name: string | null;
  timestamp: number | null;
  unread_count: number | null;
  last_message_text: string | null;
  last_message_time: number | null;
  /** Bare-digit phone number of the chat peer (resolved via lid_map for @lid chats) */
  chat_pn: string | null;
  /** Best available human name: group/chat name → saved contact name → push name */
  display_name: string | null;
  /** 1 if the peer has a saved address-book name (accurate only for data synced after the saved/push split) */
  is_saved: number;
}

export interface MessageRow {
  id: string;
  chat_jid: string;
  sender_jid: string | null;
  sender_pn: string | null;
  sender_name: string | null;
  message_text: string | null;
  message_type: string;
  timestamp: number;
  has_media: number;
  media_url: string | null;
  is_from_me: number;
  raw_json: string | null;
}

export interface Stats {
  totalChats: number;
  totalMessages: number;
  totalContacts: number;
  earliestMessage: number | null;
  latestMessage: number | null;
}

const PERSONAL_CHAT = `(id LIKE '%@s.whatsapp.net' OR id LIKE '%@lid')`;
const PERSONAL_MSG = `(chat_jid LIKE '%@s.whatsapp.net' OR chat_jid LIKE '%@lid')`;

export class Store {
  private db: Database.Database;

  constructor(dbPath = './whatsapp.db') {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS contacts (
        id TEXT PRIMARY KEY,
        name TEXT,
        phone TEXT,
        created_at TEXT
      );

      CREATE TABLE IF NOT EXISTS chats (
        id TEXT PRIMARY KEY,
        name TEXT,
        timestamp INTEGER,
        unread_count INTEGER,
        last_message_text TEXT,
        last_message_time INTEGER
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        chat_jid TEXT,
        sender_jid TEXT,
        sender_name TEXT,
        message_text TEXT,
        message_type TEXT,
        timestamp INTEGER,
        has_media INTEGER,
        media_url TEXT,
        is_from_me INTEGER,
        raw_json TEXT
      );

      CREATE TABLE IF NOT EXISTS lid_map (
        lid TEXT PRIMARY KEY,
        pn TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_messages_chat_jid ON messages(chat_jid);
      CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
      CREATE INDEX IF NOT EXISTS idx_chats_timestamp ON chats(timestamp);
    `);

    this.addColumnIfMissing('messages', 'sender_pn', 'TEXT');
    this.addColumnIfMissing('contacts', 'saved_name', 'TEXT');
    this.addColumnIfMissing('contacts', 'push_name', 'TEXT');
    this.addColumnIfMissing('contacts', 'lid', 'TEXT');
    this.addColumnIfMissing('contacts', 'pn', 'TEXT');
  }

  private addColumnIfMissing(table: string, column: string, type: string): void {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!cols.some((c) => c.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
  }

  close(): void {
    this.db.close();
  }

  upsertContact(contact: {
    id: string;
    name?: string | null;
    phone?: string | null;
    saved_name?: string | null;
    push_name?: string | null;
    lid?: string | null;
    pn?: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO contacts (id, name, phone, saved_name, push_name, lid, pn, created_at)
         VALUES (@id, @name, @phone, @saved_name, @push_name, @lid, @pn, datetime('now'))
         ON CONFLICT(id) DO UPDATE SET
           name = COALESCE(excluded.name, contacts.name),
           phone = COALESCE(excluded.phone, contacts.phone),
           saved_name = COALESCE(excluded.saved_name, contacts.saved_name),
           push_name = COALESCE(excluded.push_name, contacts.push_name),
           lid = COALESCE(excluded.lid, contacts.lid),
           pn = COALESCE(excluded.pn, contacts.pn)`
      )
      .run({
        id: contact.id,
        name: contact.name ?? contact.saved_name ?? contact.push_name ?? null,
        phone: contact.phone ?? null,
        saved_name: contact.saved_name ?? null,
        push_name: contact.push_name ?? null,
        lid: contact.lid ?? null,
        pn: contact.pn ?? null,
      });
  }

  upsertLidMapping(lid: string, pn: string): void {
    this.db.prepare(`INSERT OR REPLACE INTO lid_map (lid, pn) VALUES (?, ?)`).run(lid, pn);
  }

  upsertLidMappingsBulk(pairs: Array<{ lid: string; pn: string }>): number {
    const stmt = this.db.prepare(`INSERT OR REPLACE INTO lid_map (lid, pn) VALUES (@lid, @pn)`);
    const run = this.db.transaction((rows: Array<{ lid: string; pn: string }>) => {
      for (const row of rows) stmt.run(row);
      return rows.length;
    });
    return run(pairs);
  }

  getPnForLid(lid: string): string | null {
    const row = this.db.prepare(`SELECT pn FROM lid_map WHERE lid = ?`).get(lid) as
      | { pn: string }
      | undefined;
    return row?.pn ?? null;
  }

  /** Apply a WhatsApp MESSAGE_EDIT to the original message row. Returns false if the original isn't stored. */
  applyMessageEdit(id: string, newText: string): boolean {
    return this.db.prepare(`UPDATE messages SET message_text = ? WHERE id = ?`).run(newText, id).changes > 0;
  }

  /** Fill messages.sender_pn from sender_jid (direct PN jids) and lid_map (LID jids). */
  backfillSenderPn(): { fromPnJid: number; fromLidMap: number } {
    const fromPnJid = this.db
      .prepare(
        `UPDATE messages SET sender_pn = replace(sender_jid, '@s.whatsapp.net', '')
         WHERE sender_pn IS NULL AND sender_jid LIKE '%@s.whatsapp.net'`
      )
      .run().changes;
    const fromLidMap = this.db
      .prepare(
        `UPDATE messages SET sender_pn =
           (SELECT pn FROM lid_map WHERE lid = replace(messages.sender_jid, '@lid', ''))
         WHERE sender_pn IS NULL AND sender_jid LIKE '%@lid'
           AND replace(messages.sender_jid, '@lid', '') IN (SELECT lid FROM lid_map)`
      )
      .run().changes;
    return { fromPnJid, fromLidMap };
  }

  upsertChat(chat: {
    id: string;
    name?: string | null;
    timestamp?: number | null;
    unread_count?: number | null;
    last_message_text?: string | null;
    last_message_time?: number | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO chats (id, name, timestamp, unread_count, last_message_text, last_message_time)
         VALUES (@id, @name, @timestamp, @unread_count, @last_message_text, @last_message_time)
         ON CONFLICT(id) DO UPDATE SET
           name = COALESCE(excluded.name, chats.name),
           timestamp = COALESCE(excluded.timestamp, chats.timestamp),
           unread_count = COALESCE(excluded.unread_count, chats.unread_count),
           last_message_text = COALESCE(excluded.last_message_text, chats.last_message_text),
           last_message_time = COALESCE(excluded.last_message_time, chats.last_message_time)`
      )
      .run({
        id: chat.id,
        name: chat.name ?? null,
        timestamp: chat.timestamp ?? null,
        unread_count: chat.unread_count ?? null,
        last_message_text: chat.last_message_text ?? null,
        last_message_time: chat.last_message_time ?? null,
      });
  }

  insertMessage(msg: MessageRow): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO messages
           (id, chat_jid, sender_jid, sender_pn, sender_name, message_text, message_type,
            timestamp, has_media, media_url, is_from_me, raw_json)
         VALUES (@id, @chat_jid, @sender_jid, @sender_pn, @sender_name, @message_text, @message_type,
            @timestamp, @has_media, @media_url, @is_from_me, @raw_json)`
      )
      .run(msg);
  }

  insertMessagesBulk(msgs: MessageRow[]): number {
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO messages
         (id, chat_jid, sender_jid, sender_pn, sender_name, message_text, message_type,
          timestamp, has_media, media_url, is_from_me, raw_json)
       VALUES (@id, @chat_jid, @sender_jid, @sender_pn, @sender_name, @message_text, @message_type,
          @timestamp, @has_media, @media_url, @is_from_me, @raw_json)`
    );
    const insertAll = this.db.transaction((rows: MessageRow[]) => {
      let count = 0;
      for (const row of rows) {
        const result = stmt.run(row);
        count += result.changes;
      }
      return count;
    });
    return insertAll(msgs);
  }

  getChats(): ChatRow[] {
    const rows = this.db
      .prepare(
        `SELECT c.*,
                (SELECT m.message_text FROM messages m
                  WHERE m.chat_jid = c.id ORDER BY m.timestamp DESC LIMIT 1) AS last_message_text,
                COALESCE(
                  (SELECT MAX(m.timestamp) FROM messages m WHERE m.chat_jid = c.id),
                  c.last_message_time,
                  c.timestamp
                ) AS last_message_time
         FROM chats c
         WHERE c.id LIKE '%@s.whatsapp.net' OR c.id LIKE '%@lid'
         ORDER BY last_message_time DESC NULLS LAST`
      )
      .all() as ChatRow[];

    const contacts = this.db.prepare(`SELECT * FROM contacts`).all() as ContactRow[];
    const lidMap = this.db.prepare(`SELECT lid, pn FROM lid_map`).all() as { lid: string; pn: string }[];
    const pnForLid = new Map(lidMap.map((r) => [r.lid, r.pn]));
    const byJid = new Map<string, ContactRow>();
    for (const ct of contacts) {
      byJid.set(ct.id, ct);
      if (ct.lid) byJid.set(`${ct.lid}@lid`, ct);
      if (ct.pn) byJid.set(`${ct.pn}@s.whatsapp.net`, ct);
    }

    return rows.map((row) => {
      const chatPn = row.id.endsWith('@s.whatsapp.net')
        ? row.id.replace('@s.whatsapp.net', '')
        : row.id.endsWith('@lid')
          ? (pnForLid.get(row.id.replace('@lid', '')) ?? null)
          : null;
      const contact =
        byJid.get(row.id) ?? (chatPn ? byJid.get(`${chatPn}@s.whatsapp.net`) : undefined);
      const savedName = contact?.saved_name ?? null;
      return {
        ...row,
        chat_pn: chatPn,
        display_name: row.name || savedName || contact?.push_name || contact?.name || null,
        is_saved: savedName ? 1 : 0,
      };
    });
  }

  getMessages(chatJid: string, limit = 50, offset = 0, sinceTimestamp = 0): MessageRow[] {
    return this.db
      .prepare(
        `SELECT * FROM messages
         WHERE chat_jid = ? AND timestamp >= ?
         ORDER BY timestamp DESC
         LIMIT ? OFFSET ?`
      )
      .all(chatJid, sinceTimestamp, limit, offset) as MessageRow[];
  }

  searchMessages(query: string, limit = 100): MessageRow[] {
    return this.db
      .prepare(
        `SELECT * FROM messages
         WHERE message_text LIKE ?
           AND ${PERSONAL_MSG}
         ORDER BY timestamp DESC
         LIMIT ?`
      )
      .all(`%${query}%`, limit) as MessageRow[];
  }

  getContacts(): ContactRow[] {
    return this.db.prepare(`SELECT * FROM contacts ORDER BY name`).all() as ContactRow[];
  }

  getContactName(jid: string): string | null {
    const row = this.db.prepare(`SELECT name FROM contacts WHERE id = ?`).get(jid) as
      | { name: string | null }
      | undefined;
    return row?.name ?? null;
  }

  getStats(): Stats {
    const totalChats = (
      this.db.prepare(`SELECT COUNT(*) AS n FROM chats WHERE ${PERSONAL_CHAT}`).get() as { n: number }
    ).n;
    const totalMessages = (
      this.db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE ${PERSONAL_MSG}`).get() as { n: number }
    ).n;
    const totalContacts = (this.db.prepare(`SELECT COUNT(*) AS n FROM contacts`).get() as { n: number }).n;
    const range = this.db
      .prepare(`SELECT MIN(timestamp) AS earliest, MAX(timestamp) AS latest FROM messages WHERE ${PERSONAL_MSG}`)
      .get() as { earliest: number | null; latest: number | null };
    return {
      totalChats,
      totalMessages,
      totalContacts,
      earliestMessage: range.earliest,
      latestMessage: range.latest,
    };
  }
}
