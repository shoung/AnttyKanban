import assert from 'node:assert/strict';
import test from 'node:test';
import { calendarConfig } from '../server/calendar/config.ts';
import { googleGateway } from '../server/calendar/google.ts';

const env = {
  FIREBASE_PROJECT_ID: 'test',
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
