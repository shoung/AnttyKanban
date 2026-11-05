import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createLinkCodeExchange } from '../server/mcpLinkProvider.ts';
import { getMcpLinkConfig } from '../server/mcpLink.ts';

const config = getMcpLinkConfig(
  {
    issuer: 'https://personal.auth0.com/',
    jwksUri: 'https://personal.auth0.com/.well-known/jwks.json',
    resource: 'https://antty.example/api/mcp',
    metadataUrl: '',
    scopes: ['maps:read'],
    clientIds: ['chatgpt-personal'],
    algorithm: 'RS256',
  },
  { ANTTY_MCP_LINK_ENABLED: 'true', ANTTY_MCP_LINK_CLIENT_ID: 'link-public' },
)!;
test('code exchange pins the token endpoint, submits PKCE without client secrets, and never stores refresh credentials', async () => {
  const pair = await generateKeyPair('RS256');
  const key = createLocalJWKSet({
    keys: [{ ...(await exportJWK(pair.publicKey)), kid: 'fixture' }],
  });
  const timestamp = Math.floor(Date.now() / 1000);
  const idToken = await new SignJWT({ nonce: 'nonce', auth_time: timestamp })
    .setProtectedHeader({ alg: 'RS256', kid: 'fixture', typ: 'JWT' })
    .setIssuer(config.oauth.issuer)
    .setSubject('auth0|alice')
    .setAudience(config.clientId)
    .setIssuedAt(timestamp)
    .setExpirationTime(timestamp + 60)
    .sign(pair.privateKey);
  const fetcher = (async (url: URL, init: RequestInit) => {
    assert.equal(url.href, 'https://personal.auth0.com/oauth/token');
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal);
    assert.deepEqual(Object.fromEntries(init.body as URLSearchParams), {
      grant_type: 'authorization_code',
      client_id: 'link-public',
      code: 'code',
      code_verifier: 'verifier',
      redirect_uri: config.callbackUrl,
    });
    return new Response(JSON.stringify({ id_token: idToken, access_token: 'discarded' }));
  }) as typeof fetch;
  assert.equal(
    await createLinkCodeExchange(config, fetcher, key)('code', 'verifier', 'nonce'),
    'auth0|alice',
  );
  for (const response of [
    new Response(JSON.stringify({ id_token: idToken, refresh_token: 'must-not-be-kept' })),
    new Response(JSON.stringify({ access_token: 'not-an-id-token' })),
    new Response('redirect', { status: 302 }),
    new Response('not-json'),
    new Response('x'.repeat(32_769)),
    new Response('', { headers: { 'content-length': '32769' } }),
  ]) {
    await assert.rejects(
      createLinkCodeExchange(config, (async () => response) as typeof fetch, key)(
        'code',
        'verifier',
        'nonce',
      ),
      (error: unknown) => (error as { status: number }).status === 503,
    );
  }
});
