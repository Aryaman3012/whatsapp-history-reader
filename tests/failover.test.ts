import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFailoverConnection } from '../src/failover.js';
import type { WaConnection } from '../src/connection.js';

function stub(over: Partial<WaConnection> = {}): WaConnection & { closed: boolean } {
  const base = {
    closed: false,
    getQR: () => null,
    getPairingCode: () => null,
    isConnected: () => false,
    getStatus: () => 'connecting' as const,
    getSyncProgress: () => null,
    getLastSyncBatchAt: () => null,
    logout: async () => {},
    close(this: { closed: boolean }) {
      this.closed = true;
    },
    ...over,
  };
  return base as WaConnection & { closed: boolean };
}

const GRACE = 20_000;

test('a primary that never issues a QR hands over to the fallback', async () => {
  // The reported failure: Baileys is refused at the handshake, so no QR is ever
  // issued and the pairing page sits empty.
  const primary = stub();
  const fallback = stub({ getQR: () => 'FALLBACK-QR' });
  let built = 0;
  const conn = createFailoverConnection({
    primary,
    createFallback: () => {
      built++;
      return fallback;
    },
    handshakeGraceMs: GRACE,
    label: 't',
  });
  const t0 = Date.now();
  await conn.check(t0 + GRACE - 1);
  assert.equal(built, 0, 'still inside the grace period');
  await conn.check(t0 + GRACE + 1);
  assert.equal(built, 1);
  assert.equal(conn.getQR(), 'FALLBACK-QR', 'getters now read the fallback');
  assert.equal(primary.closed, true, 'the dead primary is torn down');
  assert.equal(conn.activeEngine(), 'fallback');
});

test('a primary that issues a QR is left alone', async () => {
  const primary = stub({ getQR: () => 'PRIMARY-QR' });
  let built = 0;
  const conn = createFailoverConnection({
    primary,
    createFallback: () => {
      built++;
      return stub();
    },
    handshakeGraceMs: GRACE,
    label: 't',
  });
  await conn.check(Date.now() + GRACE * 5);
  assert.equal(built, 0, 'a working handshake must never trigger failover');
  assert.equal(conn.getQR(), 'PRIMARY-QR');
  assert.equal(conn.activeEngine(), 'primary');
});

test('a primary that paired is left alone even with no QR', async () => {
  // Post-scan the QR is cleared; that must not look like a handshake failure.
  const primary = stub({ isConnected: () => true, getStatus: () => 'connected' });
  let built = 0;
  const conn = createFailoverConnection({
    primary,
    createFallback: () => {
      built++;
      return stub();
    },
    handshakeGraceMs: GRACE,
    label: 't',
  });
  await conn.check(Date.now() + GRACE * 5);
  assert.equal(built, 0);
  assert.equal(conn.activeEngine(), 'primary');
});

test('a pairing code also counts as a live handshake', async () => {
  const primary = stub({ getPairingCode: () => '12345678' });
  let built = 0;
  const conn = createFailoverConnection({
    primary,
    createFallback: () => {
      built++;
      return stub();
    },
    handshakeGraceMs: GRACE,
    label: 't',
  });
  await conn.check(Date.now() + GRACE * 5);
  assert.equal(built, 0);
});

test('failover happens once, not on every check', async () => {
  const primary = stub();
  let built = 0;
  const conn = createFailoverConnection({
    primary,
    createFallback: () => {
      built++;
      return stub();
    },
    handshakeGraceMs: GRACE,
    label: 't',
  });
  const t0 = Date.now();
  await conn.check(t0 + GRACE + 1);
  await conn.check(t0 + GRACE + 2);
  await conn.check(t0 + GRACE + 3);
  assert.equal(built, 1);
});

test('with no fallback configured the primary is left to keep retrying', async () => {
  const primary = stub();
  const conn = createFailoverConnection({
    primary,
    createFallback: null,
    handshakeGraceMs: GRACE,
    label: 't',
  });
  await conn.check(Date.now() + GRACE * 10);
  assert.equal(conn.activeEngine(), 'primary');
  assert.equal(primary.closed, false, 'without somewhere to go, tearing down helps nobody');
});
