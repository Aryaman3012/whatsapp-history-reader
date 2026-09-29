// A WaConnection backed by WAHA (https://waha.devlike.pro) running as a Docker
// sidecar. This is the fallback engine: when Baileys cannot get as far as
// issuing a QR, the session is served from here instead.
//
// Unlike the Baileys engine this is pull-based. The audit needs a bulk history
// read exactly once per session, not a live event stream, so the connection
// polls session status and then walks chats over REST. That keeps the
// integration to plain HTTP with no webhook callbacks to expose.
import type { WaConnection, WaStatus } from '../connection.js';
import type { Store } from '../store.js';
import { wahaChatToUpsert, wahaMessageToRow, type WahaChat, type WahaMessage } from './wahaMap.js';

export interface WahaConfig {
  /** Base URL of the WAHA container, e.g. http://127.0.0.1:3001 */
  baseUrl: string;
  apiKey: string;
  /** WAHA engine to run this session on. WEBJS is browser-based and so is not
   *  vulnerable to the hardcoded-client-version rejection that stops Baileys. */
  engine: string;
  maxChats: number;
  maxMessagesPerChat: number;
  historyDays: number;
}

export const DEFAULT_WAHA_CONFIG: Omit<WahaConfig, 'baseUrl' | 'apiKey'> = {
  engine: 'WEBJS',
  maxChats: 500,
  maxMessagesPerChat: 2000,
  historyDays: 90,
};

export interface WahaConnectionArgs {
  store: Store;
  sessionName: string;
  config: WahaConfig;
  pairingPhoneNumber?: string;
  label?: string;
  onConnected?: () => void;
  fetchImpl?: typeof fetch;
}

type WahaSessionStatus =
  | 'STOPPED'
  | 'STARTING'
  | 'SCAN_QR_CODE'
  | 'PASSKEY_REQUIRED'
  | 'PASSKEY_CONFIRMATION_REQUIRED'
  | 'WORKING'
  | 'FAILED';

export interface WahaConnection extends WaConnection {
  /** Advance the state machine once. The poll loop calls this; tests call it directly. */
  tick(): Promise<void>;
  start(): Promise<void>;
}

