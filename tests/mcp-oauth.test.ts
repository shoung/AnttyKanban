import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import {
  createMcpOAuthAuthenticator,
  getMcpOAuthConfig,
  oauthBindingId,
  type McpOAuthBinding,
} from '../server/mcpOAuth.ts';

const NOW = 1_800_000_000_000;
const settings = { origin: 'https://antty.example', host: 'antty.example' };
const env = {
  ANTTY_MCP_OAUTH_ENABLED: 'true',
  ANTTY_MCP_OAUTH_ISSUER: 'https://identity.example/tenant/',
  ANTTY_MCP_OAUTH_JWKS_URI: 'https://identity.example/tenant/.well-known/jwks.json',
  ANTTY_MCP_OAUTH_CLIENT_IDS: '["chatgpt-test"]',
  ANTTY_MCP_OAUTH_SCOPES: 'maps:read boards:read',
};
const config = () => getMcpOAuthConfig(settings, env)!;
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let otherKeys: Awaited<ReturnType<typeof generateKeyPair>>;
let jwks: ReturnType<typeof createLocalJWKSet>;
before(async () => {
  keys = await generateKeyPair('RS256');
  otherKeys = await generateKeyPair('RS256');
  jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(keys.publicKey)), kid: 'fixture' }] });
});
const claims = (): JWTPayload => ({
  iss: 'https://identity.example/tenant/',
  aud: 'https://antty.example/api/mcp',
  sub: 'provider|alice',
  client_id: 'chatgpt-test',
  jti: 'fixture-jti',
  scope: 'boards:read maps:read',
  iat: NOW / 1000 - 10,
  exp: NOW / 1000 + 300,
});
async function token(overrides: JWTPayload = {}, header: Record<string, unknown> = {}) {
  return new SignJWT({ ...claims(), ...overrides })
    .setProtectedHeader({ alg: 'RS256', kid: 'fixture', typ: 'at+jwt', ...header })
    .sign(keys.privateKey);
}
function binding(): McpOAuthBinding {
  return {
    schemaVersion: 1,
    issuer: 'https://identity.example/tenant/',
    subject: 'provider|alice',
    ownerUid: 'firebase-alice',
    clientIds: ['chatgpt-test'],
    scopes: ['boards:read', 'maps:read'],
    enabled: true,
    firebaseAuthTime: NOW - 60_000,
    validAfter: NOW - 60_000,
    expiresAt: NOW + 86_400_000,
  };
}
function fixture() {
  const state = {
    row: binding() as unknown,
    user: { disabled: false, tokensValidAfterTime: new Date(NOW - 120_000).toISOString() },
    requestedBinding: '',
    requestedUid: '',
    accountCalls: 0,
  };
  const authenticate = createMcpOAuthAuthenticator(config(), {
    key: jwks,
    bindings: {
      async get(id) {
        state.requestedBinding = id;
        return state.row;
      },
    },
    async getAccount(uid) {
      state.accountCalls++;
      state.requestedUid = uid;
      return state.user;
    },
    now: () => NOW,
  });
  return { state, authenticate };
}
const unauthorized = (error: unknown) => {
  assert.equal((error as { status: number }).status, 401);
  assert.equal((error as Error).message, 'Invalid or unavailable OAuth access');
  return true;
};

test('OAuth stays off unless explicitly enabled and enabled configuration pins the resource', () => {
  assert.equal(getMcpOAuthConfig(settings, {}), null);
  assert.equal(getMcpOAuthConfig(settings, { ANTTY_MCP_OAUTH_ENABLED: 'false' }), null);
  assert.equal(config().resource, 'https://antty.example/api/mcp');
  assert.equal(
    config().metadataUrl,
    'https://antty.example/.well-known/oauth-protected-resource/api/mcp',
  );
  for (const patch of [
    { ANTTY_MCP_OAUTH_ISSUER: '' },
    { ANTTY_MCP_OAUTH_ISSUER: 'http://identity.example/' },
    { ANTTY_MCP_OAUTH_ISSUER: 'https://user:password@identity.example/' },
    { ANTTY_MCP_OAUTH_ISSUER: 'https://identity.example/?unexpected=1' },
    { ANTTY_MCP_OAUTH_ISSUER: 'https://localhost/' },
    { ANTTY_MCP_OAUTH_ISSUER: 'https://127.0.0.1/' },
    { ANTTY_MCP_OAUTH_JWKS_URI: 'https://unrelated.example/jwks' },
    { ANTTY_MCP_OAUTH_JWKS_URI: 'https://identity.example/jwks#fragment' },
    { ANTTY_MCP_OAUTH_CLIENT_IDS: '[]' },
    { ANTTY_MCP_OAUTH_CLIENT_IDS: '["chatgpt-test","chatgpt-test"]' },
    { ANTTY_MCP_OAUTH_SCOPES: 'boards:read admin:all' },
    { ANTTY_MCP_OAUTH_SCOPES: 'boards:read boards:read' },
    { ANTTY_MCP_OAUTH_ALGORITHM: 'HS256' },
  ])
    assert.throws(() => getMcpOAuthConfig(settings, { ...env, ...patch }), { status: 503 });
});

