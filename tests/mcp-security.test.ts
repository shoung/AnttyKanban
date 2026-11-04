import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createTokenService, type McpTokenRepository } from '../server/mcpTokens.ts';
import {
  assertMcpRequestOrigin,
  getMcpConfig,
  readBoundedJson,
  LocalRateLimiter,
} from '../server/mcpHttp.ts';
import { tokenHash, type McpTokenRecord } from '../server/mcpPolicy.ts';

function memoryRepository() {
  const records = new Map<string, McpTokenRecord>();
  const repository: McpTokenRepository = {
    async create(id, record) {
      records.set(id, record);
    },
    async get(id) {
      return records.get(id) ?? null;
    },
    async list(uid) {
      return [...records.entries()]
        .filter(([, r]) => r.ownerUid === uid)
        .map(([id, record]) => ({ id, ...record }));
    },
    async revoke(uid, id, now) {
      const row = records.get(id);
      if (!row || row.ownerUid !== uid) return false;
      records.set(id, { ...row, revoked: true, revokedAt: now });
      return true;
    },
  };
  return { records, repository };
}

test('Token service stores only hashes and binds listing and revocation to the signed-in owner', async () => {
  const { records, repository } = memoryRepository();
  const service = createTokenService(repository, () => 1_000);
  const alice = await service.issue('alice', { name: 'Reader', scopes: ['maps:read'], days: 30 });
  assert.match(alice.token, /^antty_[A-Za-z0-9_-]{43}$/);
  assert.equal(records.has(tokenHash(alice.token)), true);
  assert.equal(JSON.stringify([...records.values()]).includes(alice.token), false);
  assert.equal((await service.authenticate(alice.token)).uid, 'alice');
  assert.equal((await service.list('bob')).length, 0);
  assert.equal('token' in (await service.list('alice'))[0], false);
  await assert.rejects(service.revoke('bob', alice.id), /not found/i);
  assert.equal((await service.authenticate(alice.token)).uid, 'alice');
  await service.revoke('alice', alice.id);
  await assert.rejects(service.authenticate(alice.token), /revoked/i);
});

test('Token service rejects plaintext/hash impersonation, missing tokens, invalid owners, and expired tokens', async () => {
  const { repository } = memoryRepository();
  let now = 1_000;
  const service = createTokenService(repository, () => now);
  const token = await service.issue('alice', { name: 'Reader', scopes: ['maps:read'], days: 1 });
  await assert.rejects(service.authenticate(token.id));
  await assert.rejects(service.authenticate('antty_' + 'x'.repeat(43)));
  await assert.rejects(service.issue('../bob', { name: 'Reader', scopes: ['maps:read'], days: 1 }));
  now += 86_400_000;
  await assert.rejects(service.authenticate(token.token), /expired/i);
});

test('Configuration and host/origin protection fail closed without enabling cross-origin or DNS rebinding', () => {
  const env = {
    ANTTY_MCP_ENABLED: 'true',
    ANTTY_APP_ORIGIN: 'https://antty.example',
    FIREBASE_PROJECT_ID: 'test-project',
  };
  const config = getMcpConfig(env);
  for (const missing of ['ANTTY_MCP_ENABLED', 'ANTTY_APP_ORIGIN', 'FIREBASE_PROJECT_ID'])
    assert.throws(() => getMcpConfig({ ...env, [missing]: '' }));
  assert.doesNotThrow(() => assertMcpRequestOrigin({ host: 'antty.example' }, config, false));
  assert.doesNotThrow(() =>
    assertMcpRequestOrigin(
      { host: 'antty.example', origin: 'https://antty.example' },
      config,
      true,
    ),
  );
  for (const headers of [
    { host: 'evil.example' },
    { host: 'antty.example', origin: 'https://evil.example' },
    { host: 'antty.example', origin: 'null' },
  ])
    assert.throws(() => assertMcpRequestOrigin(headers, config, false));
  assert.throws(() => assertMcpRequestOrigin({ host: 'antty.example' }, config, true));
  assert.throws(() => getMcpConfig({ ...env, ANTTY_APP_ORIGIN: 'https://antty.example/path' }));
  assert.throws(() => getMcpConfig({ ...env, ANTTY_APP_ORIGIN: 'http://antty.example' }));
});

