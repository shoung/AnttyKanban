import assert from 'node:assert/strict';
import test from 'node:test';
import { createCipher } from '../server/calendar/security.ts';
import {
  CalendarService,
  CalendarError,
  CALENDAR_SCOPE,
  type CalendarStore,
  type CalendarConnection,
  type OAuthAttempt,
  type GoogleGateway,
} from '../server/calendar/core.ts';

function fixture() {
  let now = Date.parse('2026-11-04T12:00:00Z');
  const connections = new Map<string, CalendarConnection>();
  const states = new Map<string, OAuthAttempt>();
  const store: CalendarStore = {
    async getConnection(uid) {
      return connections.get(uid) ?? null;
    },
    async saveConnection(uid, value, expectedRevision) {
      if ((connections.get(uid)?.revision ?? 0) !== expectedRevision) return false;
      connections.set(uid, value);
      return true;
    },
    async createAttempt(key, value) {
      states.set(key, value);
    },
    async consumeAttempt(key, bindingHash, currentTime) {
      const value = states.get(key);
      if (!value || value.bindingHash !== bindingHash || value.expiresAt <= currentTime)
        return null;
      states.delete(key);
      return value;
    },
  };
  const calls: Array<{ path: string; method: string; token: string; body?: unknown }> = [];
  let sub = 'google-user-a';
  let refreshToken: string | undefined = 'refresh-for-a';
  let revoked = false;
  let revokeFails = false;
  let refreshFails = false;
  let scopes = [CALENDAR_SCOPE, 'openid'];
  let eventDetails: Record<string, unknown> = {};
  let whileRefreshing: (() => Promise<void>) | undefined;
  let duringEventRead: (() => Promise<void>) | undefined;
  const google: GoogleGateway = {
    authorizationUrl({ state, challenge }) {
      const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      url.searchParams.set('state', state);
      url.searchParams.set('code_challenge', challenge);
      return url.toString();
    },
    async exchangeCode(_code, verifier) {
      assert.match(verifier, /^[A-Za-z0-9_-]{43,128}$/);
      return { subject: sub, refreshToken, grantedScopes: scopes };
    },
    async refreshAccessToken(token) {
      if (refreshFails) throw new CalendarError('RECONNECT_REQUIRED', 401);
      if (whileRefreshing) await whileRefreshing();
      return `access:${token}`;
    },
    async revokeToken() {
      if (revokeFails) throw new Error('provider unavailable');
      revoked = true;
    },
    async request(token, path, method, body) {
      calls.push({ token, path, method, body });
      if (method === 'GET' && path.includes('/events/') && duringEventRead) await duringEventRead();
      if (method === 'DELETE') return undefined;
      if (method === 'GET' && !path.includes('/events/'))
        return {
          items: [
            {
              id: 'event1',
              summary: 'Existing',
              start: { dateTime: '2026-11-04T12:00:00Z' },
              end: { dateTime: '2026-11-04T13:00:00Z' },
            },
          ],
        };
      if (method === 'GET')
        return { id: 'event1', etag: '"v1"', attendees: [], summary: 'Existing', ...eventDetails };
      return { id: 'event1', ...(body as object) };
    },
  };
  const service = new CalendarService({
    store,
    google,
    cipher: createCipher(Buffer.alloc(32, 8).toString('base64')),
    expectedGoogleSubject: async (uid) => (uid === 'user-a' ? 'google-user-a' : 'google-user-b'),
    now: () => now,
  });
  async function connect(uid = 'user-a') {
    const result = await service.beginConnect(uid, 'browser-binding');
    const state = new URL(result.authorizationUrl).searchParams.get('state')!;
    await service.completeConnect(state, 'browser-binding', 'authorization-code');
  }
  return {
    service,
    connections,
    states,
    calls,
    connect,
    advance: (ms: number) => {
      now += ms;
    },
    setSubject: (value: string) => {
      sub = value;
    },
    omitRefresh: () => {
      refreshToken = undefined;
    },
    denyScope: () => {
      scopes = ['openid'];
    },
    failRevoke: () => {
      revokeFails = true;
    },
    failRefresh: () => {
      refreshFails = true;
    },
    wasRevoked: () => revoked,
    duringEventRead: (callback: () => Promise<void>) => {
      duringEventRead = callback;
    },
    setEventDetails: (value: Record<string, unknown>) => {
      eventDetails = value;
    },
    duringRefresh: (callback: () => Promise<void>) => {
      whileRefreshing = callback;
    },
  };
}

async function expectCode(promise: Promise<unknown>, code: string) {
  await assert.rejects(
    promise,
    (error: unknown) => error instanceof CalendarError && error.code === code,
  );
}

const input = {
  summary: 'Write song',
  start: { dateTime: '2026-11-04T12:00:00+08:00' },
  end: { dateTime: '2026-11-04T13:00:00+08:00' },
};

