import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSafeToken } from '../src/server.js';

test('report tokens are base64url and nothing else', () => {
  assert.equal(isSafeToken('abcDEF123_-xyz'), true);
  for (const bad of ['../../etc/passwd', 'tok/../x', 'tok with space', '', 'x'.repeat(200), 'tok%2e%2e']) {
    assert.equal(isSafeToken(bad), false, `should reject ${bad}`);
  }
});
