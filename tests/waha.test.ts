import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { createWahaConnection, DEFAULT_WAHA_CONFIG, resolveWahaConfig } from '../src/engines/waha.js';

function tempStore(): { store: Store; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'waha-test-'));
  return { store: new Store(path.join(dir, 'db.sqlite')), dir };
}

/** A WAHA server whose session status the test advances by hand. */
function fakeWaha(state: { status: string }) {
  const calls: string[] = [];
  const impl: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push(`${init?.method ?? 'GET'} ${url.replace('http://waha', '')}`);
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

    if (url.includes('/auth/qr')) return json({ value: 'QR-PAYLOAD-1' });
    if (url.includes('/auth/request-code')) return json({ code: '12345678' });
    if (url.match(/\/api\/sessions\/[^/]+$/) && (init?.method ?? 'GET') === 'GET') {
      return json({ status: state.status });
    }
    if (url.includes('/chats/') && url.includes('/messages')) {
      return json([
        { id: 'm1', timestamp: 1_760_000_000, from: '971501234567@c.us', to: '971509999999@c.us', fromMe: false, body: 'Is Sunday free?', hasMedia: false },
        { id: 'm2', timestamp: 1_760_000_600, from: '971509999999@c.us', to: '971501234567@c.us', fromMe: true, body: '11am works', hasMedia: false },
      ]);
    }
    if (url.includes('/chats?')) {
      return json([{ id: '971501234567@c.us', name: 'Fatima', timestamp: 1_760_000_600 }]);
    }
    return json({ ok: true });
  };
  return { impl, calls };
}

const config = { baseUrl: 'http://waha', apiKey: 'secret', ...DEFAULT_WAHA_CONFIG };

test('the QR is exposed while WAHA waits for a scan', async () => {
  const { store, dir } = tempStore();
  const state = { status: 'SCAN_QR_CODE' };
  const waha = fakeWaha(state);
  try {
    const conn = createWahaConnection({ store, sessionName: 'sess-1', config, fetchImpl: waha.impl });
    await conn.tick();
    assert.equal(conn.getQR(), 'QR-PAYLOAD-1');
    assert.equal(conn.isConnected(), false);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('reaching WORKING pulls history into the store as auditable rows', async () => {
  const { store, dir } = tempStore();
  const state = { status: 'SCAN_QR_CODE' };
  const waha = fakeWaha(state);
  try {
    let connectedFired = false;
    const conn = createWahaConnection({
      store,
      sessionName: 'sess-2',
      config,
      fetchImpl: waha.impl,
      onConnected: () => {
        connectedFired = true;
      },
    });
    await conn.tick();
    state.status = 'WORKING';
    await conn.tick();

    assert.equal(connectedFired, true);
    assert.equal(conn.isConnected(), true);
    assert.equal(conn.getStatus(), 'connected');
    assert.equal(conn.getSyncProgress(), 100);
    assert.ok(conn.getLastSyncBatchAt() !== null, 'a batch timestamp proves messages landed');

    const stats = store.getStats();
    assert.equal(stats.totalMessages, 2);
    // The audit only sees @s.whatsapp.net / @lid chats, so the rewrite has to
    // have happened on the way in, not at read time.
    const chats = store.getChats();
    assert.equal(chats.length, 1);
    assert.equal(chats[0]?.id, '971501234567@s.whatsapp.net');
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('history is pulled once, not on every poll', async () => {
  const { store, dir } = tempStore();
  const state = { status: 'WORKING' };
  const waha = fakeWaha(state);
  try {
    const conn = createWahaConnection({ store, sessionName: 'sess-3', config, fetchImpl: waha.impl });
    await conn.tick();
    await conn.tick();
    await conn.tick();
    const pulls = waha.calls.filter((c) => c.includes('/chats?')).length;
    assert.equal(pulls, 1, 'a second poll must not re-walk every chat');
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a FAILED session reports closed rather than pretending to work', async () => {
  const { store, dir } = tempStore();
  const state = { status: 'FAILED' };
  const waha = fakeWaha(state);
  try {
    const conn = createWahaConnection({ store, sessionName: 'sess-4', config, fetchImpl: waha.impl });
    await conn.tick();
    assert.equal(conn.getStatus(), 'closed');
    assert.equal(conn.isConnected(), false);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the history window and caps are sent to WAHA', async () => {
  const { store, dir } = tempStore();
  const state = { status: 'WORKING' };
  const waha = fakeWaha(state);
  try {
    const conn = createWahaConnection({ store, sessionName: 'sess-5', config, fetchImpl: waha.impl });
    await conn.tick();
    const msgCall = waha.calls.find((c) => c.includes('/messages'));
    assert.ok(msgCall?.includes(`limit=${config.maxMessagesPerChat}`), msgCall);
    assert.ok(msgCall?.includes('filter.timestamp.gte='), 'must not pull all of history');
    assert.ok(msgCall?.includes('downloadMedia=false'), 'media would blow up the sidecar disk');
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('no WAHA_URL means no fallback engine, not a crash', () => {
  assert.equal(resolveWahaConfig({}), null);
});

test('a WAHA URL without an API key is fatal', () => {
  // An unauthenticated WAHA on the box is an open WhatsApp gateway.
  assert.throws(() => resolveWahaConfig({ WAHA_URL: 'http://127.0.0.1:3001' }), /WAHA_API_KEY/);
});

test('WAHA config reads its knobs from the environment', () => {
  const cfg = resolveWahaConfig({
    WAHA_URL: 'http://127.0.0.1:3001/',
    WAHA_API_KEY: 'k',
    WAHA_HISTORY_DAYS: '30',
    WAHA_ENGINE: 'GOWS',
  });
  assert.equal(cfg?.baseUrl, 'http://127.0.0.1:3001', 'trailing slash would double up in paths');
  assert.equal(cfg?.historyDays, 30);
  assert.equal(cfg?.engine, 'GOWS');
  assert.equal(cfg?.maxChats, DEFAULT_WAHA_CONFIG.maxChats);
});
