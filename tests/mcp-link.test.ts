import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import {
  createMcpLinkService,
  getMcpLinkConfig,
  validateLinkAttempt,
  type LinkAttempt,
  type LinkRepository,
} from '../server/mcpLink.ts';
import { createLinkIdentityVerifier } from '../server/mcpLinkProvider.ts';
import { oauthBindingId, type McpOAuthBinding, type McpOAuthConfig } from '../server/mcpOAuth.ts';

const NOW = 1_800_000_000_000;
const oauth: McpOAuthConfig = {
  issuer: 'https://personal.auth0.com/',
  jwksUri: 'https://personal.auth0.com/.well-known/jwks.json',
  resource: 'https://antty.example/api/mcp',
  metadataUrl: 'https://antty.example/.well-known/oauth-protected-resource/api/mcp',
  clientIds: ['chatgpt-personal'],
  scopes: ['maps:read'] as ['maps:read'],
  algorithm: 'RS256' as const,
};
const config = getMcpLinkConfig(oauth, {
  ANTTY_MCP_LINK_ENABLED: 'true',
  ANTTY_MCP_LINK_CLIENT_ID: 'antty-link-public',
})!;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const identity = { uid: 'firebase-alice', authTime: NOW - 1000 };
function fixture() {
  const attempts = new Map<string, LinkAttempt>();
  const bindings = new Map<string, McpOAuthBinding>();
  let clock = NOW;
  let account = { disabled: false, tokensValidAfterTime: new Date(NOW - 60_000).toISOString() };
  let exchanges = 0;
  let revocationEpoch = 'e'.repeat(43);
  const repository: LinkRepository = {
    async put(id, row) {
      attempts.set(id, { ...row, revocationEpoch });
    },
    async take(id, browserHash, fingerprint, now) {
      const row = validateLinkAttempt(attempts.get(id), browserHash, fingerprint, now);
      attempts.delete(id);
      return row;
    },
    async bind(id, row, attempt) {
      if (attempt.revocationEpoch !== revocationEpoch)
        throw Object.assign(new Error('Revoked link'), { status: 400 });
      const old = bindings.get(id);
      if (old && old.ownerUid !== row.ownerUid)
        throw Object.assign(new Error('collision'), { status: 409 });
      bindings.set(id, row);
    },
    async list(uid) {
      return [...bindings.entries()]
        .filter(([, row]) => row.ownerUid === uid)
        .map(([id, row]) => ({
          id,
          subject: row.subject,
          expiresAt: row.expiresAt,
          enabled: row.enabled,
        }));
    },
    async revoke(uid, id) {
      if (bindings.get(id)?.ownerUid !== uid)
        throw Object.assign(new Error('missing'), { status: 404 });
      bindings.delete(id);
      revocationEpoch = 'f'.repeat(43);
    },
  };
  const service = createMcpLinkService(config, {
    repository,
    now: () => clock,
    getAccount: async () => account,
    async exchange(code, verifier, nonce) {
      exchanges++;
      assert.equal(code, 'code');
      assert.match(verifier, /^[\w-]{43}$/);
      assert.match(nonce, /^[\w-]{43}$/);
      return 'auth0|alice';
    },
  });
  return {
    service,
    attempts,
    bindings,
    setClock: (value: number) => {
      clock = value;
    },
    setAccount: (value: typeof account) => {
      account = value;
    },
    exchanges: () => exchanges,
  };
}
const status = (expected: number) => (error: unknown) =>
  (error as { status: number }).status === expected;

test('link configuration is opt-in, pins Auth0 endpoints and separates the two OAuth clients', () => {
  assert.equal(getMcpLinkConfig(oauth, {}), null);
  assert.equal(config.callbackUrl, 'https://antty.example/api/mcp-link?action=callback');
  for (const invalid of [
    { ...oauth, clientIds: ['one', 'two'] },
    { ...oauth, issuer: 'https://personal.auth0.com/unexpected/' },
    { ...oauth, scopes: ['boards:read'] as McpOAuthConfig['scopes'] },
  ])
    assert.throws(
      () =>
        getMcpLinkConfig(invalid, {
          ANTTY_MCP_LINK_ENABLED: 'true',
          ANTTY_MCP_LINK_CLIENT_ID: 'antty-link-public',
        }),
      status(503),
    );
  assert.throws(
    () =>
      getMcpLinkConfig(oauth, {
        ANTTY_MCP_LINK_ENABLED: 'true',
        ANTTY_MCP_LINK_CLIENT_ID: 'chatgpt-personal',
      }),
    status(503),
  );
});

test('link creates a nonce-bound S256 request without API/refresh scopes and only a seven-day maps:read binding', async () => {
  const f = fixture();
  const start = await f.service.begin(identity);
  const url = new URL(start.authorizationUrl);
  const state = url.searchParams.get('state')!;
  const row = f.attempts.get(hash(state))!;
  assert.equal(url.origin, 'https://personal.auth0.com');
  assert.equal(url.searchParams.get('scope'), 'openid');
  assert.equal(url.searchParams.get('prompt'), 'login');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(
    url.searchParams.get('code_challenge'),
    createHash('sha256').update(row.verifier).digest('base64url'),
  );
  assert.equal(url.searchParams.get('nonce'), row.nonce);
  assert.equal(row.browserHash, hash(start.browserSecret));
  assert.equal(row.expiresAt, NOW + 300_000);
  await f.service.complete({
    state,
    browserSecret: start.browserSecret,
    issuer: oauth.issuer,
    code: 'code',
  });
  const binding = f.bindings.get(oauthBindingId(oauth.issuer, 'auth0|alice'))!;
  assert.equal(binding.ownerUid, identity.uid);
  assert.deepEqual(binding.scopes, ['maps:read']);
  assert.deepEqual(binding.clientIds, ['chatgpt-personal']);
  assert.equal(binding.firebaseAuthTime, identity.authTime);
  assert.equal(binding.expiresAt, NOW + 7 * 86_400_000);
  assert.equal(binding.validAfter, NOW);
  await assert.rejects(
    f.service.complete({
      state,
      browserSecret: start.browserSecret,
      issuer: oauth.issuer,
      code: 'code',
    }),
    status(400),
  );
  assert.equal(f.exchanges(), 1);
});

