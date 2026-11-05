import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { listenForFetch } from './fixtures/listen-fetch.ts';
import { createFirebaseOAuthHandler } from '../api/mcp-auth.ts';
import { oauthFixture, settings } from './fixtures/firebase-oauth.ts';

test('OAuth HTTP serves discovery and bounded public token exchange while requiring browser origin for consent', async () => {
  const f = oauthFixture();
  let quota = 0;
  const handler = createFirebaseOAuthHandler({
    config: () => f.config,
    service: () => f.service,
    authenticate: async () => f.identity,
    quota: async () => {
      quota++;
    },
  });
  const server = createServer((req, res) => {
    req.headers.host = settings.host;
    void handler(req, res);
  });
  const base = await listenForFetch(server);
  try {
    const metadata = await fetch(`${base}/oauth/metadata`);
    const body = await metadata.json();
    assert.deepEqual(body.code_challenge_methods_supported, ['S256']);
    assert.deepEqual(body.token_endpoint_auth_methods_supported, ['none']);
    assert.equal(body.issuer, settings.origin);
    assert.equal('registration_endpoint' in body, false);
    assert.equal(
      (await fetch(`${base}/oauth/metadata`, { headers: { Origin: 'https://chatgpt.com' } }))
        .status,
      200,
    );
    const invalid = await fetch(`${base}/oauth/authorize?client_id=evil`, { redirect: 'manual' });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.headers.get('location'), null);
    const start = await fetch(`${base}/oauth/authorize?${f.parameters}`, { redirect: 'manual' });
    assert.equal(start.status, 303);
    const cookie = start.headers.get('set-cookie')!;
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /Secure/);
    const location = new URL(start.headers.get('location')!);
    assert.equal(location.pathname, '/mcp/consent');
    const id = location.searchParams.get('request')!;
    const headers = { 'Content-Type': 'application/json', Cookie: cookie.split(';')[0] };
    const refused = await fetch(`${base}/oauth/consent`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ request: id, approve: true }),
    });
    assert.equal(refused.status, 403);
    const details = await fetch(`${base}/oauth/consent?request=${id}`, {
      headers: { ...headers, Origin: settings.origin },
    });
    assert.equal(details.status, 200);
    const approve = await fetch(`${base}/oauth/consent`, {
      method: 'POST',
      headers: { ...headers, Origin: settings.origin },
      body: JSON.stringify({ request: id, approve: true }),
    });
    const redirect = new URL((await approve.json()).redirectUri);
    const code = redirect.searchParams.get('code')!;
    const missing = await fetch(`${base}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(missing.status, 415);
    const duplicated = await fetch(`${base}/oauth/token`, {
      method: 'POST',
      body: new URLSearchParams({ client_id: 'x', grant_type: 'authorization_code' }),
    });
    assert.equal(duplicated.status, 400);
    const token = await f.exchange(code);
    assert.equal((await f.service.authenticate(token.access_token)).uid, 'alice');
    assert.ok(quota >= 3);
    assert.equal(approve.headers.get('cache-control'), 'no-store');
    assert.equal(approve.headers.get('referrer-policy'), 'no-referrer');
    const oversized = await fetch(`${base}/oauth/token`, {
      method: 'POST',
      body: new URLSearchParams({ code: 'x'.repeat(9000) }),
    });
    assert.equal(oversized.status, 413);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
