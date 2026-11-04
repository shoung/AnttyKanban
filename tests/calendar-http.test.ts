import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { createCalendarHandler } from '../server/calendar/http.ts';
import { CalendarError, type CalendarService } from '../server/calendar/core.ts';

async function serverFixture(t: import('node:test').TestContext, workflow: 'ui' | 'agent' = 'ui') {
  const actions: Array<{ action: string; uid?: string; binding?: string }> = [];
  const service = {
    async beginConnect(uid: string, binding: string) {
      actions.push({ action: 'connect', uid, binding });
      return { authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=opaque' };
    },
    async completeConnect(_state: string, binding: string) {
      actions.push({ action: 'callback', binding });
    },
    async listEvents(uid: string) {
      actions.push({ action: 'list', uid });
      return { events: [] };
    },
    async createEvent(uid: string) {
      actions.push({ action: 'create', uid });
      return { id: 'new' };
    },
    async disconnect(uid: string, confirm: boolean) {
      if (!confirm) throw new CalendarError('REVOCATION_CONFIRMATION_REQUIRED');
      actions.push({ action: 'disconnect', uid });
      return { status: 'disconnected' };
    },
  } as unknown as CalendarService;
  const handler = createCalendarHandler(
    {
      service: () => service,
      origin: () => 'https://app.example',
      status: async () => ({ configured: false, status: 'not_configured', calendar: 'primary' }),
      authenticate: async (req) => {
        if (req.headers.authorization !== 'Bearer valid-firebase-token')
          throw Object.assign(new Error('secret stack'), { status: 401 });
        return { uid: 'verified-user' };
      },
    },
    { workflow },
  );
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}/api/calendar`;
  return { base, actions };
}
const headers = {
  Authorization: 'Bearer valid-firebase-token',
  Origin: 'https://app.example',
  'Content-Type': 'application/json',
};

test('HTTP requires authenticated Firebase identity and does not expose internal auth errors', async (t) => {
  const { base } = await serverFixture(t);
  const response = await fetch(`${base}?action=status`);
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: 'AUTHENTICATION_REQUIRED' });
});

test('missing Calendar configuration is a safe status, not a broken login', async (t) => {
  const { base } = await serverFixture(t);
  const response = await fetch(`${base}?action=status`, { headers });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, 'not_configured');
});

test('cross-origin mutations fail and supplied UID/calendarId cannot change the target', async (t) => {
  const { base, actions } = await serverFixture(t);
  const foreign = await fetch(`${base}?action=connect`, {
    method: 'POST',
    headers: { ...headers, Origin: 'https://evil.example' },
    body: '{}',
  });
  assert.equal(foreign.status, 403);
  const injected = await fetch(`${base}?action=events&uid=victim`, { headers });
  assert.equal(injected.status, 400);
  const list = await fetch(`${base}?action=events`, { headers });
  assert.equal(list.status, 200);
  assert.deepEqual(actions, [{ action: 'list', uid: 'verified-user' }]);
});

test('connect writes a secure HttpOnly browser-binding cookie without tokens', async (t) => {
  const { base, actions } = await serverFixture(t);
  const response = await fetch(`${base}?action=connect`, { method: 'POST', headers, body: '{}' });
  assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie')!;
  assert.match(cookie, /^__Host-antty_calendar_oauth=/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /Path=\//);
  assert.equal(actions[0].uid, 'verified-user');
  assert.ok(!cookie.includes('valid-firebase-token'));
});

test('callback relies on state and browser cookie, redirects only to configured origin', async (t) => {
  const { base, actions } = await serverFixture(t);
  const response = await fetch(`${base}?action=callback&state=state&code=code`, {
    redirect: 'manual',
    headers: { Cookie: '__Host-antty_calendar_oauth=browser-bound-value' },
  });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), 'https://app.example/?calendar=connected');
  assert.deepEqual(actions, [{ action: 'callback', binding: 'browser-bound-value' }]);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('malformed JSON, wrong methods and duplicate action are rejected', async (t) => {
  const { base } = await serverFixture(t);
  assert.equal((await fetch(`${base}?action=connect`, { headers })).status, 405);
  assert.equal(
    (await fetch(`${base}?action=events`, { method: 'POST', headers, body: '{bad' })).status,
    400,
  );
  assert.equal((await fetch(`${base}?action=status&action=events`, { headers })).status, 400);
});

test('agent browser route only manages its grant, never invokes event CRUD', async (t) => {
  const { base, actions } = await serverFixture(t, 'agent');
  for (const method of ['GET', 'POST', 'PATCH', 'DELETE']) {
    const response = await fetch(`${base}?action=events`, {
      method,
      headers,
      ...(method === 'GET' ? {} : { body: '{}' }),
    });
    assert.equal(response.status, 400);
  }
  assert.deepEqual(actions, []);
});

test('agent and UI grants use distinct browser cookies and callback markers', async (t) => {
  const { base, actions } = await serverFixture(t, 'agent');
  const response = await fetch(`${base}?action=connect`, { method: 'POST', headers, body: '{}' });
  assert.match(response.headers.get('set-cookie')!, /^__Host-antty_calendar_agent_oauth=/);
  const callback = await fetch(`${base}?action=callback&state=state&code=code`, {
    redirect: 'manual',
    headers: {
      Cookie: '__Host-antty_calendar_oauth=wrong; __Host-antty_calendar_agent_oauth=correct',
    },
  });
  assert.equal(callback.headers.get('location'), 'https://app.example/?calendarAgent=connected');
  assert.deepEqual(actions.at(-1), { action: 'callback', binding: 'correct' });
  const cancel = await fetch(`${base}?action=callback&error=access_denied`, { redirect: 'manual' });
  assert.equal(
    cancel.headers.get('location'),
    'https://app.example/?calendarAgent=OAUTH_CANCELLED',
  );
  assert.match(cancel.headers.get('set-cookie')!, /^__Host-antty_calendar_agent_oauth=/);
});

test('workflow cannot be selected through browser query input', async (t) => {
  const { base, actions } = await serverFixture(t);
  assert.equal((await fetch(`${base}?action=status&channel=agent`, { headers })).status, 400);
  assert.equal(
    (
      await fetch(`${base}?action=connect`, {
        method: 'POST',
        headers,
        body: '{"channel":"agent"}',
      })
    ).status,
    400,
  );
  assert.deepEqual(actions, []);
});
