import assert from 'node:assert/strict';
import test from 'node:test';
import {
  calendarTransportFixture,
  eventInput,
  initialEvent,
} from './fixtures/calendar-transport.ts';

for (const surface of ['HTTP', 'MCP'] as const) {
  test(`${surface} PATCH and DELETE carry last-read ETags through the real Google gateway`, async (t) => {
    const f = await calendarTransportFixture(t);
    const event = { ...eventInput, summary: 'Changed through real transport' };
    if (surface === 'HTTP') {
      const patch = await f.http('PATCH', { eventId: 'event1', etag: '"v1"', event });
      assert.equal(patch.status, 200);
      assert.equal((await patch.json()).etag, '"v2"');
      const deletion = await f.http('DELETE', { eventId: 'event1', etag: '"v2"' });
      assert.equal(deletion.status, 200);
      assert.deepEqual(await deletion.json(), { deleted: true });
    } else {
      const patch = await f.tool('calendar_update', { eventId: 'event1', etag: '"v1"', event });
      assert.equal(patch.error, false);
      assert.equal(patch.value.etag, '"v2"');
      assert.equal(
        (await f.tool('calendar_delete', { eventId: 'event1', etag: '"v2"' })).error,
        false,
      );
    }
    assert.equal(f.events.has('event1'), false);
    assert.deepEqual(
      f.requests.map((r) => [r.method, r.headers.get('if-match')]),
      [
        ['GET', null],
        ['PATCH', '"v1"'],
        ['GET', null],
        ['DELETE', '"v2"'],
      ],
    );
    assert.deepEqual(f.requests[1].body, event);
    assert.equal(f.requests[3].body, undefined);
    assert.ok(
      f.requests.every(
        (r) =>
          r.headers.get('authorization') ===
          `Bearer synthetic-${surface === 'HTTP' ? 'ui' : 'agent'}-access`,
      ),
    );
  });

  for (const method of ['PATCH', 'DELETE'] as const) {
    const tool = method === 'PATCH' ? 'calendar_update' : 'calendar_delete';
    test(`${surface} ${method} rejects missing and stale ETags without a provider mutation`, async (t) => {
      const f = await calendarTransportFixture(t);
      const body = { eventId: 'event1', ...(method === 'PATCH' ? { event: eventInput } : {}) };
      if (surface === 'HTTP') {
        assert.equal((await f.http(method, body)).status, 400);
        assert.equal((await f.http(method, { ...body, etag: '"stale"' })).status, 409);
      } else {
        assert.equal((await f.tool(tool, body)).error, true);
        assert.equal((await f.tool(tool, { ...body, etag: '"stale"' })).text, 'EVENT_CHANGED');
      }
      assert.deepEqual(
        f.requests.map((r) => r.method),
        ['GET'],
      );
      assert.deepEqual(f.events.get('event1'), initialEvent);
    });

    test(`${surface} ${method} maps a post-preflight 412 race and preserves the concurrent event`, async (t) => {
      const f = await calendarTransportFixture(t);
      f.failNext({ method, race: true });
      const body = {
        eventId: 'event1',
        etag: '"v1"',
        ...(method === 'PATCH' ? { event: eventInput } : {}),
      };
      if (surface === 'HTTP') {
        const response = await f.http(method, body);
        assert.equal(response.status, 409);
        assert.deepEqual(await response.json(), { error: 'EVENT_CHANGED' });
      } else assert.equal((await f.tool(tool, body)).text, 'EVENT_CHANGED');
      assert.equal(f.events.get('event1')?.etag, '"raced"');
      assert.deepEqual(
        f.requests.map((r) => r.method),
        ['GET', method],
      );
      assert.equal(f.requests[1].headers.get('if-match'), '"v1"');
    });

    test(`${surface} ${method} fails closed on a malformed preflight and never submits the write`, async (t) => {
      const f = await calendarTransportFixture(t);
      f.failNext({ method: 'GET', response: Response.json({ etag: '"v1"' }) });
      const body = {
        eventId: 'event1',
        etag: '"v1"',
        ...(method === 'PATCH' ? { event: eventInput } : {}),
      };
      if (surface === 'HTTP') {
        const response = await f.http(method, body);
        assert.equal(response.status, 502);
        assert.deepEqual(await response.json(), { error: 'GOOGLE_UNAVAILABLE' });
      } else {
        const result = await f.tool(tool, body);
        assert.equal(result.error, true);
        assert.doesNotMatch(result.text, /GOOGLE_WRITE_UNCERTAIN/);
      }
      assert.deepEqual(
        f.requests.map((r) => r.method),
        ['GET'],
      );
      assert.deepEqual(f.events.get('event1'), initialEvent);
    });
  }

  for (const method of ['POST', 'PATCH', 'DELETE'] as const) {
    test(`${surface} ${method} reports an applied-but-lost response as uncertain, then permits safe read-back`, async (t) => {
      const f = await calendarTransportFixture(t);
      f.failNext({ method, commitThenLose: true });
      const event = { ...eventInput, summary: 'Committed before the response was lost' };
      const body =
        method === 'POST'
          ? event
          : { eventId: 'event1', etag: '"v1"', ...(method === 'PATCH' ? { event } : {}) };
      if (surface === 'HTTP') {
        const response = await f.http(method, body);
        assert.equal(response.status, 502);
        assert.deepEqual(await response.json(), { error: 'GOOGLE_WRITE_UNCERTAIN' });
        const read = await f.http('GET');
        assert.equal(read.status, 200);
        const { events } = await read.json();
        assert.equal(
          events.some((e: { id: string }) => e.id === (method === 'POST' ? 'created1' : 'event1')),
          method !== 'DELETE',
        );
      } else {
        const name =
          method === 'POST'
            ? 'calendar_create'
            : method === 'PATCH'
              ? 'calendar_update'
              : 'calendar_delete';
        const result = await f.tool(name, method === 'POST' ? { event } : body);
        assert.equal(result.error, true);
        assert.match(result.text, /GOOGLE_WRITE_UNCERTAIN.*Do not retry/);
        assert.doesNotMatch(result.text, /synthetic private/);
        const read = await f.tool('calendar_list');
        assert.equal(read.error, false);
        assert.equal(
          read.value.events.some(
            (e: { id: string }) => e.id === (method === 'POST' ? 'created1' : 'event1'),
          ),
          method !== 'DELETE',
        );
      }
      assert.equal(f.requests.filter((r) => r.method === method).length, 1);
      if (method !== 'DELETE')
        assert.equal(
          f.events.get(method === 'POST' ? 'created1' : 'event1')?.summary,
          event.summary,
        );
    });
  }
}

