import test from 'node:test';
import assert from 'node:assert/strict';
import { getFirebaseOAuthConfig } from '../server/mcpFirebaseOAuth.ts';
import { NOW, settings, env, oauthFixture } from './fixtures/firebase-oauth.ts';
import { createFirebaseOAuthService } from '../server/mcpFirebaseOAuth.ts';
import { memoryOAuthRepository } from './fixtures/firebase-oauth.ts';
import { getMcpLinkConfig } from '../server/mcpLink.ts';

const rejects = (work: Promise<unknown>, error = 'invalid_grant') =>
  assert.rejects(work, (failure: unknown) => (failure as { error: string }).error === error);

test('Firebase OAuth is opt-in, fixed public clients only, and mutually exclusive with managed OAuth', () => {
  assert.equal(getFirebaseOAuthConfig(settings, {}), null);
  assert.equal(
    getMcpLinkConfig(null, {
      ANTTY_MCP_FIREBASE_OAUTH_ENABLED: 'true',
      ANTTY_MCP_LINK_ENABLED: 'true',
    }),
    null,
  );
  for (const patch of [
    { ANTTY_MCP_FIREBASE_OAUTH_CLIENTS: '[]' },
    {
      ANTTY_MCP_FIREBASE_OAUTH_CLIENTS: env.ANTTY_MCP_FIREBASE_OAUTH_CLIENTS.replace(
        'https:',
        'http:',
      ),
    },
    { ANTTY_MCP_OAUTH_ENABLED: 'true' },
    { ANTTY_MCP_FIREBASE_OAUTH_SCOPES: 'admin' },
  ])
    assert.throws(() => getFirebaseOAuthConfig(settings, { ...env, ...patch }));
});

test('later scope ceilings can support CRUD but never broaden existing consent or bypass token audience checks', async () => {
  const repository = memoryOAuthRepository();
  const f = oauthFixture(repository);
  const { code } = await f.approve();
  const token = await f.exchange(code);
  const broad = getFirebaseOAuthConfig(settings, {
    ...env,
    ANTTY_MCP_FIREBASE_OAUTH_SCOPES:
      'maps:read maps:write boards:read boards:write calendar:read calendar:write',
  })!;
  const service = createFirebaseOAuthService(broad, {
    repository,
    now: () => NOW,
    getAccount: async () => ({ disabled: false }),
  });
  assert.deepEqual((await service.authenticate(token.access_token)).scopes, ['maps:read']);
  const narrowed = createFirebaseOAuthService(
    { ...broad, scopes: ['boards:read'] },
    { repository, now: () => NOW, getAccount: async () => ({ disabled: false }) },
  );
  await assert.rejects(
    narrowed.authenticate(token.access_token),
    (e: unknown) => (e as { status: number }).status === 401,
  );
  const other = createFirebaseOAuthService(
    { ...broad, resource: 'https://other.example/api/mcp' },
    { repository, now: () => NOW, getAccount: async () => ({ disabled: false }) },
  );
  await assert.rejects(
    other.authenticate(token.access_token),
    (e: unknown) => (e as { status: number }).status === 401,
  );
  await assert.rejects(
    service.authenticate('synthetic-firebase-id-token'),
    (e: unknown) => (e as { status: number }).status === 401,
  );
});

test('authenticated code reuse revokes only its grant and does not disable a sibling connection', async () => {
  const f = oauthFixture();
  const a = await f.approve(),
    b = await f.approve();
  const ta = await f.exchange(a.code),
    tb = await f.exchange(b.code);
  await rejects(f.exchange(a.code));
  await assert.rejects(f.service.authenticate(ta.access_token));
  assert.equal((await f.service.authenticate(tb.access_token)).uid, 'alice');
});

test('Firebase consent produces only a resource-bound scoped MCP token, never a Firebase token or refresh token', async () => {
  const f = oauthFixture();
  const { code } = await f.approve();
  const result = await f.exchange(code);
  assert.equal(result.token_type, 'Bearer');
  assert.equal(result.expires_in, 3600);
  assert.equal(result.scope, 'maps:read');
  assert.equal('refresh_token' in result, false);
  const principal = await f.service.authenticate(result.access_token);
  assert.equal(principal.uid, 'alice');
  assert.deepEqual(principal.scopes, ['maps:read']);
  assert.equal((await f.service.list('bob')).length, 0);
});

