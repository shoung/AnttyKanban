import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { createCipher, createOAuthSecrets, hashValue } from '../server/calendar/security.ts';

test('token encryption is randomized and bound to the owning UID', () => {
  const cipher = createCipher(Buffer.alloc(32, 7).toString('base64'));
  const first = cipher.seal('refresh-secret', 'user-a');
  const second = cipher.seal('refresh-secret', 'user-a');
  assert.notEqual(first, second);
  assert.ok(!first.includes('refresh-secret'));
  assert.equal(cipher.open(first, 'user-a'), 'refresh-secret');
  assert.throws(() => cipher.open(first, 'user-b'));
  const parts = first.split('.');
  parts[2] = Buffer.alloc(16, 0).toString('base64url');
  assert.throws(() => cipher.open(parts.join('.'), 'user-a'));
});

test('invalid encryption keys and malformed envelopes fail closed', () => {
  assert.throws(() => createCipher('short'));
  const cipher = createCipher(Buffer.alloc(32, 9).toString('base64'));
  assert.throws(() => cipher.open('not-an-envelope', 'user-a'));
});

test('PKCE uses S256 and fresh high-entropy state per connection attempt', () => {
  const first = createOAuthSecrets();
  const second = createOAuthSecrets();
  assert.notEqual(first.state, second.state);
  assert.notEqual(first.verifier, second.verifier);
  assert.match(first.state, /^[A-Za-z0-9_-]{43,}$/);
  assert.match(first.verifier, /^[A-Za-z0-9_-]{43,128}$/);
  assert.equal(first.challenge, createHash('sha256').update(first.verifier).digest('base64url'));
  assert.equal(hashValue('abc'), 'ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0');
});
