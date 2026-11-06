import assert from 'node:assert/strict';
import test from 'node:test';
import { CalendarError } from '../server/calendar/core.ts';
import { googleGateway } from '../server/calendar/google.ts';
import { safeMcpError } from '../server/mcpHttp.ts';
import type { CalendarConfig } from '../server/calendar/config.ts';

const config: CalendarConfig = {
  channel: 'agent',
  projectId: 'synthetic-calendar',
  clientId: 'synthetic-client',
  clientSecret: 'synthetic-secret',
  appOrigin: 'https://app.example',
  redirectUri: 'https://app.example/api/calendar-agent?action=callback',
  encryptionKey: Buffer.alloc(32, 7).toString('base64'),
};
const event = {
  summary: 'Synthetic event',
  start: { date: '2026-11-06' },
  end: { date: '2026-11-07' },
};
const path = '/calendars/primary/events/event1?sendUpdates=none';
function expectCode(code: string, status: number) {
  return (error: unknown) => {
    assert.ok(error instanceof CalendarError);
    assert.equal(error.code, code);
    assert.equal(error.status, status);
    return true;
  };
}

test('Google transport sends PATCH JSON and exact quoted If-Match, and consumes DELETE 204 without JSON', async (t) => {
  const requests: Request[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    const request = new Request(url, init);
    requests.push(request);
    return request.method === 'DELETE'
      ? new Response(null, { status: 204 })
      : Response.json({ ...event, id: 'event1', etag: '"v2"' });
  });
  const gateway = googleGateway(config);
  assert.deepEqual(await gateway.request('synthetic-access', path, 'PATCH', event, '"v1"'), {
    ...event,
    id: 'event1',
    etag: '"v2"',
  });
  assert.equal(
    await gateway.request('synthetic-access', path, 'DELETE', undefined, '"v2"'),
    undefined,
  );
  assert.deepEqual(
    requests.map((r) => [r.url, r.method, r.headers.get('if-match')]),
    [
      [
        'https://www.googleapis.com/calendar/v3/calendars/primary/events/event1?sendUpdates=none',
        'PATCH',
        '"v1"',
      ],
      [
        'https://www.googleapis.com/calendar/v3/calendars/primary/events/event1?sendUpdates=none',
        'DELETE',
        '"v2"',
      ],
    ],
  );
  assert.equal(requests[0].headers.get('authorization'), 'Bearer synthetic-access');
  assert.equal(requests[0].headers.get('content-type'), 'application/json');
  assert.deepEqual(await requests[0].json(), event);
  assert.equal(await requests[1].text(), '');
});

for (const [status, code, mapped] of [
  [401, 'RECONNECT_REQUIRED', 401],
  [403, 'GOOGLE_PERMISSION_DENIED', 403],
  [404, 'EVENT_NOT_FOUND', 404],
  [410, 'EVENT_NOT_FOUND', 404],
  [412, 'EVENT_CHANGED', 409],
  [429, 'RATE_LIMITED', 429],
] as const) {
  test(`Google transport sanitizes HTTP ${status} as ${code} without retrying`, async (t) => {
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => {
      calls++;
      return Response.json({ error: { message: 'provider-private-token-and-body' } }, { status });
    });
    await assert.rejects(
      googleGateway(config).request('synthetic-access', path, 'PATCH', event, '"v1"'),
      expectCode(code, mapped),
    );
    assert.equal(calls, 1);
  });
}

for (const method of ['POST', 'PATCH', 'DELETE']) {
  for (const failure of [
    'network',
    'timeout',
    'server-error',
    'invalid-json',
    'body-read',
  ] as const) {
    test(`${method} ${failure} remains an uncertain write and never retries`, async (t) => {
      let calls = 0;
      t.mock.method(globalThis, 'fetch', async () => {
        calls++;
        if (failure === 'network') throw new Error('synthetic-private-network-detail');
        if (failure === 'timeout')
          throw new DOMException('synthetic-private-timeout', 'TimeoutError');
        if (failure === 'server-error')
          return new Response('private upstream content', { status: 503 });
        if (failure === 'invalid-json') return new Response('private invalid JSON');
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error('private stream detail'));
            },
          }),
        );
      });
      await assert.rejects(
        googleGateway(config).request(
          'synthetic-access',
          path,
          method,
          method === 'DELETE' ? undefined : event,
          '"v1"',
        ),
        expectCode('GOOGLE_WRITE_UNCERTAIN', 502),
      );
      assert.equal(calls, 1);
    });
  }
}

