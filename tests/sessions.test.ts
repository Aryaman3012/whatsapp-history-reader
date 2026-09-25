import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionManager, SessionLimitError, RateLimitError } from '../src/sessions.js';
import type { WaConnection } from '../src/connection.js';

function stubConnection(): WaConnection {
  return {
    getQR: () => null,
    getPairingCode: () => '12345678',
    isConnected: () => false,
    getStatus: () => 'connecting',
    getSyncProgress: () => null,
    logout: async () => {},
    close: () => {},
  };
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
