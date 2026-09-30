import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { buildAuditReport, UnknownChatError, RANGE_SECONDS } from '../src/auditor/auditRoute.js';

/** A store with one lead chat: patient asks twice, clinic never replies. */
function fixtureStore(): { store: Store; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-test-'));
  const store = new Store(path.join(dir, 'db.sqlite'));
  const jid = '971500000001@s.whatsapp.net';
  store.upsertChat({ id: jid, name: 'Fatima' });
  const now = Math.floor(Date.now() / 1000);
  for (const [i, text] of ['Hi, do you do braces?', 'Hello?'].entries()) {
    store.insertMessage({
      id: 'm' + i,
      chat_jid: jid,
      sender_jid: jid,
      sender_pn: '971500000001',
      sender_name: 'Fatima',
      message_text: text,
      message_type: 'conversation',
      timestamp: now - 86400 + i * 600,
      has_media: 0,
      media_url: null,
      is_from_me: 0,
      raw_json: null,
    });
  }
  return { store, dir };
}

test('buildAuditReport returns the report annotated with range and chat names', () => {
  const { store, dir } = fixtureStore();
  try {
    const report = buildAuditReport(store, '30d', {});
    assert.equal(report.range, '30d');
    assert.ok(report.rangeCutoffTimestamp > 0);
    assert.equal(report.zeroReply.neverReplied, 1);
    assert.equal(report.conversations[0].chatName, 'Fatima');
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('buildAuditReport rejects an unknown chat jid', () => {
  const { store, dir } = fixtureStore();
  try {
    assert.throws(() => buildAuditReport(store, '30d', {}, 'nope@s.whatsapp.net'), UnknownChatError);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('RANGE_SECONDS covers the three ranges the UI offers', () => {
  assert.deepEqual(Object.keys(RANGE_SECONDS).sort(), ['1y', '30d', '90d']);
});
