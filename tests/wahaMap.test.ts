import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeJid, wahaChatToUpsert, wahaMessageToRow } from '../src/engines/wahaMap.js';

test('@c.us is normalized to @s.whatsapp.net', () => {
  // The audit counts a chat as a lead only when its jid ends in @s.whatsapp.net
  // or @lid (see PERSONAL_CHAT in store.ts). WAHA's browser engine emits @c.us,
  // so without this every WAHA-sourced audit would come back empty.
  assert.equal(normalizeJid('971501234567@c.us'), '971501234567@s.whatsapp.net');
  assert.equal(normalizeJid('971501234567@s.whatsapp.net'), '971501234567@s.whatsapp.net');
  assert.equal(normalizeJid('123456@lid'), '123456@lid');
  assert.equal(normalizeJid('987654321@g.us'), '987654321@g.us');
});

test('an inbound WAHA message becomes a lead-side row', () => {
  const row = wahaMessageToRow('971501234567@c.us', {
    id: 'false_971501234567@c.us_ABC',
    timestamp: 1_760_000_000,
    from: '971501234567@c.us',
    to: '971509999999@c.us',
    fromMe: false,
    body: 'Do you have an appointment on Sunday?',
    hasMedia: false,
  });
  assert.equal(row.chat_jid, '971501234567@s.whatsapp.net');
  assert.equal(row.sender_jid, '971501234567@s.whatsapp.net');
  assert.equal(row.sender_pn, '971501234567');
  assert.equal(row.is_from_me, 0);
  assert.equal(row.message_text, 'Do you have an appointment on Sunday?');
  assert.equal(row.message_type, 'text');
  assert.equal(row.timestamp, 1_760_000_000);
  assert.equal(row.has_media, 0);
});

test('an outbound message is marked from the clinic', () => {
  const row = wahaMessageToRow('971501234567@c.us', {
    id: 'true_971501234567@c.us_XYZ',
    timestamp: 1_760_000_600,
    from: '971509999999@c.us',
    to: '971501234567@c.us',
    fromMe: true,
    body: 'Yes, 11am works.',
    hasMedia: false,
  });
  assert.equal(row.is_from_me, 1);
  assert.equal(row.chat_jid, '971501234567@s.whatsapp.net');
});

test('a media message keeps its type and flag', () => {
  const row = wahaMessageToRow('971501234567@c.us', {
    id: 'x',
    timestamp: 1_760_000_700,
    from: '971501234567@c.us',
    to: '971509999999@c.us',
    fromMe: false,
    body: '',
    hasMedia: true,
    _data: { type: 'image' },
  });
  assert.equal(row.has_media, 1);
  assert.equal(row.message_type, 'image');
  assert.equal(row.message_text, null, 'an empty caption is not an empty string');
});

test('timestamps arriving in milliseconds are brought back to seconds', () => {
  // Engines disagree: noweb/gows report seconds, some webjs builds report ms.
  // The auditor does all its arithmetic in seconds.
  const row = wahaMessageToRow('971501234567@c.us', {
    id: 'ms',
    timestamp: 1_760_000_000_000,
    from: '971501234567@c.us',
    to: '971509999999@c.us',
    fromMe: false,
    body: 'hi',
    hasMedia: false,
  });
  assert.equal(row.timestamp, 1_760_000_000);
});

test('a WAHA chat becomes a store chat row', () => {
  const chat = wahaChatToUpsert({
    id: '971501234567@c.us',
    name: 'Fatima',
    timestamp: 1_760_000_600,
    conversationTimestamp: null,
  });
  assert.equal(chat.id, '971501234567@s.whatsapp.net');
  assert.equal(chat.name, 'Fatima');
  assert.equal(chat.timestamp, 1_760_000_600);
});