test('OAuth saves only encrypted credentials and never exposes them in status', async () => {
  const f = fixture();
  await f.connect();
  const stored = f.connections.get('user-a')!;
  assert.equal(stored.status, 'connected');
  assert.ok(!JSON.stringify(stored).includes('refresh-for-a'));
  const status = await f.service.getStatus('user-a');
  assert.deepEqual(status, { configured: true, status: 'connected', calendar: 'primary' });
  assert.deepEqual(await f.service.getStatus('user-b'), {
    configured: true,
    status: 'disconnected',
    calendar: 'primary',
  });
});

test('OAuth rejects wrong browser, replay and expired state before linking', async () => {
  const f = fixture();
  const begin = await f.service.beginConnect('user-a', 'correct-browser');
  const state = new URL(begin.authorizationUrl).searchParams.get('state')!;
  await expectCode(
    f.service.completeConnect(state, 'other-browser', 'code'),
    'OAUTH_STATE_INVALID',
  );
  await f.service.completeConnect(state, 'correct-browser', 'code');
  await expectCode(
    f.service.completeConnect(state, 'correct-browser', 'code'),
    'OAUTH_STATE_INVALID',
  );
  const expired = await f.service.beginConnect('user-a', 'correct-browser');
  f.advance(600_001);
  await expectCode(
    f.service.completeConnect(
      new URL(expired.authorizationUrl).searchParams.get('state')!,
      'correct-browser',
      'code',
    ),
    'OAUTH_STATE_INVALID',
  );
});

test('OAuth cannot substitute a Google account or silently omit Calendar consent', async () => {
  const f = fixture();
  f.setSubject('attacker-google-account');
  await expectCode(f.connect(), 'GOOGLE_ACCOUNT_MISMATCH');
  assert.equal(f.connections.size, 0);
  f.setSubject('google-user-a');
  f.denyScope();
  await expectCode(f.connect(), 'CALENDAR_SCOPE_REQUIRED');
});

test('reconsent preserves same-account refresh token when Google omits it', async () => {
  const f = fixture();
  await f.connect();
  f.omitRefresh();
  await f.connect();
  await f.service.createEvent('user-a', input);
  assert.equal(f.calls.at(-1)?.token, 'access:refresh-for-a');
});

test('missing refresh token on first connect fails rather than false connected status', async () => {
  const f = fixture();
  f.omitRefresh();
  await expectCode(f.connect(), 'OFFLINE_ACCESS_REQUIRED');
});

test('older OAuth callback cannot restore a disconnected connection', async () => {
  const f = fixture();
  await f.connect();
  const attempt = await f.service.beginConnect('user-a', 'browser-binding');
  await f.service.disconnect('user-a', true);
  await expectCode(
    f.service.completeConnect(
      new URL(attempt.authorizationUrl).searchParams.get('state')!,
      'browser-binding',
      'code',
    ),
    'CONNECTION_CHANGED',
  );
  assert.equal((await f.service.getStatus('user-a')).status, 'disconnected');
});

test('disconnect requires project-wide revocation acknowledgement and removes token on success', async () => {
  const f = fixture();
  await f.connect();
  await expectCode(f.service.disconnect('user-a', false), 'REVOCATION_CONFIRMATION_REQUIRED');
  assert.equal((await f.service.getStatus('user-a')).status, 'connected');
  await f.service.disconnect('user-a', true);
  assert.equal(f.wasRevoked(), true);
  assert.equal(f.connections.get('user-a')?.encryptedRefreshToken, undefined);
  await expectCode(f.service.listEvents('user-a', {}), 'CALENDAR_NOT_CONNECTED');
});

test('failed revocation disables CRUD and preserves encrypted credential only for retry', async () => {
  const f = fixture();
  await f.connect();
  f.failRevoke();
  assert.deepEqual(await f.service.disconnect('user-a', true), { status: 'revocation_pending' });
  assert.ok(f.connections.get('user-a')?.encryptedRefreshToken);
  await expectCode(f.service.createEvent('user-a', input), 'CALENDAR_NOT_CONNECTED');
  await expectCode(f.service.beginConnect('user-a', 'browser'), 'REVOCATION_PENDING');
});

test('expired or revoked refresh grant marks reconnect required without mutation', async () => {
  const f = fixture();
  await f.connect();
  f.failRefresh();
  await expectCode(f.service.createEvent('user-a', input), 'RECONNECT_REQUIRED');
  assert.equal((await f.service.getStatus('user-a')).status, 'reconnect_required');
  assert.equal(f.calls.length, 0);
});

test('event operations pin primary and isolate the authenticated user', async () => {
  const f = fixture();
  await f.connect();
  const list = await f.service.listEvents('user-a', {});
  assert.equal(list.events[0].id, 'event1');
  await f.service.createEvent('user-a', input);
  assert.equal(f.calls.at(-1)?.path, '/calendars/primary/events?sendUpdates=none');
  await expectCode(f.service.listEvents('user-b', {}), 'CALENDAR_NOT_CONNECTED');
  await expectCode(
    f.service.createEvent('user-a', { ...input, calendarId: 'victim' }),
    'INVALID_EVENT',
  );
  await expectCode(
    f.service.createEvent('user-a', { ...input, attendees: [{ email: 'other@example.com' }] }),
    'INVALID_EVENT',
  );
});

