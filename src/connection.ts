// Session-scoped Baileys connection. Each createWaConnection() owns one linked
// device: its own auth dir, its own Store, its own status/pairing state.
// READ-ONLY: no outbound messaging functions are ever called.
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  proto as WAProto,
  type WASocket,
  type WAMessageKey,
  type proto,
} from 'baileys';
import { Boom } from '@hapi/boom';
import qrcode from 'qrcode-terminal';
import fs from 'node:fs';
import path from 'node:path';
import { Store, type MessageRow } from './store.js';

export type WaStatus = 'connecting' | 'connected' | 'logged_out' | 'closed';

export interface WaConnection {
  getQR(): string | null;
  getPairingCode(): string | null;
  isConnected(): boolean;
  getStatus(): WaStatus;
  /** 0-100 best-effort history sync progress; null before the first batch. */
  getSyncProgress(): number | null;
  /** De-register this linked device from the WhatsApp account. */
  logout(): Promise<void>;
  /** Tear down the socket without logging out (keeps the device linked). */
  close(): void;
}

const RECONNECT_DELAY_MIN_MS = 2_000;
const RECONNECT_DELAY_MAX_MS = 30_000;

const PN_SUFFIX = '@s.whatsapp.net';
const LID_SUFFIX = '@lid';

function bareDigits(jid: string, suffix: string): string {
  return jid.slice(0, -suffix.length);
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

function phoneFromJid(jid: string): string | null {
  const match = jid.match(/^(\d+)@s\.whatsapp\.net$/);
  return match ? `+${match[1]}` : null;
}

// Stub events worth keeping: a deleted message is an audit signal in itself.
const REVOKE_STUBS = new Set<number | string>([
  WAProto.WebMessageInfo.StubType.REVOKE,
  WAProto.WebMessageInfo.StubType.ADMIN_REVOKE,
  'REVOKE',
  'ADMIN_REVOKE',
]);

export function createWaConnection(opts: {
  store: Store;
  authDir: string;
  pairingPhoneNumber?: string;
  /** Log line prefix, e.g. a short session id. */
  label?: string;
  /** Fired once each time the socket reaches the connected state. */
  onConnected?: () => void;
}): WaConnection {
  const { store, authDir, pairingPhoneNumber } = opts;
  const tag = opts.label ? `[wa:${opts.label}]` : '[wa]';

  let currentQR: string | null = null;
  let currentPairingCode: string | null = null;
  let connected = false;
  let status: WaStatus = 'connecting';
  let syncProgress: number | null = null;
  let reconnectDelayMs = RECONNECT_DELAY_MIN_MS;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let sock: WASocket | null = null;
  let closed = false;

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
    if (pn && lidJid) store.upsertLidMapping(bareDigits(lidJid, LID_SUFFIX), pn);
    if (pn) return pn;
    return lidJid ? store.getPnForLid(bareDigits(lidJid, LID_SUFFIX)) : null;
  }

  function toMessageRow(msg: proto.IWebMessageInfo): MessageRow | null {
    const key = msg.key as WAMessageKey | null | undefined;
    if (!key?.id || !key.remoteJid) return null;
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
      if (targetId && editedText != null && store.applyMessageEdit(targetId, editedText)) {
        return null; // edit applied onto the original row
      }
      message = protocolMsg.editedMessage ?? message;
      type = messageType(protocolMsg.editedMessage);
    }

    const isFromMe = key.fromMe ? 1 : 0;
    const senderJid = key.participant || (isFromMe ? null : key.remoteJid);
    const senderAltJid = key.participantAlt || (isFromMe ? null : key.remoteJidAlt);
    const senderName =
      msg.pushName || (senderJid ? store.getContactName(senderJid) : null) || null;
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
    store.upsertContact({
      id: contact.id,
      saved_name: contact.name || null,
      push_name: contact.notify || null,
      phone: phoneFromJid(contact.id) ?? (pn ? `+${pn}` : null),
      lid,
      pn,
    });
    if (lid && pn) store.upsertLidMapping(lid, pn);
  }

  /**
   * Baileys stores LID↔phone mappings from history sync in the auth dir
   * (lid-mapping-<lid>_reverse.json → phone digits), not in any event we can
   * subscribe to — import them so @lid chats and senders resolve to numbers.
   */
  function importLidMappings(): void {
    let pairs: Array<{ lid: string; pn: string }> = [];
    try {
      for (const file of fs.readdirSync(authDir)) {
        const match = file.match(/^lid-mapping-(\d+)_reverse\.json$/);
        if (!match) continue;
        try {
          const pn = JSON.parse(fs.readFileSync(path.join(authDir, file), 'utf8'));
          if (typeof pn === 'string' && /^\d+$/.test(pn)) pairs.push({ lid: match[1], pn });
        } catch {
          /* unreadable mapping file — skip */
        }
      }
    } catch {
      return; // auth dir gone (session being torn down)
    }
    if (pairs.length === 0) return;
    store.upsertLidMappingsBulk(pairs);
    const { fromPnJid, fromLidMap } = store.backfillSenderPn();
    console.log(
      `${tag} Imported ${pairs.length} LID→PN mappings; sender_pn backfilled ` +
        `${fromPnJid + fromLidMap} messages.`
    );
  }

  async function connect(): Promise<void> {
    if (closed) return;
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const usePairingCode = Boolean(pairingPhoneNumber) && !state.creds.registered;
    let pairingCodeRequested = false;

    const s = makeWASocket({
      auth: state,
      syncFullHistory: true,
      // Baileys' default shouldSyncHistoryMessage skips FULL history chunks even
      // with syncFullHistory: true — override so the complete history is stored.
      shouldSyncHistoryMessage: () => true,
      markOnlineOnConnect: false,
      printQRInTerminal: false,
    });
    sock = s;

    s.ev.on('creds.update', saveCreds);

    s.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        if (usePairingCode) {
          currentQR = null;
          if (!pairingCodeRequested) {
            pairingCodeRequested = true;
            s.requestPairingCode(pairingPhoneNumber as string)
              .then((code) => {
                currentPairingCode = code;
                console.log(`${tag} Pairing code for ${pairingPhoneNumber}: ${code}`);
              })
              .catch((err) => {
                pairingCodeRequested = false;
                console.error(`${tag} Failed to request pairing code:`, err);
              });
          }
        } else {
          currentQR = qr;
          if (!opts.label) {
            console.log(`${tag} QR code generated — scan with WhatsApp (Linked Devices):`);
            qrcode.generate(qr, { small: true });
          }
        }
      }

      if (connection === 'open') {
        currentQR = null;
        currentPairingCode = null;
        connected = true;
        status = 'connected';
        reconnectDelayMs = RECONNECT_DELAY_MIN_MS;
        console.log(`${tag} Connection open — waiting for history sync...`);
        // Sweep again after the sync settles — mapping files are written
        // asynchronously and the last history batch can beat them to disk.
        setTimeout(importLidMappings, 30_000);
        try {
          opts.onConnected?.();
        } catch (err) {
          console.error(`${tag} onConnected hook failed:`, err);
        }
      }

      if (connection === 'close') {
        connected = false;
        const statusCode = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut;
        if (loggedOut) status = 'logged_out';
        if (closed || loggedOut) {
          console.log(`${tag} Connection closed (status ${statusCode ?? 'unknown'}), not reconnecting.`);
          return;
        }
        console.log(
          `${tag} Connection closed (status ${statusCode ?? 'unknown'}). Reconnecting in ${Math.round(
            reconnectDelayMs / 1000
          )}s...`
        );
        const delay = reconnectDelayMs;
        reconnectDelayMs = Math.min(reconnectDelayMs * 2, RECONNECT_DELAY_MAX_MS);
        reconnectTimer = setTimeout(() => {
          connect().catch((err) => console.error(`${tag} Reconnect failed:`, err));
        }, delay);
      }
    });

    s.ev.on('messaging-history.set', ({ chats, contacts, messages, progress, syncType }) => {
      if (typeof progress === 'number') syncProgress = progress;
      console.log(
        `${tag} History sync batch: ${chats.length} chats, ${contacts.length} contacts, ` +
          `${messages.length} messages (progress: ${progress ?? '?'}%, type: ${syncType ?? '?'})`
      );

      for (const contact of contacts) {
        if (!contact.id) continue;
        storeContact(contact);
      }

      for (const chat of chats) {
        if (!chat.id) continue;
        store.upsertChat({
          id: chat.id,
          name: chat.name || null,
          timestamp: toUnixSeconds(chat.conversationTimestamp),
          unread_count: chat.unreadCount ?? null,
        });
      }

      const rows = messages
        .map((m) => toMessageRow(m))
        .filter((row): row is MessageRow => row !== null);
      const inserted = store.insertMessagesBulk(rows);
      console.log(`${tag} Stored ${inserted} new historical messages.`);
      // Mappings for this batch land in the auth dir around the same time.
      importLidMappings();
    });

    s.ev.on('messages.upsert', ({ messages }) => {
      for (const msg of messages) {
        const row = toMessageRow(msg);
        if (!row) continue;
        store.insertMessage(row);
        store.upsertChat({
          id: row.chat_jid,
          last_message_text: row.message_text,
          last_message_time: row.timestamp,
          timestamp: row.timestamp,
        });
      }
    });

    s.ev.on('chats.upsert', (chats) => {
      for (const chat of chats) {
        if (!chat.id) continue;
        store.upsertChat({
          id: chat.id,
          name: chat.name || null,
          timestamp: toUnixSeconds(chat.conversationTimestamp),
          unread_count: chat.unreadCount ?? null,
        });
      }
    });

    s.ev.on('contacts.upsert', (contacts) => {
      for (const contact of contacts) {
        if (!contact.id) continue;
        storeContact(contact);
      }
    });
  }

  connect().catch((err) => console.error(`${tag} Connection failed:`, err));

  return {
    getQR: () => currentQR,
    getPairingCode: () => currentPairingCode,
    isConnected: () => connected,
    getStatus: () => status,
    getSyncProgress: () => syncProgress,
    async logout() {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (sock) {
        try {
          await sock.logout();
          status = 'logged_out';
        } catch (err) {
          console.error(`${tag} logout failed:`, err);
        }
      }
    },
    close() {
      closed = true;
      status = 'closed';
      if (reconnectTimer) clearTimeout(reconnectTimer);
      try {
        sock?.end(new Error('connection closed'));
      } catch {
        /* already closed */
      }
    },
  };
}
