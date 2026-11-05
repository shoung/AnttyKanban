import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type IncomingMessage } from 'node:http';
import { createMcpLinkHandler } from '../api/mcp-link.ts';
import type { McpLinkConfig } from '../server/mcpLink.ts';

test('link HTTP requires Firebase and same-origin consent; callback uses HttpOnly browser proof and fixed redirects', async () => {
  let origin = '',
    authentications = 0,
    starts = 0;
  const completions: unknown[] = [],
    revocations: unknown[] = [];
  let enabled = true;
  let paged = false;
  const oauth = {
    issuer: 'https://personal.auth0.com/',
    jwksUri: 'https://personal.auth0.com/.well-known/jwks.json',
    resource: '',
    metadataUrl: '',
    scopes: ['maps:read'] as ['maps:read'],
    clientIds: ['chatgpt-personal'],
    algorithm: 'RS256' as const,
  };
  const link: McpLinkConfig = { oauth, clientId: 'antty-link-public', callbackUrl: '' };
  const handler = createMcpLinkHandler({
    config: () => ({
      settings: { origin, host: new URL(origin).host },
      link: enabled ? link : null,
    }),
    async authenticate(req: IncomingMessage) {
      authentications++;
      if (req.headers.authorization !== 'Bearer firebase')
        throw Object.assign(new Error('Authentication required'), { status: 401 });
      return { uid: 'alice', authTime: 1000 };
    },
    async quota() {},
    service: () => ({
      async begin(identity) {
        starts++;
        assert.equal(identity.uid, 'alice');
        return {
          authorizationUrl: 'https://personal.auth0.com/authorize',
          browserSecret: 'b'.repeat(43),
        };
      },
      async complete(input) {
        assert.equal(input.browserSecret, 'b'.repeat(43));
        if (input.state === 'bad') throw new Error('secret provider error');
        completions.push(input);
      },
      async list(uid, after) {
        assert.equal(uid, 'alice');
        if (!paged) return [];
        const rows = Array.from({ length: 51 }, (_, i) => ({
          id: i.toString(16).padStart(64, '0'),
          subject: `synthetic-${i}`,
          expiresAt: 2000,
          enabled: true,
        }));
        return after ? rows.filter((row) => row.id > after) : rows;
      },
      async revoke(uid, id) {
        revocations.push([uid, id]);
      },
    }),
  });
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  oauth.resource = `${origin}/api/mcp`;
  const headers = {
    Authorization: 'Bearer firebase',
    Origin: origin,
    'Content-Type': 'application/json',
  };
  const request = (body: unknown, more: Record<string, string> = {}) =>
    fetch(origin, { method: 'POST', headers: { ...headers, ...more }, body: JSON.stringify(body) });
  try {
    assert.equal((await fetch(origin)).status, 401);
    assert.equal(
      (await request({ consent: true }, { Origin: 'https://attacker.example' })).status,
      403,
    );
    assert.equal(authentications, 1);
    for (const body of [
      {},
      { consent: false },
      { consent: true, uid: 'victim' },
      { consent: true, scopes: ['maps:write'] },
    ])
      assert.equal((await request(body)).status, 400);
    assert.equal(starts, 0);
    const started = await request({ consent: true });
    assert.equal(started.status, 200);
    const cookie = started.headers.get('set-cookie')!;
    assert.match(
      cookie,
      /^__Host-antty_mcp_link=b{43}; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=300$/,
    );
    assert.deepEqual(await started.json(), {
      authorizationUrl: 'https://personal.auth0.com/authorize',
    });
    const callback = (query: string, cookieValue = '__Host-antty_mcp_link=' + 'b'.repeat(43)) =>
      fetch(`${origin}/?action=callback&${query}`, {
        redirect: 'manual',
        headers: { Cookie: cookieValue },
      });
    const authBefore = authentications;
    const completed = await callback(
      'state=safe&code=code&iss=https%3A%2F%2Fpersonal.auth0.com%2F',
    );
    assert.equal(completed.status, 303);
    assert.equal(completed.headers.get('location'), `${origin}/?mcpLink=success`);
    assert.equal(completed.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(completed.headers.get('cache-control'), 'no-store');
    assert.match(completed.headers.get('set-cookie')!, /Max-Age=0/);
    assert.equal(completions.length, 1);
    assert.equal(authentications, authBefore);
    for (const [query, cookieValue] of [
      ['state=bad&code=secret&iss=issuer', undefined],
      ['error=access_denied&error_description=sensitive', undefined],
      ['state=safe&code=secret&iss=issuer', ''],
      ['state=safe&code=secret&iss=issuer', '__Host-antty_mcp_link=a; __Host-antty_mcp_link=b'],
    ]) {
      const failed = await callback(query!, cookieValue);
      assert.equal(failed.status, 303);
      assert.equal(failed.headers.get('location'), `${origin}/?mcpLink=failed`);
      assert.equal(failed.headers.get('set-cookie'), null);
      assert.equal(await failed.text(), '');
    }
    const revoked = await fetch(origin, {
      method: 'DELETE',
      headers,
      body: JSON.stringify({ id: 'a'.repeat(64) }),
    });
    assert.equal(revoked.status, 200);
    assert.deepEqual(revocations, [['alice', 'a'.repeat(64)]]);
    assert.equal((await fetch(`${origin}/?uid=victim`, { headers })).status, 400);
    assert.equal((await fetch(`${origin}/?after=invalid`, { headers })).status, 400);
    paged = true;
    const page = await (await fetch(origin, { headers })).json();
    assert.equal(page.links.length, 50);
    assert.equal(page.nextAfter, (49).toString(16).padStart(64, '0'));
    const next = await (await fetch(`${origin}/?after=${page.nextAfter}`, { headers })).json();
    assert.equal(next.links.length, 1);
    assert.equal(next.nextAfter, undefined);
    enabled = false;
    assert.equal((await request({ consent: true })).status, 503);
    assert.equal(starts, 1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
