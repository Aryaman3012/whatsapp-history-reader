import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSafeToken, reportRedirectTarget } from '../src/server.js';

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
