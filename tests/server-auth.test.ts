import test from 'node:test';
import assert from 'node:assert/strict';
import { bearerToken, enforceUid } from '../server/authPolicy.ts';
test('UI auth only accepts one bounded bearer token', () => {
  assert.equal(bearerToken('Bearer abc.def.ghi'), 'abc.def.ghi');
  for (const v of [
    undefined,
    '',
    'Basic foo',
    'Bearer a b',
    'Bearer ',
    ['Bearer x'],
    'Bearer ' + 'a'.repeat(10000),
  ])
    assert.throws(() => bearerToken(v));
});
test('UID paths cannot escape per-account namespaces', () => {
  assert.equal(enforceUid('firebase-user-123'), 'firebase-user-123');
  for (const v of ['', '../other', 'a/b', '.', '..', null, 42]) assert.throws(() => enforceUid(v));
});