test('verified OAuth subject resolves only its server binding, never email or token UID', async () => {
  const { state, authenticate } = fixture();
  const principal = await authenticate(
    await token({ uid: 'firebase-bob', email: 'bob@example.test' }),
  );
  assert.deepEqual(principal, {
    uid: 'firebase-alice',
    scopes: ['boards:read', 'maps:read'],
    tokenIssuedAt: NOW - 10_000,
    authentication: 'oauth',
  });
  assert.equal(state.requestedUid, 'firebase-alice');
  assert.match(state.requestedBinding, /^[a-f0-9]{64}$/);
  assert.notEqual(
    oauthBindingId('https://identity.example/tenant/', 'a:b'),
    oauthBindingId('https://identity.example/tenant/:a', 'b'),
  );
  state.row = null;
  await assert.rejects(
    authenticate(await token({ sub: 'provider|bob', email: 'bob@example.test' })),
    unauthorized,
  );
  assert.equal(state.accountCalls, 1);
});

test('signature, issuer, audience and JWT access-token type are verified before any account access', async () => {
  const { state, authenticate } = fixture();
  for (const overrides of [
    { iss: 'https://attacker.example/' },
    { aud: 'chatgpt-test' },
    { aud: ['https://other.example/mcp', 'chatgpt-test'] },
    { sub: '' },
    { client_id: 'unapproved-client' },
    { client_id: undefined },
    { jti: undefined },
    { exp: undefined },
    { iat: undefined },
  ])
    await assert.rejects(authenticate(await token(overrides)), unauthorized);
  for (const header of [
    { typ: 'JWT' },
    { typ: undefined },
    { jku: 'https://attacker.example/key' },
    { x5u: 'https://attacker.example/cert' },
  ]) {
    await assert.rejects(authenticate(await token({}, header)), unauthorized);
  }
  const forged = await new SignJWT(claims())
    .setProtectedHeader({ alg: 'RS256', kid: 'fixture', typ: 'at+jwt' })
    .sign(otherKeys.privateKey);
  await assert.rejects(authenticate(forged), unauthorized);
  const symmetric = await new SignJWT(claims())
    .setProtectedHeader({ alg: 'HS256', typ: 'at+jwt' })
    .sign(new Uint8Array(32));
  await assert.rejects(authenticate(symmetric), unauthorized);
  await assert.rejects(authenticate('not.a.jwt'), unauthorized);
  assert.equal(state.accountCalls, 0);
});

test('OAuth tokens reject expiry, future issue times and excessive lifetimes', async () => {
  const { authenticate } = fixture();
  for (const overrides of [
    { exp: NOW / 1000 },
    { iat: NOW / 1000 + 1 },
    { iat: NOW / 1000 - 3601 },
    { exp: NOW / 1000 + 3600 },
    { iat: NOW / 1000 - 0.5 },
    { exp: NOW / 1000 + 0.5 },
    { nbf: NOW / 1000 + 1 },
  ])
    await assert.rejects(authenticate(await token(overrides)), unauthorized);
});

test('OAuth scopes are bounded by configured resource scopes and current explicit binding consent', async () => {
  const { state, authenticate } = fixture();
  for (const scope of [
    '',
    'boards:write',
    'admin:all',
    'boards:read boards:read',
    'boards:read\tmaps:read',
  ]) {
    await assert.rejects(authenticate(await token({ scope })), unauthorized);
  }
  await assert.rejects(authenticate(await token({ scope: ['boards:read'] })), unauthorized);
  state.row = { ...binding(), scopes: ['boards:read'] };
  const principal = await authenticate(await token());
  assert.deepEqual(principal.scopes, ['boards:read']);
  state.row = { ...binding(), scopes: ['maps:read'] };
  await assert.rejects(authenticate(await token({ scope: 'boards:read' })), unauthorized);
});

test('binding mismatches, revocation, expiry and client changes deny access on every request', async () => {
  const { state, authenticate } = fixture();
  const bearer = await token();
  await authenticate(bearer);
  for (const row of [
    null,
    {},
    { ...binding(), schemaVersion: 2 },
    { ...binding(), issuer: 'https://other.example/' },
    { ...binding(), subject: 'provider|bob' },
    { ...binding(), ownerUid: '../bob' },
    { ...binding(), enabled: false },
    { ...binding(), clientIds: ['someone-else'] },
    { ...binding(), validAfter: NOW },
    { ...binding(), expiresAt: NOW },
    { ...binding(), scopes: ['admin:all'] },
  ]) {
    state.row = row;
    await assert.rejects(authenticate(bearer), unauthorized);
  }
  assert.equal(state.accountCalls, 1);
});