test('event validation rejects backwards dates, mixed all-day types and unsafe event IDs', async () => {
  const f = fixture();
  await f.connect();
  await expectCode(
    f.service.createEvent('user-a', { ...input, end: { dateTime: '2026-11-03T13:00:00+08:00' } }),
    'INVALID_EVENT',
  );
  await expectCode(
    f.service.createEvent('user-a', { ...input, start: { date: '2026-11-04' } }),
    'INVALID_EVENT',
  );
  await expectCode(f.service.deleteEvent('user-a', '../other-calendar'), 'INVALID_EVENT_ID');
  await expectCode(
    f.service.createEvent('user-a', { ...input, start: { dateTime: 'not-a-date' } }),
    'INVALID_EVENT',
  );
});

test('mutation checks existing event participants and ETag before editing personal events', async () => {
  const f = fixture();
  await f.connect();
  await f.service.updateEvent('user-a', 'event1', input, '"v1"');
  assert.equal(f.calls.at(-1)?.method, 'PATCH');
  await expectCode(f.service.updateEvent('user-a', 'event1', input, '"stale"'), 'EVENT_CHANGED');
});

test('invited, recurring and foreign-organizer events never send a mutation', async () => {
  for (const details of [
    { attendees: [{ email: 'guest@example.com' }] },
    { recurringEventId: 'series' },
    { recurrence: ['RRULE:FREQ=WEEKLY'] },
    { organizer: { self: false } },
    { eventType: 'outOfOffice' },
  ]) {
    const f = fixture();
    await f.connect();
    f.setEventDetails(details);
    await expectCode(
      f.service.updateEvent('user-a', 'event1', input, '"v1"'),
      'PERSONAL_EVENTS_ONLY',
    );
    await expectCode(f.service.deleteEvent('user-a', 'event1', '"v1"'), 'PERSONAL_EVENTS_ONLY');
    assert.ok(f.calls.every((call) => call.method === 'GET'));
  }
});

test('disconnect while token refresh is in flight prevents the subsequent event write', async () => {
  const f = fixture();
  await f.connect();
  f.duringRefresh(async () => {
    await f.service.disconnect('user-a', true);
  });
  await expectCode(f.service.createEvent('user-a', input), 'CONNECTION_CHANGED');
  assert.equal(f.calls.length, 0);
});

test('pagination returns a stable window that callers can reuse after time advances', async () => {
  const f = fixture();
  await f.connect();
  const first = await f.service.listEvents('user-a', {});
  assert.equal(first.timeMin, '2026-10-05T12:00:00.000Z');
  assert.equal(first.timeMax, '2027-02-02T12:00:00.000Z');
  f.advance(120_000);
  await f.service.listEvents('user-a', {
    timeMin: first.timeMin,
    timeMax: first.timeMax,
    pageToken: 'next-page',
  });
  const url = new URL(f.calls.at(-1)!.path, 'https://calendar.test');
  assert.equal(url.searchParams.get('timeMin'), first.timeMin);
  assert.equal(url.searchParams.get('timeMax'), first.timeMax);
});

test('all-day dates are real calendar dates and ISO timed events reject 24:00 rollover', async () => {
  const f = fixture();
  await f.connect();
  await expectCode(
    f.service.createEvent('user-a', {
      summary: 'bad date',
      start: { date: '2026-02-30' },
      end: { date: '2026-03-04' },
    }),
    'INVALID_EVENT',
  );
  await expectCode(
    f.service.createEvent('user-a', {
      ...input,
      start: { dateTime: '2026-11-04T24:00:00Z' },
      end: { dateTime: '2026-11-05T02:00:00Z' },
    }),
    'INVALID_EVENT',
  );
});

test('hidden participant metadata prevents mutation even if attendees are omitted', async () => {
  const f = fixture();
  await f.connect();
  f.setEventDetails({ attendeesOmitted: true });
  await expectCode(f.service.deleteEvent('user-a', 'event1', '"v1"'), 'PERSONAL_EVENTS_ONLY');
});

test('pagination rejects a token without the original time window', async () => {
  const f = fixture();
  await f.connect();
  await expectCode(f.service.listEvents('user-a', { pageToken: 'next-page' }), 'INVALID_RANGE');
});

for (const operation of ['update', 'delete'] as const) {
  test(`disconnect during ${operation} preflight prevents mutation even when provider revocation fails`, async () => {
    const f = fixture();
    await f.connect();
    f.failRevoke();
    f.duringEventRead(async () => {
      await f.service.disconnect('user-a', true);
    });
    const mutation =
      operation === 'update'
        ? f.service.updateEvent('user-a', 'event1', input, '"v1"')
        : f.service.deleteEvent('user-a', 'event1', '"v1"');
    await expectCode(mutation, 'CONNECTION_CHANGED');
    assert.equal((await f.service.getStatus('user-a')).status, 'revocation_pending');
    assert.ok(f.calls.every((call) => call.method === 'GET'));
  });
}