for (const surface of ['HTTP', 'MCP'] as const) {
  for (const [status, code, mapped] of [
    [401, 'RECONNECT_REQUIRED', 401],
    [403, 'GOOGLE_PERMISSION_DENIED', 403],
    [404, 'EVENT_NOT_FOUND', 404],
    [410, 'EVENT_NOT_FOUND', 404],
    [429, 'RATE_LIMITED', 429],
  ] as const) {
    test(`${surface} preserves safe provider ${status} error mapping without exposing provider content`, async (t) => {
      const f = await calendarTransportFixture(t);
      f.failNext({
        method: 'PATCH',
        response: Response.json(
          { error: { message: 'synthetic-private-provider-token' } },
          { status },
        ),
      });
      const body = { eventId: 'event1', etag: '"v1"', event: eventInput };
      if (surface === 'HTTP') {
        const response = await f.http('PATCH', body);
        assert.equal(response.status, mapped);
        assert.deepEqual(await response.json(), { error: code });
      } else {
        const result = await f.tool('calendar_update', body);
        assert.equal(result.error, true);
        assert.equal(result.text, code);
      }
      assert.deepEqual(
        f.requests.map((r) => r.method),
        ['GET', 'PATCH'],
      );
      assert.deepEqual(f.events.get('event1'), initialEvent);
    });
  }
}
