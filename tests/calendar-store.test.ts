import assert from 'node:assert/strict';
import test from 'node:test';
import * as adapters from '../server/calendar/service.ts';
import {
  CalendarService,
  CALENDAR_SCOPE,
  type CalendarConnection,
  type OAuthAttempt,
  type GoogleGateway,
} from '../server/calendar/core.ts';
import { createCipher } from '../server/calendar/security.ts';
import type { getAdminDb } from '../server/firebase.ts';

function database() {
  const documents = new Map<string, Record<string, unknown>>();
  const reads: string[] = [];
  const snapshot = (path: string) => ({
    exists: documents.has(path),
    data: () => documents.get(path),
  });
  const collection = (path: string) => ({
    doc: (id: string) => ({
      path: `${path}/${id}`,
      collection: (name: string) => collection(`${path}/${id}/${name}`),
      get: async () => {
        reads.push(`${path}/${id}`);
        return snapshot(`${path}/${id}`);
      },
      create: async (data: Record<string, unknown>) => {
        const key = `${path}/${id}`;
        assert.equal(documents.has(key), false);
        documents.set(key, data);
      },
    }),
  });
  const db = {
    collection,
    runTransaction: async (fn: (transaction: unknown) => Promise<unknown>) =>
      fn({
        get: async (ref: { path: string }) => {
          reads.push(ref.path);
          return snapshot(ref.path);
        },
        set: (ref: { path: string }, data: Record<string, unknown>) =>
          documents.set(ref.path, data),
        delete: (ref: { path: string }) => documents.delete(ref.path),
      }),
  } as unknown as ReturnType<typeof getAdminDb>;
  return { db, documents, reads };
}

const grant = (channel: 'ui' | 'agent'): CalendarConnection => ({
  ownerUid: 'user-a',
  channel,
  grantBinding: `${channel}-binding`,
  revision: 1,
  status: 'connected',
  encryptedRefreshToken: `${channel}-ciphertext`,
  updatedAt: 100,
});
const attempt = (channel: 'ui' | 'agent'): OAuthAttempt => ({
  uid: 'user-a',
  channel,
  grantBinding: `${channel}-binding`,
  bindingHash: 'browser',
  expectedRevision: 0,
  encryptedVerifier: 'encrypted-verifier',
  expiresAt: 1000,
});

test('persistent stores separate per-user grants, attempts and revisions without migrating legacy records', async () => {
  assert.equal(typeof adapters.createCalendarStore, 'function');
  const f = database();
  const legacy = { status: 'connected', encryptedRefreshToken: 'untouched-legacy' };
  f.documents.set('calendarConnections/user-a', legacy);
  const ui = adapters.createCalendarStore('ui', f.db);
  const agent = adapters.createCalendarStore('agent', f.db);
  assert.equal(await ui.getConnection('user-a'), null);
  assert.equal(await agent.getConnection('user-a'), null);
  assert.equal(await ui.hasLegacyConnection?.('user-a'), true);
  assert.equal(agent.hasLegacyConnection, undefined);
  assert.equal(await ui.saveConnection('user-a', grant('ui'), 0), true);
  assert.equal(await agent.saveConnection('user-a', grant('agent'), 0), true);
  assert.equal(await ui.saveConnection('user-a', grant('ui'), 0), false);
  assert.equal(f.documents.get('calendarConnections/user-a'), legacy);
  assert.equal(
    f.documents.get('calendarConnections/user-a/grants/ui')?.encryptedRefreshToken,
    'ui-ciphertext',
  );
  assert.equal(
    f.documents.get('calendarConnections/user-a/grants/agent')?.encryptedRefreshToken,
    'agent-ciphertext',
  );
  assert.equal(await agent.getConnection('user-b'), null);
  await ui.createAttempt('same-state-hash', attempt('ui'));
  await agent.createAttempt('same-state-hash', attempt('agent'));
  assert.equal(await agent.consumeAttempt('same-state-hash', 'wrong-browser', 200), null);
  assert.equal((await agent.consumeAttempt('same-state-hash', 'browser', 200))?.channel, 'agent');
  assert.equal(await agent.consumeAttempt('same-state-hash', 'browser', 200), null);
  assert.equal((await ui.consumeAttempt('same-state-hash', 'browser', 200))?.channel, 'ui');
});