export function createWahaConnection(args: WahaConnectionArgs): WahaConnection {
  const { store, sessionName, config, pairingPhoneNumber, onConnected } = args;
  const doFetch = args.fetchImpl ?? fetch;
  const tag = `[waha:${args.label ?? sessionName.slice(0, 8)}]`;

  let status: WaStatus = 'connecting';
  let connected = false;
  let qr: string | null = null;
  let pairingCode: string | null = null;
  let syncProgress: number | null = null;
  let lastSyncBatchAt: number | null = null;
  let historyStarted = false;
  let closed = false;
  let poller: NodeJS.Timeout | null = null;

  async function api(path: string, init: RequestInit = {}): Promise<Response> {
    return doFetch(`${config.baseUrl}${path}`, {
      ...init,
      headers: {
        'X-Api-Key': config.apiKey,
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    });
  }

  async function start(): Promise<void> {
    const res = await api('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({
        name: sessionName,
        start: true,
        config: { metadata: {}, debug: false },
      }),
    });
    // 422 is WAHA's "already exists" — start it rather than treating it as fatal.
    if (!res.ok && res.status === 422) {
      await api(`/api/sessions/${encodeURIComponent(sessionName)}/start`, { method: 'POST' });
    } else if (!res.ok) {
      throw new Error(`WAHA session create failed: ${res.status}`);
    }
    if (pairingPhoneNumber) await requestPairingCode();
    poller = setInterval(() => void tick().catch(() => {}), 2000);
    poller.unref();
  }

  async function requestPairingCode(): Promise<void> {
    const res = await api(`/api/${encodeURIComponent(sessionName)}/auth/request-code`, {
      method: 'POST',
      body: JSON.stringify({ phoneNumber: pairingPhoneNumber }),
    });
    if (!res.ok) return;
    const body = (await res.json()) as { code?: string };
    if (body.code) pairingCode = body.code;
  }

  async function fetchQr(): Promise<void> {
    const res = await api(`/api/${encodeURIComponent(sessionName)}/auth/qr?format=raw`);
    if (!res.ok) return;
    const body = (await res.json()) as { value?: string };
    if (body.value) qr = body.value;
  }

  async function tick(): Promise<void> {
    if (closed) return;
    const res = await api(`/api/sessions/${encodeURIComponent(sessionName)}`);
    if (!res.ok) return;
    const body = (await res.json()) as { status?: WahaSessionStatus };
    const s = body.status;

    if (s === 'SCAN_QR_CODE') {
      status = 'connecting';
      if (!qr) await fetchQr();
      return;
    }
    if (s === 'FAILED') {
      status = 'closed';
      connected = false;
      return;
    }
    if (s === 'WORKING') {
      qr = null;
      connected = true;
      status = 'connected';
      if (!historyStarted) {
        historyStarted = true;
        onConnected?.();
        await syncHistory();
      }
    }
  }

  /** One bulk pass: newest chats first, each one's recent messages into the store. */
  async function syncHistory(): Promise<void> {
    const since = Math.floor(Date.now() / 1000) - config.historyDays * 86400;
    const chatsRes = await api(
      `/api/${encodeURIComponent(sessionName)}/chats?limit=${config.maxChats}` +
        `&sortBy=messageTimestamp&sortOrder=desc`
    );
    if (!chatsRes.ok) return;
    const chats = (await chatsRes.json()) as WahaChat[];
    if (chats.length === 0) {
      syncProgress = 100;
      return;
    }
    syncProgress = 0;
    let done = 0;
    for (const chat of chats) {
      if (closed) return;
      store.upsertChat(wahaChatToUpsert(chat));
      const msgsRes = await api(
        `/api/${encodeURIComponent(sessionName)}/chats/${encodeURIComponent(chat.id)}/messages` +
          `?limit=${config.maxMessagesPerChat}&downloadMedia=false&filter.timestamp.gte=${since}`
      );
      if (msgsRes.ok) {
        const msgs = (await msgsRes.json()) as WahaMessage[];
        if (msgs.length > 0) {
          store.insertMessagesBulk(msgs.map((m) => wahaMessageToRow(chat.id, m)));
          lastSyncBatchAt = Date.now();
        }
      }
      done++;
      syncProgress = Math.round((done / chats.length) * 100);
    }
    console.log(`${tag} History pull finished: ${chats.length} chats.`);
  }

  return {
    start,
    tick,
    getQR: () => qr,
    getPairingCode: () => pairingCode,
    isConnected: () => connected,
    getStatus: () => status,
    getSyncProgress: () => syncProgress,
    getLastSyncBatchAt: () => lastSyncBatchAt,
    async logout(): Promise<void> {
      closed = true;
      if (poller) clearInterval(poller);
      try {
        await api(`/api/sessions/${encodeURIComponent(sessionName)}/logout`, { method: 'POST' });
      } finally {
        await api(`/api/sessions/${encodeURIComponent(sessionName)}`, { method: 'DELETE' }).catch(
          () => undefined
        );
        status = 'logged_out';
        connected = false;
      }
    },
    close(): void {
      closed = true;
      connected = false;
      status = 'closed';
      if (poller) clearInterval(poller);
      void api(`/api/sessions/${encodeURIComponent(sessionName)}/stop`, { method: 'POST' }).catch(
        () => undefined
      );
    },
  };
}

/**
 * WAHA config from the environment; null when no sidecar is configured, which
 * simply means no fallback engine. A URL without a key is fatal rather than
 * ignored: an unauthenticated WAHA is an open WhatsApp gateway on the box.
 */
export function resolveWahaConfig(env: NodeJS.ProcessEnv): WahaConfig | null {
  const baseUrl = env.WAHA_URL?.trim();
  if (!baseUrl) return null;
  const apiKey = env.WAHA_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('WAHA_URL is set but WAHA_API_KEY is missing — refusing to start.');
  }
  const num = (raw: string | undefined, fallback: number): number => {
    const n = parseInt(raw ?? '', 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    apiKey,
    engine: env.WAHA_ENGINE?.trim() || DEFAULT_WAHA_CONFIG.engine,
    maxChats: num(env.WAHA_MAX_CHATS, DEFAULT_WAHA_CONFIG.maxChats),
    maxMessagesPerChat: num(env.WAHA_MAX_MESSAGES, DEFAULT_WAHA_CONFIG.maxMessagesPerChat),
    historyDays: num(env.WAHA_HISTORY_DAYS, DEFAULT_WAHA_CONFIG.historyDays),
  };
}
