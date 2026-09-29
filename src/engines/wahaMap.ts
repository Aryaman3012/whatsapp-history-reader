// Pure translation between WAHA's REST shapes and the Store's rows. Kept
// separate from the HTTP client so the mapping can be tested without a server.
import type { MessageRow } from '../store.js';

export interface WahaMessage {
  id: string;
  timestamp: number;
  from: string;
  to?: string;
  fromMe: boolean;
  body?: string | null;
  hasMedia?: boolean;
  _data?: { type?: string } | null;
}

export interface WahaChat {
  id: string;
  name?: string | null;
  timestamp?: number | null;
  conversationTimestamp?: number | null;
}

/**
 * WAHA's browser engine addresses contacts as `@c.us`; the audit only treats a
 * chat as a lead when its jid ends in `@s.whatsapp.net` or `@lid` (PERSONAL_CHAT
 * in store.ts). Without this rewrite every WAHA-sourced audit reports zero leads
 * while looking like it synced perfectly.
 */
export function normalizeJid(jid: string): string {
  return jid.endsWith('@c.us') ? `${jid.slice(0, -'@c.us'.length)}@s.whatsapp.net` : jid;
}

/** Engines disagree on units; the auditor works in seconds throughout. */
function toSeconds(timestamp: number): number {
  return timestamp > 1e11 ? Math.floor(timestamp / 1000) : timestamp;
}

function bareNumber(jid: string): string | null {
  const user = jid.split('@')[0] ?? '';
  return /^\d{6,}$/.test(user) ? user : null;
}

export function wahaMessageToRow(chatId: string, msg: WahaMessage): MessageRow {
  const chatJid = normalizeJid(chatId);
  const senderJid = normalizeJid(msg.from);
  const text = msg.body?.trim() ? msg.body : null;
  return {
    id: msg.id,
    chat_jid: chatJid,
    sender_jid: senderJid,
    sender_pn: bareNumber(senderJid),
    sender_name: null,
    message_text: text,
    message_type: msg._data?.type ?? (msg.hasMedia ? 'media' : 'text'),
    timestamp: toSeconds(msg.timestamp),
    has_media: msg.hasMedia ? 1 : 0,
    media_url: null,
    is_from_me: msg.fromMe ? 1 : 0,
    raw_json: JSON.stringify(msg),
  };
}

export function wahaChatToUpsert(chat: WahaChat): {
  id: string;
  name: string | null;
  timestamp: number | null;
} {
  const ts = chat.timestamp ?? chat.conversationTimestamp ?? null;
  return {
    id: normalizeJid(chat.id),
    name: chat.name ?? null,
    timestamp: ts === null ? null : toSeconds(ts),
  };
}
