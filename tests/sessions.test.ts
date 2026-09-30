import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionManager, SessionLimitError, RateLimitError } from '../src/sessions.js';
import type { WaConnection } from '../src/connection.js';

function stubConnection(): WaConnection {
  return controllableConnection().conn;
}

/** A stub whose pairing state the test drives. */
function controllableConnection(): {
  conn: WaConnection;
  state: { connected: boolean; status: 'connecting' | 'connected' | 'logged_out' | 'closed' };
} {
  const state = { connected: false, status: 'connecting' as const } as {
    connected: boolean;
    status: 'connecting' | 'connected' | 'logged_out' | 'closed';
  };
  const conn: WaConnection = {
    getQR: () => null,
    getPairingCode: () => '12345678',
    isConnected: () => state.connected,
    getStatus: () => state.status,
    getSyncProgress: () => null,
    getLastSyncBatchAt: () => null,
    logout: async () => {},
    close: () => {},
  };
  return { conn, state };
}

function manager(maxSessions = 5, createsPerIpPerHour = 10): { mgr: SessionManager; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sessions-test-'));
  const mgr = new SessionManager({
    dataDir: dir,
    ttlMs: 60_000,
    maxSessions,
    createsPerIpPerHour,
    createConnection: stubConnection,
  });
  return { mgr, dir };
}

test('a second session does not evict the first', async () => {
  const { mgr, dir } = manager();
  try {
    const a = mgr.create('971500000001', '1.1.1.1');
    const b = mgr.create('971500000002', '2.2.2.2');
    assert.equal(mgr.count(), 2);
    assert.ok(mgr.get(a.id), 'the first session must survive the second linking');
    assert.ok(mgr.get(b.id));
  } finally {
    await mgr.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the cap refuses new sessions instead of evicting existing ones', async () => {
  const { mgr, dir } = manager(2);
  try {
    const a = mgr.create('971500000001', '1.1.1.1');
    mgr.create('971500000002', '2.2.2.2');
    assert.throws(() => mgr.create('971500000003', '3.3.3.3'), SessionLimitError);
    assert.ok(mgr.get(a.id), 'an over-capacity attempt must not destroy anyone');
    assert.equal(mgr.count(), 2);
  } finally {
    await mgr.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the per-IP rate limit still applies', async () => {
  const { mgr, dir } = manager(10, 1);
  try {
    mgr.create('971500000001', '1.1.1.1');
    assert.throws(() => mgr.create('971500000002', '1.1.1.1'), RateLimitError);
  } finally {
    await mgr.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


const MIN_MS = 60_000;

function pairingManager(overrides: Partial<{ pairingDeadlineMs: number; unpairedGraceMs: number }> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sessions-pairing-'));
  const built = controllableConnection();
  const mgr = new SessionManager({
    dataDir: dir,
    ttlMs: 120 * MIN_MS,
    maxSessions: 5,
    createsPerIpPerHour: 10,
    pairingDeadlineMs: 10 * MIN_MS,
    unpairedGraceMs: 5 * MIN_MS,
    createConnection: () => built.conn,
    ...overrides,
  });
  return { mgr, dir, state: built.state };
}

test('a session that never pairs is reaped instead of holding a slot for hours', async () => {
  // Three abandoned QR screens must not make the tool report "at capacity"
  // to every real clinic for the whole two-hour TTL.
  const { mgr, dir } = pairingManager();
  try {
    const s = mgr.create('971500000001', '1.1.1.1');
    await mgr.reap(s.createdAt + 9 * MIN_MS);
    assert.ok(mgr.get(s.id), 'still inside the pairing deadline');
    await mgr.reap(s.createdAt + 11 * MIN_MS);
    assert.equal(mgr.count(), 0, 'an unpaired session past the deadline is gone');
  } finally {
    await mgr.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a paired session is not reaped by the pairing deadline', async () => {
  const { mgr, dir, state } = pairingManager();
  try {
    const s = mgr.create('971500000001', '1.1.1.1');
    state.connected = true;
    state.status = 'connected';
    await mgr.reap(s.createdAt + 11 * MIN_MS);
    assert.ok(mgr.get(s.id), 'a paired session survives well past the pairing deadline');
  } finally {
    await mgr.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a session that loses its pairing is reaped after the grace period', async () => {
  // Reconnect backoff can loop forever when WhatsApp refuses the server's IP.
  const { mgr, dir, state } = pairingManager();
  try {
    const s = mgr.create('971500000001', '1.1.1.1');
    state.connected = true;
    state.status = 'connected';
    await mgr.reap(s.createdAt + MIN_MS);
    state.connected = false;
    state.status = 'connecting';
    await mgr.reap(s.createdAt + 4 * MIN_MS);
    assert.ok(mgr.get(s.id), 'a brief reconnect is not a dead session');
    await mgr.reap(s.createdAt + 8 * MIN_MS);
    assert.equal(mgr.count(), 0, 'dead air past the grace period frees the slot');
  } finally {
    await mgr.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a logged-out session is reaped at once', async () => {
  // 401 means the clinic unlinked us or the number was banned. Nothing to wait for.
  const { mgr, dir, state } = pairingManager();
  try {
    const s = mgr.create('971500000001', '1.1.1.1');
    state.status = 'logged_out';
    await mgr.reap(s.createdAt + 1000);
    assert.equal(mgr.count(), 0);
  } finally {
    await mgr.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pairedCount reports slots that are actually connected', async () => {
  const { mgr, dir, state } = pairingManager();
  try {
    mgr.create('971500000001', '1.1.1.1');
    assert.equal(mgr.pairedCount(), 0);
    state.connected = true;
    state.status = 'connected';
    assert.equal(mgr.pairedCount(), 1);
  } finally {
    await mgr.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
