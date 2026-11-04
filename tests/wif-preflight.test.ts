import test from 'node:test';
import assert from 'node:assert/strict';
import * as preflight from '../scripts/wif-readonly-preflight.mjs';
const { runPreflight } = preflight;
type DiagnosticOptions = NonNullable<Parameters<typeof preflight.diagnoseCredentials>[0]>;
const env = {
  VERCEL_ENV: 'production',
  FIREBASE_PROJECT_ID: 'antboard-2025',
  FIREBASE_ADMIN_AUTH_MODE: 'vercel-wif',
};
function setup(failure?: 'auth' | 'firestore') {
  const output: unknown[][] = [];
  const calls: unknown[] = [];
  return {
    output,
    calls,
    options: {
      env,
      diagnose: async (options: DiagnosticOptions) => {
        void options;
      },
      report: (...args: unknown[]) => {
        output.push(args);
      },
      load: async () =>
        ({
          getAdminAuth: () => ({
            getUser: async (uid: string) => {
              calls.push(['user', uid]);
              throw Object.assign(new Error('private provider message'), {
                code: failure === 'auth' ? 'auth/insufficient-permission' : 'auth/user-not-found',
              });
            },
          }),
          getAdminDb: () => ({
            doc: (path: string) => {
              calls.push(['path', path]);
              return path;
            },
            runTransaction: async (
              callback: (transaction: { get: (ref: unknown) => Promise<unknown> }) => Promise<void>,
              options: unknown,
            ) => {
              calls.push(options);
              await callback({
                get: async () => {
                  if (failure === 'firestore')
                    throw Object.assign(new Error('secret error body'), { code: 7 });
                  return {
                    data: () => {
                      throw Error('must not inspect data');
                    },
                  };
                },
              });
            },
            terminate: async () => {
              calls.push('terminated');
            },
          }),
        }) as unknown as typeof import('../server/firebase.ts'),
    },
  };
}
test('preflight reads only synthetic Auth UID and document in read-only transaction', async () => {
  const s = setup();
  assert.equal(await runPreflight(s.options), true);
  assert.deepEqual(s.calls, [
    ['user', '__antty_wif_readonly_probe__'],
    { readOnly: true },
    ['path', '_antty_probe/no-write-check'],
    'terminated',
  ]);
  assert.deepEqual(s.output.at(-1), ['WIF_PREFLIGHT_OK']);
});
test('preflight refuses emulators, non-production and wrong project before loading clients', async () => {
  for (const extra of [
    { VERCEL_ENV: 'preview' },
    { FIREBASE_PROJECT_ID: 'other' },
    { FIREBASE_AUTH_EMULATOR_HOST: 'localhost:9099' },
    { FIRESTORE_EMULATOR_HOST: 'localhost:8080' },
  ]) {
    const s = setup();
    assert.equal(await runPreflight({ ...s.options, env: { ...env, ...extra } }), false);
    assert.deepEqual(s.calls, []);
  }
});
test('preflight failure output never includes SDK messages, stacks or data', async () => {
  for (const failure of ['auth', 'firestore'] as const) {
    const s = setup(failure);
    assert.equal(await runPreflight(s.options), false);
    assert.doesNotMatch(JSON.stringify(s.output), /secret|private|Error|stack/);
    assert.equal(s.output.at(-1)?.[0], 'WIF_PREFLIGHT_FAILED');
  }
});

test('unexpected synthetic-user collision does not count as successful authorization test', async () => {
  const s = setup();
  const original = s.options.load;
  s.options.load = async () => {
    const clients = await original();
    return {
      ...clients,
      getAdminAuth: () => ({ getUser: async () => ({ privateData: 'not logged' }) }),
    } as unknown as typeof import('../server/firebase.ts');
  };
  assert.equal(await runPreflight(s.options), false);
  assert.deepEqual(s.output, [['WIF_PREFLIGHT_FAILED', 'auth', 'unavailable', 'unknown_http']]);
});

