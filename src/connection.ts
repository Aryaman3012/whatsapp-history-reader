// SPIKE: prototype quality — see hardening list before reuse
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  type WASocket,
  type WAMessageKey,
  type proto,
} from 'baileys';
import { Boom } from '@hapi/boom';
import qrcode from 'qrcode-terminal';
import {
  insertMessage,
  insertMessagesBulk,
  upsertChat,
  upsertContact,
  upsertLidMapping,
  getPnForLid,
  getContactName,
  applyMessageEdit,
  type MessageRow,
} from './store.js';
import { proto as WAProto } from 'baileys';

const AUTH_DIR = './auth_state';

let currentQR: string | null = null;
let currentPairingCode: string | null = null;
let isConnected = false;

const RECONNECT_DELAY_MIN_MS = 2_000;
const RECONNECT_DELAY_MAX_MS = 30_000;
let reconnectDelayMs = RECONNECT_DELAY_MIN_MS;

export function getCurrentQR(): string | null {
  return currentQR;
}

export function getCurrentPairingCode(): string | null {
  return currentPairingCode;
}

export function getConnectionStatus(): boolean {
  return isConnected;
}

function toUnixSeconds(ts: unknown): number {
  if (ts == null) return 0;
  if (typeof ts === 'number') return ts;
  if (typeof ts === 'bigint') return Number(ts);
  if (typeof ts === 'object' && typeof (ts as { toNumber?: unknown }).toNumber === 'function') {
    return (ts as { toNumber(): number }).toNumber();
  }
  return Number(ts);
}

function extractText(message: proto.IMessage | null | undefined): string | null {
  if (!message) return null;
  return (
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    message.documentMessage?.caption ||
    message.documentMessage?.fileName ||
    null
  );
}

const MEDIA_TYPES = new Set([
  'imageMessage',
  'videoMessage',
  'audioMessage',
  'documentMessage',
  'stickerMessage',
]);

function messageType(message: proto.IMessage | null | undefined): string {
  if (!message) return 'unknown';
  const keys = Object.keys(message).filter(
    (k) => k !== 'messageContextInfo' && k !== 'senderKeyDistributionMessage'
  );
  return keys[0] ?? 'unknown';
}

const PN_SUFFIX = '@s.whatsapp.net';
const LID_SUFFIX = '@lid';

function bareDigits(jid: string, suffix: string): string {
  return jid.slice(0, -suffix.length);
}

/**
 * Resolve the sender's real phone number. WhatsApp may address the sender by
 * LID; Baileys v7 then carries the PN in the `*Alt` key fields. Any LID↔PN
 * pair we see is persisted so later LID-only messages still resolve.
 */
function resolveSenderPn(
  senderJid: string | null,
  senderAltJid: string | null | undefined
): string | null {
  const jids = [senderJid, senderAltJid].filter((j): j is string => Boolean(j));
  const pnJid = jids.find((j) => j.endsWith(PN_SUFFIX));
  const lidJid = jids.find((j) => j.endsWith(LID_SUFFIX));
  const pn = pnJid ? bareDigits(pnJid, PN_SUFFIX) : null;
  if (pn && lidJid) upsertLidMapping(bareDigits(lidJid, LID_SUFFIX), pn);
  if (pn) return pn;
  return lidJid ? getPnForLid(bareDigits(lidJid, LID_SUFFIX)) : null;
}

// Stub events worth keeping: a deleted message is an audit signal in itself.
const REVOKE_STUBS = new Set<number | string>([
  WAProto.WebMessageInfo.StubType.REVOKE,
  WAProto.WebMessageInfo.StubType.ADMIN_REVOKE,
  'REVOKE',
  'ADMIN_REVOKE',
]);