test('Request JSON is bounded both before and after platform parsing', async () => {
  const req = (chunks: string[], body?: unknown) =>
    Object.assign(Readable.from(chunks), { headers: { 'content-type': 'application/json' }, body });
  assert.deepEqual(await readBoundedJson(req(['{"ok":true}']), 32), { ok: true });
  await assert.rejects(readBoundedJson(req(['x'.repeat(33)]), 32), /large/i);
  await assert.rejects(readBoundedJson(req([], { key: 'x'.repeat(33) }), 32), /large/i);
  await assert.rejects(readBoundedJson(req(['{bad}']), 32), /JSON/i);
  await assert.rejects(
    readBoundedJson(Object.assign(req(['{}']), { headers: { 'content-type': 'text/plain' } }), 32),
    /JSON/i,
  );
});

test('The local pre-auth limiter bounds abuse and resets after its window', () => {
  const limiter = new LocalRateLimiter(2, 1000);
  limiter.consume('ip', 0);
  limiter.consume('ip', 0);
  assert.throws(() => limiter.consume('ip', 999), /rate/i);
  assert.doesNotThrow(() => limiter.consume('ip', 1000));
});

test('Token listing bounds a page and validates pagination cursors before storage reads', async () => {
  const { repository, records } = memoryRepository();
  for (let i = 0; i < 60; i++)
    records.set(i.toString(16).padStart(64, '0'), {
      ownerUid: 'alice',
      name: 'reader',
      scopes: ['maps:read'],
      createdAt: i,
      expiresAt: 1_000_000,
      revoked: false,
    });
  const service = createTokenService(repository, () => 1_000);
  assert.equal((await service.list('alice')).length, 51);
  await assert.rejects(service.list('alice', '../bob'));
});

test('Each PAT authentication rechecks Firebase account existence and revocation', async () => {
  const { createMcpAuthenticator } = await import('../server/mcpTokens.ts');
  const { repository } = memoryRepository();
  const service = createTokenService(repository, () => 2_000);
  const token = await service.issue('alice', { name: 'Reader', scopes: ['maps:read'], days: 1 });
  let account: { disabled: boolean; tokensValidAfterTime?: string } | null = { disabled: false };
  const authenticate = createMcpAuthenticator(
    repository,
    async (uid) => {
      assert.equal(uid, 'alice');
      if (account === null) throw new Error('User not found');
      return account;
    },
    () => 3_000,
  );
  assert.equal((await authenticate(token.token)).uid, 'alice');
  account = { disabled: true };
  await assert.rejects(authenticate(token.token), /revoked/i);
  account = { disabled: false, tokensValidAfterTime: '1970-01-01T00:00:03Z' };
  await assert.rejects(authenticate(token.token), /revoked/i);
  account = null;
  await assert.rejects(authenticate(token.token), /revoked/i);
});

test('PAT authentication preserves wrapped backend credential outages as 503', async () => {
  const { createMcpAuthenticator } = await import('../server/mcpTokens.ts');
  const { repository } = memoryRepository();
  const token = await createTokenService(repository, () => 2000).issue('alice', {
    name: 'Reader',
    scopes: ['maps:read'],
    days: 1,
  });
  const authenticate = createMcpAuthenticator(
    repository,
    async () => {
      throw Object.assign(new Error('provider detail must not escape'), {
        code: 'app/invalid-credential',
        cause: { status: 503 },
      });
    },
    () => 3000,
  );
  await assert.rejects(authenticate(token.token), (error) => {
    assert.equal((error as { status: number }).status, 503);
    assert.equal((error as Error).message, 'Backend credentials unavailable');
    return true;
  });
});
