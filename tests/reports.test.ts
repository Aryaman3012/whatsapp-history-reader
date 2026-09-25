import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ReportStore, type NewReport } from '../src/reports.js';

function tmpStore(): { store: ReportStore; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reports-test-'));
  return { store: new ReportStore(path.join(dir, 'reports.db')), dir };
}

const input: NewReport = {
  sessionId: 'sess-1',
  email: 'owner@clinic.ae',
  name: 'Dr Khan',
  phone: '971500000000',
  clinic: 'Smile Dental',
  avgTicketValue: 2000,
  waPhone: '971500000001',
  report: { '30d': { range: '30d' } as never },
  ip: '1.2.3.4',
  userAgent: 'test',
  referrer: null,
};

test('create returns a row with an unguessable id and round-trips the report', () => {
  const { store, dir } = tmpStore();
  try {
    const row = store.create(input);
    assert.ok(row.id.length >= 32);
    assert.equal(row.email, 'owner@clinic.ae');
    assert.equal(store.get(row.id)?.report['30d'].range, '30d');
    assert.equal(store.get(row.id)?.emailAttempts, 0);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('two reports never share an id', () => {
  const { store, dir } = tmpStore();
  try {
    assert.notEqual(store.create(input).id, store.create(input).id);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('get returns undefined for an unknown id', () => {
  const { store, dir } = tmpStore();
  try {
    assert.equal(store.get('nope'), undefined);
    assert.equal(store.get("'; DROP TABLE reports; --"), undefined);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('getBySession finds the report a session already produced', () => {
  const { store, dir } = tmpStore();
  try {
    const row = store.create(input);
    assert.equal(store.getBySession('sess-1')?.id, row.id);
    assert.equal(store.getBySession('other'), undefined);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('status updates persist', () => {
  const { store, dir } = tmpStore();
  try {
    const row = store.create(input);
    store.setEmailStatus(row.id, 'sent', 2);
    store.setLeadStatus(row.id, 'lead-9', 'sent');
    store.setEmail(row.id, 'fixed@clinic.ae');
    const after = store.get(row.id)!;
    assert.equal(after.emailStatus, 'sent');
    assert.equal(after.emailAttempts, 2);
    assert.ok(after.emailSentAt && after.emailSentAt > 0);
    assert.equal(after.leadId, 'lead-9');
    assert.equal(after.email, 'fixed@clinic.ae');
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
