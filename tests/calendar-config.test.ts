import assert from 'node:assert/strict';
import test from 'node:test';
import { calendarConfig } from '../server/calendar/config.ts';
import { googleGateway } from '../server/calendar/google.ts';

const env = {
  FIREBASE_PROJECT_ID: 'firebase-project',
  GOOGLE_CALENDAR_PROJECT_ID: 'human-calendar-project',
  GOOGLE_CALENDAR_CLIENT_ID: 'public-client-id',
  GOOGLE_CALENDAR_CLIENT_SECRET: 'server-only-secret',
  CALENDAR_APP_ORIGIN: 'https://app.example',
  CALENDAR_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString('base64'),
};

test('configuration fails closed without credentials and rejects attacker-controlled or insecure origins', () => {
  assert.throws(() => calendarConfig({}));
  for (const origin of [
    'https://app.example/path',
    'http://app.example',
    'https://app.example/',
    'https://u:p@app.example',
    'javascript:alert(1)',
  ]) {
    assert.throws(() => calendarConfig({ ...env, CALENDAR_APP_ORIGIN: origin }));
  }
  assert.equal(calendarConfig(env).redirectUri, 'https://app.example/api/calendar?action=callback');
  assert.equal(
    calendarConfig({ ...env, CALENDAR_APP_ORIGIN: 'http://localhost:3000' }).appOrigin,
    'http://localhost:3000',
  );
});

test('official OAuth URL requests offline scoped consent with state and S256, never the secret', () => {
  const url = new URL(
    googleGateway(calendarConfig(env)).authorizationUrl({
      state: 'random-state',
      challenge: 'pkce-challenge',
    }),
  );
  assert.equal(url.origin, 'https://accounts.google.com');
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('state'), 'random-state');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('code_challenge'), 'pkce-challenge');
  assert.equal(url.searchParams.get('include_granted_scopes'), 'false');
  assert.equal(
    url.searchParams.get('scope'),
    'openid https://www.googleapis.com/auth/calendar.events.owned',
  );
  assert.ok(!url.toString().includes('server-only-secret'));
});

const agentEnv = {
  ...env,
  GOOGLE_CALENDAR_AGENT_PROJECT_ID: 'agent-calendar-project',
  GOOGLE_CALENDAR_AGENT_CLIENT_ID: 'agent-client-id',
  GOOGLE_CALENDAR_AGENT_CLIENT_SECRET: 'agent-only-secret',
  CALENDAR_AGENT_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 4).toString('base64'),
  GOOGLE_CALENDAR_AGENT_CLIENT_CONFIRMED: 'true',
};

test('agent configuration never falls back to human credentials and has a separate callback', () => {
  assert.throws(() => calendarConfig(env, 'agent'));
  const human = calendarConfig(agentEnv);
  const agent = calendarConfig(agentEnv, 'agent');
  assert.equal(agent.channel, 'agent');
  assert.equal(human.channel, 'ui');
  assert.equal(agent.redirectUri, 'https://app.example/api/calendar-agent?action=callback');
  assert.equal(agent.clientId, 'agent-client-id');
  assert.equal(agent.projectId, 'agent-calendar-project');
  assert.notEqual(agent.encryptionKey, human.encryptionKey);
  assert.equal(human.redirectUri, 'https://app.example/api/calendar?action=callback');
});

test('agent setup requires different declared project, client, key and confirmed agent declaration', () => {
  for (const patch of [
    { GOOGLE_CALENDAR_AGENT_PROJECT_ID: env.GOOGLE_CALENDAR_PROJECT_ID },
    { GOOGLE_CALENDAR_AGENT_CLIENT_ID: env.GOOGLE_CALENDAR_CLIENT_ID },
    { CALENDAR_AGENT_TOKEN_ENCRYPTION_KEY: env.CALENDAR_TOKEN_ENCRYPTION_KEY },
    { GOOGLE_CALENDAR_AGENT_CLIENT_CONFIRMED: undefined },
    { GOOGLE_CALENDAR_AGENT_CLIENT_CONFIRMED: 'false' },
    { GOOGLE_CALENDAR_PROJECT_ID: undefined },
    { GOOGLE_CALENDAR_CLIENT_SECRET: undefined },
  ])
    assert.throws(() => calendarConfig({ ...agentEnv, ...patch }, 'agent'));
  // Missing or broken agent setup never blocks the independently configured interactive UI.
  assert.equal(
    calendarConfig({ ...env, GOOGLE_CALENDAR_AGENT_CLIENT_CONFIRMED: 'false' }).channel,
    'ui',
  );
  assert.equal(
    calendarConfig({ ...env, GOOGLE_CALENDAR_PROJECT_ID: env.FIREBASE_PROJECT_ID }).channel,
    'ui',
  );
});

test('human and agent consent URLs contain only their own client and callback with identical narrow scopes', () => {
  for (const channel of ['ui', 'agent'] as const) {
    const config = calendarConfig(agentEnv, channel);
    const url = new URL(
      googleGateway(config).authorizationUrl({ state: 'state', challenge: 'challenge' }),
    );
    assert.equal(url.searchParams.get('client_id'), config.clientId);
    assert.equal(url.searchParams.get('redirect_uri'), config.redirectUri);
    assert.equal(
      url.searchParams.get('scope'),
      'openid https://www.googleapis.com/auth/calendar.events.owned',
    );
    assert.equal(url.searchParams.get('include_granted_scopes'), 'false');
    assert.ok(!url.toString().includes('secret'));
  }
});

test('declared project IDs and client IDs reject noncanonical values instead of bypassing isolation comparisons', () => {
  for (const project of [
    'human-calendar-project ',
    ' Human-calendar-project',
    'Human-calendar-project',
    '',
    'short',
    '-human-project',
    'human-project-',
    'x'.repeat(31),
  ]) {
    assert.throws(() => calendarConfig({ ...env, GOOGLE_CALENDAR_PROJECT_ID: project }));
    assert.throws(() =>
      calendarConfig({ ...agentEnv, GOOGLE_CALENDAR_AGENT_PROJECT_ID: project }, 'agent'),
    );
  }
  for (const clientId of [
    'public-client-id ',
    ' public-client-id',
    'public client-id',
    'public\nclient-id',
  ]) {
    assert.throws(() => calendarConfig({ ...env, GOOGLE_CALENDAR_CLIENT_ID: clientId }));
    assert.throws(() =>
      calendarConfig({ ...agentEnv, GOOGLE_CALENDAR_AGENT_CLIENT_ID: clientId }, 'agent'),
    );
  }
});