test('cross-browser, mixed issuer and config rotation fail before exchanging a code', async () => {
  const f = fixture();
  const start = await f.service.begin(identity);
  const state = new URL(start.authorizationUrl).searchParams.get('state')!;
  await assert.rejects(
    f.service.complete({
      state,
      browserSecret: 'x'.repeat(43),
      issuer: oauth.issuer,
      code: 'code',
    }),
    status(400),
  );
  await assert.rejects(
    f.service.complete({
      state,
      browserSecret: start.browserSecret,
      issuer: 'https://attacker.example/',
      code: 'code',
    }),
    status(400),
  );
  const row = f.attempts.get(hash(state))!;
  f.attempts.set(hash(state), { ...row, fingerprint: 'old-config' });
  await assert.rejects(
    f.service.complete({
      state,
      browserSecret: start.browserSecret,
      issuer: oauth.issuer,
      code: 'code',
    }),
    status(400),
  );
  assert.equal(f.exchanges(), 0);
});

test('stale/future Firebase auth and disabled/revoked accounts cannot link; callback rechecks revocation', async () => {
  for (const authTime of [NOW - 300_001, NOW + 1, NaN]) {
    await assert.rejects(fixture().service.begin({ ...identity, authTime }), status(401));
  }
  const f = fixture();
  const start = await f.service.begin(identity);
  f.setAccount({ disabled: false, tokensValidAfterTime: new Date(NOW).toISOString() });
  await assert.rejects(
    f.service.complete({
      state: new URL(start.authorizationUrl).searchParams.get('state')!,
      browserSecret: start.browserSecret,
      issuer: oauth.issuer,
      code: 'code',
    }),
    status(401),
  );
  assert.equal(f.bindings.size, 0);
  assert.equal(f.exchanges(), 0);
  f.setAccount({ disabled: true, tokensValidAfterTime: new Date(NOW - 60_000).toISOString() });
  await assert.rejects(f.service.begin(identity), status(401));
});

test('expired callbacks fail and provider identity can never move between Firebase owners', async () => {
  const f = fixture();
  const first = await f.service.begin(identity);
  f.setClock(NOW + 300_000);
  await assert.rejects(
    f.service.complete({
      state: new URL(first.authorizationUrl).searchParams.get('state')!,
      browserSecret: first.browserSecret,
      issuer: oauth.issuer,
      code: 'code',
    }),
    status(400),
  );
  f.setClock(NOW);
  const link = async (uid: string) => {
    const start = await f.service.begin({ ...identity, uid });
    return f.service.complete({
      state: new URL(start.authorizationUrl).searchParams.get('state')!,
      browserSecret: start.browserSecret,
      issuer: oauth.issuer,
      code: 'code',
    });
  };
  await link(identity.uid);
  await assert.rejects(link('firebase-bob'), status(409));
  assert.equal([...f.bindings.values()][0].ownerUid, identity.uid);
});

let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let key: ReturnType<typeof createLocalJWKSet>;
before(async () => {
  keys = await generateKeyPair('RS256');
  key = createLocalJWKSet({
    keys: [{ ...(await exportJWK(keys.publicKey)), kid: 'link-fixture' }],
  });
});
test('OIDC proof checks signature, ID-token type, nonce, original auth time and linking client audience', async () => {
  const verify = createLinkIdentityVerifier(config, key, () => NOW);
  const payload = {
    iss: oauth.issuer,
    sub: 'auth0|alice',
    aud: config.clientId,
    nonce: 'nonce',
    iat: NOW / 1000,
    exp: NOW / 1000 + 300,
    auth_time: NOW / 1000,
    email: 'irrelevant@example.com',
    uid: 'firebase-victim',
  };
  const sign = (patch = {}, header = {}) =>
    new SignJWT({ ...payload, ...patch })
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT', kid: 'link-fixture', ...header })
      .sign(keys.privateKey);
  assert.equal(await verify(await sign(), 'nonce'), 'auth0|alice');
  for (const patch of [
    { nonce: 'other' },
    { aud: oauth.resource },
    { aud: [config.clientId, 'other'] },
    { auth_time: NOW / 1000 - 301 },
    { auth_time: NOW / 1000 + 1 },
    { iss: 'https://evil.example/' },
    { sub: '' },
    { exp: NOW / 1000 },
  ]) {
    await assert.rejects(verify(await sign(patch), 'nonce'), status(401));
  }
  for (const header of [
    { typ: 'at+jwt' },
    { jku: 'https://evil.example/key' },
    { jwk: await exportJWK(keys.publicKey) },
  ])
    await assert.rejects(verify(await sign({}, header), 'nonce'), status(401));
});