test('legacy UI grant reports reconsent, never becomes agent data, and disconnect cannot claim old grant revoked', async () => {
  assert.equal(typeof adapters.createCalendarStore, 'function');
  const f = database();
  const legacy = { status: 'connected', encryptedRefreshToken: 'untouched-legacy' };
  f.documents.set('calendarConnections/user-a', legacy);
  let exchanged = 0;
  const google: GoogleGateway = {
    authorizationUrl: ({ state }) => `https://accounts.google.com/?state=${state}`,
    exchangeCode: async () => {
      exchanged++;
      return { subject: 'google-user', refreshToken: 'new-grant', grantedScopes: [CALENDAR_SCOPE] };
    },
    refreshAccessToken: async () => {
      throw new Error('must not use legacy token');
    },
    revokeToken: async () => {
      throw new Error('must not revoke legacy token');
    },
    request: async () => {
      throw new Error('must not use legacy grant');
    },
  };
  const build = (channel: 'ui' | 'agent') =>
    new CalendarService({
      context: { channel, clientId: `${channel}-client`, projectId: `${channel}-project` },
      store: adapters.createCalendarStore(channel, f.db),
      google,
      cipher: createCipher(Buffer.alloc(32, 4).toString('base64')),
      expectedGoogleSubject: async () => 'google-user',
    });
  const ui = build('ui');
  const agent = build('agent');
  assert.equal((await ui.getStatus('user-a')).status, 'reconnect_required');
  assert.equal((await agent.getStatus('user-a')).status, 'disconnected');
  await assert.rejects(ui.disconnect('user-a', true), { message: 'LEGACY_CALENDAR_GRANT' });
  await assert.rejects(agent.listEvents('user-a'), { message: 'CALENDAR_NOT_CONNECTED' });
  const start = await ui.beginConnect('user-a', 'browser');
  await ui.completeConnect(
    new URL(start.authorizationUrl).searchParams.get('state')!,
    'browser',
    'code',
  );
  assert.equal(exchanged, 1);
  assert.equal((await ui.getStatus('user-a')).status, 'connected');
  assert.equal((await agent.getStatus('user-a')).status, 'disconnected');
  assert.equal(f.documents.get('calendarConnections/user-a'), legacy);
});

test('two workflows sharing Firestore keep refresh tokens, users, callback revisions and revocations independent', async () => {
  const f = database();
  const calls: Array<{ channel: string; operation: string; token: string }> = [];
  const build = (channel: 'ui' | 'agent') =>
    new CalendarService({
      context: { channel, clientId: `${channel}-client`, projectId: `${channel}-project` },
      store: adapters.createCalendarStore(channel, f.db),
      cipher: createCipher(Buffer.alloc(32, channel === 'ui' ? 3 : 7).toString('base64')),
      expectedGoogleSubject: async (uid) => uid,
      google: {
        authorizationUrl: ({ state }) => `https://accounts.google.com/?state=${state}`,
        exchangeCode: async (uid) => ({
          subject: uid,
          refreshToken: `${channel}:${uid}`,
          grantedScopes: [CALENDAR_SCOPE],
        }),
        refreshAccessToken: async (token) => {
          calls.push({ channel, operation: 'refresh', token });
          return `access:${token}`;
        },
        revokeToken: async (token) => {
          calls.push({ channel, operation: 'revoke', token });
        },
        request: async (token) => {
          calls.push({ channel, operation: 'request', token });
          return { items: [] };
        },
      },
    });
  const ui = build('ui');
  const agent = build('agent');
  const connect = async (service: CalendarService, uid: string) => {
    const start = await service.beginConnect(uid, 'browser');
    await service.completeConnect(
      new URL(start.authorizationUrl).searchParams.get('state')!,
      'browser',
      uid,
    );
  };
  await connect(ui, 'user-a');
  await connect(agent, 'user-a');
  await connect(agent, 'user-b');
  const ongoing = await agent.beginConnect('user-a', 'browser');
  await ui.disconnect('user-a', true);
  await agent.completeConnect(
    new URL(ongoing.authorizationUrl).searchParams.get('state')!,
    'browser',
    'user-a',
  );
  await agent.listEvents('user-a');
  await agent.listEvents('user-b');
  assert.deepEqual(
    calls.filter((call) => call.operation === 'revoke'),
    [{ channel: 'ui', operation: 'revoke', token: 'ui:user-a' }],
  );
  assert.deepEqual(
    calls.filter((call) => call.operation === 'refresh').map((call) => call.token),
    ['agent:user-a', 'agent:user-b'],
  );
  assert.equal((await ui.getStatus('user-a')).status, 'disconnected');
  assert.equal((await agent.getStatus('user-a')).status, 'connected');
  assert.equal((await agent.getStatus('user-b')).status, 'connected');
});
