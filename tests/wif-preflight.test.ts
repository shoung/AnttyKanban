import test from 'node:test';
import assert from 'node:assert/strict';
import { runPreflight } from '../scripts/wif-readonly-preflight.mjs';
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
  assert.deepEqual(s.output, [['WIF_PREFLIGHT_FAILED', 'auth', 'unavailable']]);
});