const diagnosticStages = ['oidc_acquire', 'sts', 'impersonation'] as const;
function diagnosticSetup(
  failure?: (typeof diagnosticStages)[number],
  errorCode: unknown = 'invalid_grant',
  httpStatus: unknown = 403,
) {
  const calls: string[] = [];
  const audience =
    'https://iam.googleapis.com/projects/376367007034/locations/global/workloadIdentityPools/antty-vercel/providers/production';
  const impersonationUrl =
    'https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/antty-runtime@antboard-2025.iam.gserviceaccount.com:generateAccessToken';
  const fail = (stage: (typeof diagnosticStages)[number]) => {
    calls.push(stage);
    if (failure === stage)
      throw Object.assign(new Error('private response with secret token'), {
        code: 'untrusted-code-with-secret',
        response: {
          status: httpStatus,
          data: { error: errorCode, error_description: 'secret token body' },
        },
      });
  };
  const sdk = {
    wifConfiguration: () => ({
      projectId: 'antboard-2025',
      options: {
        audience: audience.replace('https:', ''),
        subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
        token_url: 'https://sts.googleapis.com/v1/token',
        scopes: ['https://www.googleapis.com/auth/cloud-platform'],
        service_account_impersonation_url: impersonationUrl,
      },
    }),
    getVercelOidcToken: async () => {
      fail('oidc_acquire');
      return 'secret-default-token';
    },
    IdentityPoolClient: class {
      credentials = { expiry_date: Date.now() + 3600000 };
      constructor(
        private options: { subject_token_supplier: { getSubjectToken: () => Promise<string> } },
      ) {
        assert.equal('service_account_impersonation_url' in options, false);
        assert.equal('projectId' in options, false);
      }
      async getAccessToken() {
        assert.equal(
          await this.options.subject_token_supplier.getSubjectToken(),
          'secret-default-token',
        );
        fail('sts');
        return { token: 'secret-sts-token' };
      }
      async request(options: unknown) {
        assert.deepEqual(options, {
          url: impersonationUrl,
          method: 'POST',
          data: { scope: ['https://www.googleapis.com/auth/cloud-platform'], lifetime: '3600s' },
        });
        fail('impersonation');
        return {
          data: {
            accessToken: 'secret-service-account-token',
            expireTime: new Date(Date.now() + 3600000).toISOString(),
          },
        };
      }
    },
  };
  const s = setup();
  s.options.diagnose = async (options: DiagnosticOptions) => {
    assert.equal(typeof preflight['diagnoseCredentials'], 'function');
    return preflight['diagnoseCredentials']({
      ...options,
      load: async () =>
        sdk as unknown as Awaited<ReturnType<NonNullable<DiagnosticOptions['load']>>>,
    });
  };
  return { ...s, diagnosticCalls: calls };
}

test('diagnostics distinguish each credential boundary and stop before data probes on failure', async () => {
  for (const stage of diagnosticStages) {
    const s = diagnosticSetup(stage);
    assert.equal(await runPreflight(s.options), false);
    assert.deepEqual(s.output.at(-1), ['WIF_PREFLIGHT_FAILED', stage, 'invalid_grant', 403]);
    assert.deepEqual(
      s.diagnosticCalls,
      diagnosticStages.slice(0, diagnosticStages.indexOf(stage) + 1),
    );
    assert.deepEqual(s.calls, []);
    assert.doesNotMatch(JSON.stringify(s.output), /secret|private|untrusted|stack/);
  }
});

test('diagnostics keep unknown upstream codes private and retain an allowlisted HTTP status', async () => {
  const s = diagnosticSetup('sts', 'secret-upstream-code');
  assert.equal(await runPreflight(s.options), false);
  assert.deepEqual(s.output.at(-1), ['WIF_PREFLIGHT_FAILED', 'sts', 'unavailable', 403]);
  assert.doesNotMatch(JSON.stringify(s.output), /secret|private|untrusted/);
});

test('diagnostics allow only exact Google status and HTTP enums, never response objects', async () => {
  for (const fixture of [
    {
      code: { status: 'PERMISSION_DENIED', message: 'secret body' },
      http: 403,
      want: ['PERMISSION_DENIED', 403],
    },
    {
      code: { status: 'secret-status', message: 'secret body' },
      http: 'secret-http',
      want: ['unavailable', 'unknown_http'],
    },
    { code: ['invalid_grant', 'secret'], http: 599, want: ['unavailable', 'unknown_http'] },
  ]) {
    const s = diagnosticSetup('impersonation', fixture.code, fixture.http);
    assert.equal(await runPreflight(s.options), false);
    assert.deepEqual(s.output.at(-1), ['WIF_PREFLIGHT_FAILED', 'impersonation', ...fixture.want]);
    assert.doesNotMatch(JSON.stringify(s.output), /secret|message|body|untrusted/);
  }
});

test('successful staged diagnostics continue the real read-only probes without logging tokens', async () => {
  const s = diagnosticSetup();
  assert.equal(await runPreflight(s.options), true);
  assert.deepEqual(s.diagnosticCalls, diagnosticStages);
  assert.deepEqual(
    s.output.map((line) => line[0]),
    [
      'WIF_OIDC_ACQUIRE_OK',
      'WIF_STS_OK',
      'WIF_IMPERSONATION_OK',
      'WIF_AUTH_LOOKUP_OK',
      'WIF_FIRESTORE_READ_TRANSACTION_OK',
      'WIF_PREFLIGHT_OK',
    ],
  );
  assert.doesNotMatch(JSON.stringify(s.output), /secret|private|token/);
});
