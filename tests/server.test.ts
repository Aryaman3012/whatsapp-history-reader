import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildHealthPayload, isSafeToken, reportRedirectTarget } from '../src/server.js';

test('report tokens are base64url and nothing else', () => {
  assert.equal(isSafeToken('abcDEF123_-xyz'), true);
  for (const bad of ['../../etc/passwd', 'tok/../x', 'tok with space', '', 'x'.repeat(200), 'tok%2e%2e']) {
    assert.equal(isSafeToken(bad), false, `should reject ${bad}`);
  }
});

test('the report redirect points one level up, out of /r/', () => {
  // /r/<token> is one path segment deeper than the page, and the app can be
  // mounted under a base path, so the target must be relative to the parent.
  assert.equal(reportRedirectTarget('tok123'), '../audit.html?report=tok123');
  assert.equal(reportRedirectTarget('a b&c'), '../audit.html?report=a%20b%26c');
});

test('health is 200 while the tool can actually deliver a report', () => {
  const ok = buildHealthPayload({
    mode: 'serve',
    uptimeSeconds: 42.7,
    mailOk: true,
    sessions: { active: 1, max: 3 },
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.ok, true);
  assert.equal(ok.body.mail, 'ok');
  assert.equal(ok.body.uptimeSeconds, 43);
  assert.deepEqual(ok.body.sessions, { active: 1, max: 3 });
  assert.deepEqual(ok.body.degraded, []);
});

test('health is 503 when SMTP is dead, because email is the only delivery path', () => {
  // A mailless serve process accepts unlocks and silently delivers nothing.
  // That is an outage worth paging on even though the HTTP server is fine.
  const bad = buildHealthPayload({
    mode: 'serve',
    uptimeSeconds: 10,
    mailOk: false,
    sessions: { active: 0, max: 3 },
  });
  assert.equal(bad.status, 503);
  assert.equal(bad.body.ok, false);
  assert.equal(bad.body.mail, 'error');
  assert.deepEqual(bad.body.degraded, ['smtp']);
});

test('health does not page during the startup verify race', () => {
  // verify() is still in flight: unknown is not the same as broken.
  const starting = buildHealthPayload({
    mode: 'serve',
    uptimeSeconds: 1,
    mailOk: null,
    sessions: { active: 0, max: 3 },
  });
  assert.equal(starting.status, 200);
  assert.equal(starting.body.mail, 'unverified');
  assert.deepEqual(starting.body.degraded, []);
});

test('local mode has no mail path to be unhealthy about', () => {
  const local = buildHealthPayload({
    mode: 'local',
    uptimeSeconds: 5,
    mailOk: null,
    sessions: null,
  });
  assert.equal(local.status, 200);
  assert.equal(local.body.mail, 'n/a');
  assert.equal(local.body.sessions, undefined);
});