function toMessageRow(msg: proto.IWebMessageInfo): MessageRow | null {
  const key = msg.key as WAMessageKey | null | undefined;
  if (!key?.id || !key.remoteJid) return null;
  // Skip protocol/status noise: keep everything else, even empty messages
  if (key.remoteJid === 'status@broadcast') return null;

  // Stub-only rows (no message payload) are system events — group membership,
  // encryption banners, etc. Keep only revokes, stored as 'deleted' markers.
  let message = msg.message;
  let type = messageType(message);
  if (!message) {
    const stub = msg.messageStubType as number | string | null | undefined;
    if (stub == null || !REVOKE_STUBS.has(stub)) return null;
    type = 'deleted';
  }

  const protocolMsg = message?.protocolMessage;
  if (protocolMsg) {
    const isEdit =
      protocolMsg.type === WAProto.Message.ProtocolMessage.Type.MESSAGE_EDIT ||
      (protocolMsg.type as unknown) === 'MESSAGE_EDIT';
    if (!isEdit) return null; // key shares, sync notifications, ephemeral settings — plumbing
    const targetId = protocolMsg.key?.id;
    const editedText = extractText(protocolMsg.editedMessage);
    if (targetId && editedText != null && applyMessageEdit(targetId, editedText)) {
      return null; // edit applied onto the original row
    }
    // Original not stored — keep the edit as a message of the edited content's type
    message = protocolMsg.editedMessage ?? message;
    type = messageType(protocolMsg.editedMessage);
  }

  const isFromMe = key.fromMe ? 1 : 0;
  const senderJid = key.participant || (isFromMe ? null : key.remoteJid);
  const senderAltJid = key.participantAlt || (isFromMe ? null : key.remoteJidAlt);
  const senderName =
    msg.pushName || (senderJid ? getContactName(senderJid) : null) || null;
  return {
    id: key.id,
    chat_jid: key.remoteJid,
    sender_jid: senderJid,
    sender_pn: isFromMe ? null : resolveSenderPn(senderJid, senderAltJid),
    sender_name: senderName,
    message_text: extractText(message),
    message_type: type,
    timestamp: toUnixSeconds(msg.messageTimestamp),
    has_media: MEDIA_TYPES.has(type) ? 1 : 0,
    media_url: null,
    is_from_me: isFromMe,
    raw_json: JSON.stringify(msg),
  };
}

function phoneFromJid(jid: string): string | null {
  const match = jid.match(/^(\d+)@s\.whatsapp\.net$/);
  return match ? `+${match[1]}` : null;
}

/**
 * Persist a Baileys contact keeping saved (address-book) and push names
 * separate — `contact.name` only exists when the linked phone has the contact
 * saved, which is what the saved-contacts filter keys off.
 */
function storeContact(contact: {
  id: string;
  lid?: string | null;
  phoneNumber?: string | null;
  name?: string | null;
  notify?: string | null;
}): void {
  const lid =
    (contact.lid?.endsWith(LID_SUFFIX) ? bareDigits(contact.lid, LID_SUFFIX) : null) ??
    (contact.id.endsWith(LID_SUFFIX) ? bareDigits(contact.id, LID_SUFFIX) : null);
  const pn =
    (contact.phoneNumber?.endsWith(PN_SUFFIX)
      ? bareDigits(contact.phoneNumber, PN_SUFFIX)
      : null) ?? (contact.id.endsWith(PN_SUFFIX) ? bareDigits(contact.id, PN_SUFFIX) : null);
  upsertContact({
    id: contact.id,
    saved_name: contact.name || null,
    push_name: contact.notify || null,
    phone: phoneFromJid(contact.id) ?? (pn ? `+${pn}` : null),
    lid,
    pn,
  });
  if (lid && pn) upsertLidMapping(lid, pn);
}

