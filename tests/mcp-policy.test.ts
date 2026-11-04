import test from 'node:test';
import assert from 'node:assert/strict';
import {
  tokenHash,
  authorizeToken,
  allowedScopes,
  parseTokenRequest,
} from '../server/mcpPolicy.ts';
test('MCP tokens expire, revoke, and enforce exact scope and owner', () => {
  const record = {
    ownerUid: 'alice',
    scopes: ['maps:read'],
    expiresAt: Date.now() + 1000,
    revoked: false,
  };
  assert.equal(authorizeToken(record, 'maps:read').uid, 'alice');
  assert.throws(() => authorizeToken(record, 'boards:read'));
  assert.throws(() => authorizeToken({ ...record, revoked: true }, 'maps:read'));
  assert.throws(() => authorizeToken({ ...record, expiresAt: 1 }, 'maps:read'));
  assert.throws(() => authorizeToken({ ...record, ownerUid: 'bob/other' }, 'maps:read'));
  assert.equal(tokenHash('secret').length, 64);
  assert.notEqual(tokenHash('secret'), 'secret');
});
test('MCP consent has bounded lifetime and rejects unknown scopes', () => {
  assert.equal(parseTokenRequest({ name: 'Agent', scopes: ['maps:read'], days: 30 }).days, 30);
  for (const body of [
    { name: '', scopes: allowedScopes, days: 30 },
    { name: 'a', scopes: ['admin'], days: 30 },
    { name: 'a', scopes: ['maps:read'], days: 366 },
    { name: 'a', scopes: [], days: 30 },
  ])
    assert.throws(() => parseTokenRequest(body));
});

test('MCP rejects disabled accounts and tokens created before Firebase-wide revocation', async () => {
  const { assertActiveMcpAccount } = await import('../server/mcpPolicy.ts');
  assert.doesNotThrow(() =>
    assertActiveMcpAccount(
      { disabled: false, tokensValidAfterTime: '1970-01-01T00:00:01.000Z' },
      2000,
    ),
  );
  assert.throws(() => assertActiveMcpAccount({ disabled: true }, 2000));
  assert.throws(() =>
    assertActiveMcpAccount(
      { disabled: false, tokensValidAfterTime: '1970-01-01T00:00:03.000Z' },
      2000,
    ),
  );
  assert.throws(() => assertActiveMcpAccount({ disabled: false }, undefined));
});