test('OAuth rechecks Firebase disablement and token revocation without exposing account details', async () => {
  const { state, authenticate } = fixture();
  const bearer = await token();
  await authenticate(bearer);
  state.user.disabled = true;
  await assert.rejects(authenticate(bearer), unauthorized);
  state.user.disabled = false;
  state.user.tokensValidAfterTime = new Date(NOW).toISOString();
  await assert.rejects(authenticate(bearer), unauthorized);
  const missing = createMcpOAuthAuthenticator(config(), {
    key: jwks,
    bindings: {
      async get() {
        return binding();
      },
    },
    async getAccount() {
      throw Object.assign(new Error('firebase account not found: private detail'), {
        code: 'auth/user-not-found',
      });
    },
    now: () => NOW,
  });
  await assert.rejects(missing(bearer), unauthorized);
});

test('refreshing an OAuth token cannot bypass revocation of the original Firebase identity proof', async () => {
  const { state, authenticate } = fixture();
  state.user.tokensValidAfterTime = new Date(NOW - 5000).toISOString();
  // The provider minted this access token after Firebase revoked the session used for linking.
  await assert.rejects(authenticate(await token({ iat: NOW / 1000 - 1 })), unauthorized);
});

test('standard OIDC consent scopes never confer Antty permissions', async () => {
  const { authenticate } = fixture();
  const principal = await authenticate(
    await token({ scope: 'openid profile email offline_access boards:read' }),
  );
  assert.deepEqual(principal.scopes, ['boards:read']);
  await assert.rejects(authenticate(await token({ scope: 'openid profile email' })), unauthorized);
});

test('credential outages stay retryable without leaking provider or Firebase details', async () => {
  const { createMcpOAuthAuthenticator } = await import('../server/mcpOAuth.ts');
  const unavailable = createMcpOAuthAuthenticator(config(), {
    key: jwks,
    bindings: {
      async get() {
        return binding();
      },
    },
    async getAccount() {
      throw Object.assign(new Error('private service account detail'), {
        code: 'app/invalid-credential',
        cause: { status: 503 },
      });
    },
    now: () => NOW,
  });
  await assert.rejects(unavailable(await token()), {
    status: 503,
    message: 'OAuth verification is temporarily unavailable',
  });
});

test('remote verification fetches only pinned JWKS, caches public keys and rejects redirects and oversized responses', async () => {
  const { createMcpOAuthKeyResolver } = await import('../server/mcpOAuth.ts');
  const publicKeys = JSON.stringify({
    keys: [{ ...(await exportJWK(keys.publicKey)), kid: 'fixture' }],
  });
  let fetches = 0;
  const key = createMcpOAuthKeyResolver(config(), async (url, options) => {
    fetches++;
    assert.equal(url, 'https://identity.example/tenant/.well-known/jwks.json');
    assert.equal(options?.redirect, 'manual');
    assert.equal(new Headers(options?.headers).has('authorization'), false);
    return new Response(publicKeys, { status: 200 });
  });
  const auth = createMcpOAuthAuthenticator(config(), {
    key,
    bindings: {
      async get() {
        return binding();
      },
    },
    getAccount: async () => ({ disabled: false }),
    now: () => NOW,
  });
  const bearer = await token();
  assert.equal((await auth(bearer)).uid, 'firebase-alice');
  assert.equal((await auth(bearer)).uid, 'firebase-alice');
  assert.equal(fetches, 1);
  for (const response of [
    new Response(null, { status: 302, headers: { Location: 'https://attacker.example' } }),
    new Response('x'.repeat(131073), { status: 200 }),
    new Response('{invalid-json', { status: 200 }),
  ]) {
    const denied = createMcpOAuthAuthenticator(config(), {
      key: createMcpOAuthKeyResolver(config(), async () => response),
      bindings: {
        async get() {
          throw new Error('must not access bindings');
        },
      },
      getAccount: async () => ({ disabled: false }),
      now: () => NOW,
    });
    await assert.rejects(denied(bearer), {
      status: 503,
      message: 'OAuth verification is temporarily unavailable',
    });
  }
});

test('binding and account backend outages return sanitized retryable errors instead of relinking', async () => {
  const bearer = await token();
  for (const source of ['binding', 'account']) {
    for (const code of [14, 4, 'auth/internal-error', undefined]) {
      const outage = () => {
        throw Object.assign(new Error('private upstream detail'), { code });
      };
      const authenticate = createMcpOAuthAuthenticator(config(), {
        key: jwks,
        bindings: { get: async () => (source === 'binding' ? outage() : binding()) },
        getAccount: async () => (source === 'account' ? outage() : { disabled: false }),
        now: () => NOW,
      });
      await assert.rejects(authenticate(bearer), {
        status: 503,
        message: 'OAuth verification is temporarily unavailable',
      });
    }
  }
});