export async function startConnection(pairingPhoneNumber?: string): Promise<WASocket> {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const usePairingCode = Boolean(pairingPhoneNumber) && !state.creds.registered;
  let pairingCodeRequested = false;

  const sock = makeWASocket({
    auth: state,
    syncFullHistory: true,
    markOnlineOnConnect: false,
    printQRInTerminal: false,
    // READ-ONLY tool: no outbound messaging functions are ever called.
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      if (usePairingCode) {
        // Pairing-code mode: suppress the QR and request a code once the
        // socket is ready to pair (first qr event = socket is live).
        currentQR = null;
        if (!pairingCodeRequested) {
          pairingCodeRequested = true;
          sock
            .requestPairingCode(pairingPhoneNumber as string)
            .then((code) => {
              currentPairingCode = code;
              console.log(
                `[wa] Pairing code for ${pairingPhoneNumber}: ${code}\n` +
                  '[wa] Enter it in WhatsApp: Linked Devices → Link a Device → Link with phone number instead.'
              );
            })
            .catch((err) => {
              pairingCodeRequested = false;
              console.error('[wa] Failed to request pairing code:', err);
            });
        }
      } else {
        currentQR = qr;
        console.log('[wa] QR code generated — scan with WhatsApp (Linked Devices):');
        qrcode.generate(qr, { small: true });
      }
    }

    if (connection === 'open') {
      currentQR = null;
      currentPairingCode = null;
      isConnected = true;
      reconnectDelayMs = RECONNECT_DELAY_MIN_MS;
      console.log('[wa] Connection open — waiting for history sync...');
    }

    if (connection === 'close') {
      isConnected = false;
      const statusCode = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;
      console.log(
        `[wa] Connection closed (status ${statusCode ?? 'unknown'}). ${
          loggedOut
            ? 'Logged out — delete ./auth_state and restart to re-link.'
            : `Reconnecting in ${Math.round(reconnectDelayMs / 1000)}s...`
        }`
      );
      if (!loggedOut) {
        const delay = reconnectDelayMs;
        reconnectDelayMs = Math.min(reconnectDelayMs * 2, RECONNECT_DELAY_MAX_MS);
        setTimeout(() => {
          startConnection(pairingPhoneNumber).catch((err) =>
            console.error('[wa] Reconnect failed:', err)
          );
        }, delay);
      }
    }
  });

  sock.ev.on('messaging-history.set', ({ chats, contacts, messages, progress, syncType }) => {
    console.log(
      `[wa] History sync batch: ${chats.length} chats, ${contacts.length} contacts, ` +
        `${messages.length} messages (progress: ${progress ?? '?'}%, type: ${syncType ?? '?'})`
    );

    for (const contact of contacts) {
      if (!contact.id) continue;
      storeContact(contact);
    }

    for (const chat of chats) {
      if (!chat.id) continue;
      upsertChat({
        id: chat.id,
        name: chat.name || null,
        timestamp: toUnixSeconds(chat.conversationTimestamp),
        unread_count: chat.unreadCount ?? null,
      });
    }

    const rows = messages
      .map(toMessageRow)
      .filter((row): row is MessageRow => row !== null);
    const inserted = insertMessagesBulk(rows);
    console.log(`[wa] Stored ${inserted} new historical messages.`);
  });

  sock.ev.on('messages.upsert', ({ messages, type }) => {
    for (const msg of messages) {
      const row = toMessageRow(msg);
      if (!row) continue;
      insertMessage(row);
      // Ensure the chat exists and reflects the latest message
      upsertChat({
        id: row.chat_jid,
        last_message_text: row.message_text,
        last_message_time: row.timestamp,
        timestamp: row.timestamp,
      });
    }
    if (messages.length > 0) {
      console.log(`[wa] messages.upsert (${type}): stored ${messages.length} message(s).`);
    }
  });

  sock.ev.on('chats.upsert', (chats) => {
    for (const chat of chats) {
      if (!chat.id) continue;
      upsertChat({
        id: chat.id,
        name: chat.name || null,
        timestamp: toUnixSeconds(chat.conversationTimestamp),
        unread_count: chat.unreadCount ?? null,
      });
    }
    console.log(`[wa] chats.upsert: ${chats.length} chat(s).`);
  });

  sock.ev.on('contacts.upsert', (contacts) => {
    for (const contact of contacts) {
      if (!contact.id) continue;
      storeContact(contact);
    }
    console.log(`[wa] contacts.upsert: ${contacts.length} contact(s).`);
  });

  return sock;
}
