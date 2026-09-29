// Ephemeral multi-tenant sessions for the public free tool. Each session is
// one paired WhatsApp device: its own auth dir + SQLite DB under DATA_DIR,
// addressed by an unguessable token. Sessions are reaped after a TTL — the
// device is logged out (unlinked) and all data is deleted.
//
// Sessions run concurrently: an inbound funnel has clinics arriving minutes
// apart, and a new pairing must never disturb one already syncing. How many
// run at once is capped by `maxSessions` — every one is a linked device
// connecting from this server's IP, so keep it conservative.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Store } from './store.js';
import { createWaConnection, type WaConnection } from './connection.js';

export interface Session {
  id: string;
  /** Null when the session pairs via QR instead of a pairing code. */
  phone: string | null;
  store: Store;
  conn: WaConnection;
  dir: string;
  createdAt: number;
  lastAccess: number;
  /** Epoch ms the socket was last seen connected; null if it never paired. */
  lastConnectedAt: number | null;
}

export interface SessionManagerOptions {
  dataDir: string;
  /** Session lifetime in ms; reaper unlinks + purges after this. */
  ttlMs: number;
  maxSessions: number;
  /** Max session creations per IP per hour. */
  createsPerIpPerHour: number;
  /** How long a session may sit unpaired before it loses its slot. */
  pairingDeadlineMs?: number;
  /** How long a paired session may stay disconnected before it loses its slot. */
  unpairedGraceMs?: number;
  /** Seam for tests: build the WhatsApp connection without opening a socket. */
  createConnection?: (args: {
    store: Store;
    authDir: string;
    pairingPhoneNumber?: string;
    label: string;
  }) => WaConnection;
}

/** An abandoned QR screen holds a slot for this long, then loses it. */
const DEFAULT_PAIRING_DEADLINE_MS = 10 * 60_000;
/** A paired session may be disconnected this long before it loses its slot. */
const DEFAULT_UNPAIRED_GRACE_MS = 5 * 60_000;

export class SessionLimitError extends Error {}
export class RateLimitError extends Error {}

export class SessionManager {
  private sessions = new Map<string, Session>();
  private creationsByIp = new Map<string, number[]>();
  private reaper: NodeJS.Timeout;

  constructor(private opts: SessionManagerOptions) {
    fs.mkdirSync(path.join(opts.dataDir, 'sessions'), { recursive: true });
    this.purgeOrphanDirs();
    this.reaper = setInterval(() => void this.reap(), 60_000);
    this.reaper.unref();
  }

  /** Sessions are ephemeral: any dirs left from a previous process are dead. */
  private purgeOrphanDirs(): void {
    const root = path.join(this.opts.dataDir, 'sessions');
    for (const entry of fs.readdirSync(root)) {
      fs.rmSync(path.join(root, entry), { recursive: true, force: true });
    }
  }

  /** Pass phone=null for QR pairing. */
  create(phone: string | null, ip: string): Session {
    const now = Date.now();
    const recent = (this.creationsByIp.get(ip) ?? []).filter((t) => now - t < 3600_000);
    if (recent.length >= this.opts.createsPerIpPerHour) {
      throw new RateLimitError('Too many sessions from this address — try again later.');
    }
    if (this.sessions.size >= this.opts.maxSessions) {
      throw new SessionLimitError('The tool is at capacity right now — try again in a few minutes.');
    }
    recent.push(now);
    this.creationsByIp.set(ip, recent);

    const id = crypto.randomBytes(24).toString('base64url');
    const dir = path.join(this.opts.dataDir, 'sessions', id);
    fs.mkdirSync(dir, { recursive: true });
    const store = new Store(path.join(dir, 'db.sqlite'));
    const conn = (this.opts.createConnection ?? createWaConnection)({
      store,
      authDir: path.join(dir, 'auth'),
      pairingPhoneNumber: phone ?? undefined,
      label: id.slice(0, 8),
    });
    const session: Session = {
      id,
      phone,
      store,
      conn,
      dir,
      createdAt: now,
      lastAccess: now,
      lastConnectedAt: null,
    };
    this.sessions.set(id, session);
    console.log(
      `[sessions] created ${id.slice(0, 8)}… (${phone ? `+${phone}` : 'QR'}) — ${this.sessions.size} active`
    );
    return session;
  }

  get(id: string): Session | undefined {
    const s = this.sessions.get(id);
    if (s) s.lastAccess = Date.now();
    return s;
  }

  count(): number {
    return this.sessions.size;
  }

  /** Slots currently held by a live WhatsApp pairing. */
  pairedCount(): number {
    let paired = 0;
    for (const s of this.sessions.values()) if (s.conn.isConnected()) paired++;
    return paired;
  }

  /** The concurrency cap, so /health can report 2/3 rather than a bare 2. */
  maxSessions(): number {
    return this.opts.maxSessions;
  }

  /** Unlink the device (best effort), close everything, delete all data. */
  async destroy(id: string): Promise<boolean> {
    const s = this.sessions.get(id);
    if (!s) return false;
    this.sessions.delete(id);
    try {
      await Promise.race([s.conn.logout(), new Promise((r) => setTimeout(r, 10_000))]);
    } finally {
      s.conn.close();
      try {
        s.store.close();
      } catch {
        /* already closed */
      }
      fs.rmSync(s.dir, { recursive: true, force: true });
    }
    console.log(`[sessions] destroyed ${id.slice(0, 8)}… (${this.sessions.size} active)`);
    return true;
  }

  /**
   * A slot is only worth holding while a session is paired. Besides the TTL,
   * three states end one early: it never paired (an abandoned QR screen), it
   * paired and then went quiet past the grace period (a reconnect loop that
   * will not recover), or WhatsApp logged it out. Without these, MAX_SESSIONS
   * slots fill with sessions that can never produce a report and the tool
   * turns real clinics away for hours while looking perfectly healthy.
   */
  async reap(now: number = Date.now()): Promise<void> {
    const doomed: Array<{ id: string; why: string }> = [];
    for (const s of this.sessions.values()) {
      if (s.conn.isConnected()) s.lastConnectedAt = now;
      const pairingDeadlineMs = this.opts.pairingDeadlineMs ?? DEFAULT_PAIRING_DEADLINE_MS;
      const unpairedGraceMs = this.opts.unpairedGraceMs ?? DEFAULT_UNPAIRED_GRACE_MS;

      if (now - s.createdAt > this.opts.ttlMs) {
        doomed.push({ id: s.id, why: 'TTL expired' });
      } else if (s.conn.getStatus() === 'logged_out') {
        doomed.push({ id: s.id, why: 'logged out of WhatsApp' });
      } else if (s.lastConnectedAt === null) {
        if (now - s.createdAt > pairingDeadlineMs) doomed.push({ id: s.id, why: 'never paired' });
      } else if (!s.conn.isConnected() && now - s.lastConnectedAt > unpairedGraceMs) {
        doomed.push({ id: s.id, why: 'lost its pairing' });
      }
    }
    for (const { id, why } of doomed) {
      console.log(`[sessions] ${id.slice(0, 8)}… ${why} — unlinking and purging.`);
    }
    await Promise.all(
      doomed.map(({ id }) =>
        this.destroy(id).catch((err) => console.error('[sessions] reap failed:', err))
      )
    );
  }

  async shutdown(): Promise<void> {
    clearInterval(this.reaper);
    await Promise.all([...this.sessions.keys()].map((id) => this.destroy(id)));
  }
}
