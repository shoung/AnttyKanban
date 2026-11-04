import test from 'node:test';
import assert from 'node:assert/strict';
import {
  wifConfiguration,
  createWifCredential,
  adminAuthMode,
  wifAuthClient,
} from '../server/adminCredentials.ts';
const env = {
  FIREBASE_PROJECT_ID: 'antboard-2025',
  FIREBASE_ADMIN_AUTH_MODE: 'vercel-wif',
  GCP_PROJECT_NUMBER: '376367007034',
  GCP_SERVICE_ACCOUNT_EMAIL: 'antty-runtime@antboard-2025.iam.gserviceaccount.com',
  GCP_WORKLOAD_IDENTITY_POOL_ID: 'antty-vercel',
  GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID: 'production',
  VERCEL_ENV: 'production',
};
test('WIF config binds Google exchanges to fixed endpoints and this Firebase project', () => {
  const c = wifConfiguration(env);
  assert.equal(c.projectId, 'antboard-2025');
  assert.equal(c.options.token_url, 'https://sts.googleapis.com/v1/token');
  assert.equal(
    c.options.audience,
    '//iam.googleapis.com/projects/376367007034/locations/global/workloadIdentityPools/antty-vercel/providers/production',
  );
  assert.match(
    c.options.service_account_impersonation_url!,
    /antty-runtime@antboard-2025\.iam\.gserviceaccount\.com:generateAccessToken$/,
  );
  for (const change of [
    { GCP_PROJECT_NUMBER: 'https://evil.test' },
    { GCP_SERVICE_ACCOUNT_EMAIL: 'other@other-project.iam.gserviceaccount.com' },
    { GCP_WORKLOAD_IDENTITY_POOL_ID: '../escape' },
    { FIREBASE_PROJECT_ID: '' },
    { VERCEL_ENV: 'preview' },
  ])
    assert.throws(() => wifConfiguration({ ...env, ...change }), /configured/);
});
test('runtime credentials require explicit mode, never silently fall back to ADC on Vercel', () => {
  assert.equal(
    adminAuthMode({ FIREBASE_ADMIN_AUTH_MODE: 'application-default', NODE_ENV: 'development' }),
    'application-default',
  );
  for (const change of [
    {},
    { FIREBASE_ADMIN_AUTH_MODE: 'unknown' },
    { FIREBASE_ADMIN_AUTH_MODE: 'application-default', VERCEL: '1' },
  ])
    assert.throws(() => adminAuthMode(change));
});
test('WIF credential supplies fresh Vercel tokens to Google library and preserves real expiry', async () => {
  const calls: unknown[][] = [];
  const expiry = Date.now() + 600_000;
  let supplier: () => Promise<string> = async () => '';
  const credential = createWifCredential(wifConfiguration(env), {
    token: async (...args) => {
      calls.push(args);
      return 'synthetic-vercel-token';
    },
    client: (options) => {
      supplier = () => options.subject_token_supplier!.getSubjectToken({} as never);
      return {
        credentials: { expiry_date: expiry },
        getAccessToken: async () => {
          assert.equal(await supplier(), 'synthetic-vercel-token');
          return { token: 'synthetic-google-token' };
        },
      };
    },
  });
  const result = await credential.getAccessToken();
  assert.equal(result.access_token, 'synthetic-google-token');
  assert.ok(result.expires_in > 590 && result.expires_in <= 600);
  assert.deepEqual(calls, [[]]);
});
test('credential failures never expose upstream credentials and reject missing or expired tokens', async () => {
  for (const response of [
    { token: null, expiry: Date.now() + 60_000 },
    { token: 'synthetic', expiry: Date.now() - 1 },
    { token: 'synthetic', expiry: undefined },
  ]) {
    const c = createWifCredential(wifConfiguration(env), {
      token: async () => '',
      client: () => ({
        credentials: { expiry_date: response.expiry },
        getAccessToken: async () => ({ token: response.token }),
      }),
    });
    await assert.rejects(c.getAccessToken(), /unavailable/);
  }
  const c = createWifCredential(wifConfiguration(env), {
    token: async () => '',
    client: () => ({
      credentials: {},
      getAccessToken: async () => {
        throw new Error('secret token in upstream body');
      },
    }),
  });
  await assert.rejects(
    c.getAccessToken(),
    (e) =>
      e instanceof Error &&
      e.message === 'Backend credentials unavailable' &&
      (e as Error & { status: number }).status === 503,
  );
});

test('Firestore accepts explicit WIF auth without Firebase custom-credential rejection', async () => {
  const previous = { ...process.env };
  Object.assign(process.env, env);
  try {
    const { getAdminDb } = await import('../server/firebase.ts');
    const db = getAdminDb();
    assert.equal((db as unknown as { projectId: string }).projectId, env.FIREBASE_PROJECT_ID);
    assert.equal(db.doc('users/test/boards/default').path, 'users/test/boards/default');
    // Inspect the client factory's actual auth path offline, not merely constructor success.
    const settings = (db as unknown as { _settings: Record<string, unknown> })._settings;
    const { GoogleAuth, IdentityPoolClient } = await import('google-auth-library');
    assert.ok(settings.authClient instanceof IdentityPoolClient);
    const auth = new GoogleAuth(settings);
    assert.equal(await auth.getClient(), settings.authClient);
    await db.terminate();
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  }
});

test('Firebase Auth wrapped credential outages remain 503 rather than invalid-user 401', async () => {
  const { initializeApp, deleteApp } = await import('firebase-admin/app');
  const { getAuth } = await import('firebase-admin/auth');
  const { isCredentialUnavailable } = await import('../server/adminCredentials.ts');
  const app = initializeApp(
    {
      projectId: 'antboard-2025',
      credential: {
        getAccessToken: async () => {
          throw Object.assign(new Error('Backend credentials unavailable'), { status: 503 });
        },
      },
    },
    'wif-error-regression',
  );
  try {
    await assert.rejects(getAuth(app).getUser('synthetic-user'), (error) => {
      assert.equal(isCredentialUnavailable(error), true);
      return true;
    });
    assert.equal(isCredentialUnavailable({ code: 'auth/id-token-revoked' }), false);
  } finally {
    await deleteApp(app);
  }
});

test('Firestore WIF preserves the default Vercel token audience without custom exchange', async () => {
  const calls: unknown[][] = [];
  const client = wifAuthClient(wifConfiguration(env), async (...args) => {
    calls.push(args);
    return 'synthetic-team-audience-token';
  });
  assert.equal(await client.retrieveSubjectToken(), 'synthetic-team-audience-token');
  assert.deepEqual(calls, [[]]);
});