test('authorize rejects broad scopes, ambiguous parameters, unsafe redirects, absent resource and plain PKCE', async () => {
  for (const patch of [
    { scope: 'maps:read maps:write' },
    { redirect_uri: 'https://evil.example/callback' },
    { resource: '' },
    { code_challenge_method: 'plain' },
    { response_type: 'token' },
    { client_id: 'other' },
    { code_challenge: 'short' },
  ]) {
    const f = oauthFixture();
    Object.entries(patch).forEach(([k, v]) => f.parameters.set(k, v));
    await assert.rejects(f.service.begin(f.parameters));
  }
  const f = oauthFixture();
  f.parameters.append('client_id', 'other');
  await assert.rejects(f.service.begin(f.parameters));
});

test('consent pins browser and UID, requires recent proof, expires and cannot be repeated', async () => {
  const f = oauthFixture();
  const p = await f.begin();
  await rejects(f.service.details({ ...f.identity, uid: 'bob' }, p.id, p.browserSecret));
  await rejects(f.service.decide(f.identity, p.id, 'wrong', true));
  await rejects(
    f.service.decide({ ...f.identity, authTime: NOW - 301_000 }, p.id, p.browserSecret, true),
    'login_required',
  );
  await f.service.decide(f.identity, p.id, p.browserSecret, true);
  await rejects(f.service.decide(f.identity, p.id, p.browserSecret, true));
  const expired = await f.begin();
  f.state.now += 301_000;
  await rejects(
    f.service.decide(
      { ...f.identity, authTime: f.state.now },
      expired.id,
      expired.browserSecret,
      true,
    ),
  );
});

test('wrong PKCE/client/redirect/resource does not consume the valid code; concurrent exchange succeeds once', async () => {
  const f = oauthFixture();
  const { code } = await f.approve();
  const patches: Record<string, string>[] = [
    { code_verifier: 'x'.repeat(43) },
    { client_id: 'other' },
    { redirect_uri: 'https://evil.example/' },
    { resource: 'https://elsewhere.example/mcp' },
  ];
  for (const patch of patches) await rejects(f.exchange(code, patch));
  const results = await Promise.allSettled([f.exchange(code), f.exchange(code)]);
  assert.equal(results.filter((x) => x.status === 'fulfilled').length, 1);
});

test('cancel returns access_denied with original state; expired code, token and disabled account fail closed', async () => {
  const f = oauthFixture();
  const p = await f.begin();
  const result = await f.service.decide(f.identity, p.id, p.browserSecret, false);
  const url = new URL(result.redirectUri);
  assert.equal(url.searchParams.get('error'), 'access_denied');
  assert.equal(url.searchParams.get('state'), 'client-state');
  const { code } = await f.approve();
  f.state.now += 61_000;
  await rejects(f.exchange(code));
  f.state.now = NOW;
  const next = await f.approve();
  const token = await f.exchange(next.code);
  f.state.disabled = true;
  await assert.rejects(f.service.authenticate(token.access_token));
  f.state.disabled = false;
  f.state.cutoff = NOW + 1;
  await assert.rejects(f.service.authenticate(token.access_token));
  f.state.cutoff = NOW - 120_000;
  f.state.now += 3_600_001;
  await assert.rejects(f.service.authenticate(token.access_token));
});

test('owner revoke invalidates code/token and outstanding consent without exposing or revoking another owner', async () => {
  const f = oauthFixture();
  const first = await f.approve();
  const token = await f.exchange(first.code);
  const outstanding = await f.begin();
  const [grant] = await f.service.list('alice');
  await rejects(f.service.revoke('bob', grant.id));
  await f.service.revoke('alice', grant.id);
  await assert.rejects(f.service.authenticate(token.access_token));
  await rejects(f.service.decide(f.identity, outstanding.id, outstanding.browserSecret, true));
  const second = await f.approve();
  const grants = await f.service.list('alice');
  const active = grants.find((x) => x.enabled)!;
  await f.service.revoke('alice', active.id);
  await rejects(f.exchange(second.code));
});