for (const failure of ['network', 'server-error', 'invalid-json', 'body-read'] as const) {
  test(`GET ${failure} is sanitized as unavailable, not an uncertain mutation`, async (t) => {
    t.mock.method(globalThis, 'fetch', async () => {
      if (failure === 'network') throw new Error('private detail');
      if (failure === 'server-error') return new Response('private detail', { status: 503 });
      if (failure === 'invalid-json') return new Response('private detail');
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error('private stream detail'));
          },
        }),
      );
    });
    await assert.rejects(
      googleGateway(config).request('synthetic-access', path, 'GET'),
      expectCode('GOOGLE_UNAVAILABLE', 502),
    );
  });
}

test('MCP preserves uncertainty and instructs read-back rather than blindly retrying a write', () => {
  const result = safeMcpError(new CalendarError('GOOGLE_WRITE_UNCERTAIN', 502));
  assert.equal(result.status, 502);
  assert.match(result.error, /GOOGLE_WRITE_UNCERTAIN/);
  assert.match(result.error, /do not retry/i);
  assert.match(result.error, /read|check/i);
  assert.doesNotMatch(result.error, /try again later/i);
  assert.deepEqual(
    safeMcpError(Object.assign(new Error('private upstream token'), { status: 502 })),
    {
      status: 500,
      error: 'Request failed. Try again later.',
    },
  );
});

for (const method of ['POST', 'PATCH']) {
  for (const payload of [
    {},
    [],
    null,
    'private upstream string',
    { id: 'event1', etag: '"v2"' },
    { ...event, id: 'event1' },
  ]) {
    test(`${method} rejects a malformed successful event payload ${JSON.stringify(payload)}`, async (t) => {
      t.mock.method(globalThis, 'fetch', async () => Response.json(payload));
      await assert.rejects(
        googleGateway(config).request('synthetic-access', path, method, event, '"v1"'),
        expectCode('GOOGLE_WRITE_UNCERTAIN', 502),
      );
    });
  }
  test(`${method} does not report an empty 204 event response as success`, async (t) => {
    t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 204 }));
    await assert.rejects(
      googleGateway(config).request('synthetic-access', path, method, event, '"v1"'),
      expectCode('GOOGLE_WRITE_UNCERTAIN', 502),
    );
  });
}

test('single-event preflight without ownership metadata fails closed before a mutation can follow', async (t) => {
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ ...event, id: 'event1', etag: '"v1"' }),
  );
  await assert.rejects(
    googleGateway(config).request('synthetic-access', path, 'GET'),
    expectCode('GOOGLE_UNAVAILABLE', 502),
  );
});

for (const reason of ['rateLimitExceeded', 'userRateLimitExceeded']) {
  test(`Google 403 ${reason} is rate limiting, not a permission failure`, async (t) => {
    t.mock.method(globalThis, 'fetch', async () =>
      Response.json(
        { error: { errors: [{ reason, message: 'private-provider-message' }] } },
        { status: 403 },
      ),
    );
    await assert.rejects(
      googleGateway(config).request('synthetic-access', path, 'PATCH', event, '"v1"'),
      expectCode('RATE_LIMITED', 429),
    );
  });
}

test('unreadable Google 403 error body remains a sanitized permission error', async (t) => {
  t.mock.method(
    globalThis,
    'fetch',
    async () => new Response('private-invalid-json', { status: 403 }),
  );
  await assert.rejects(
    googleGateway(config).request('synthetic-access', path, 'DELETE', undefined, '"v1"'),
    expectCode('GOOGLE_PERMISSION_DENIED', 403),
  );
});
