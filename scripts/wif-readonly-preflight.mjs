import process from 'node:process';
import { writeSync } from 'node:fs';
import { setTimeout, clearTimeout } from 'node:timers';
import { pathToFileURL } from 'node:url';

const allowedCodes = new Set([
  'app/invalid-credential',
  'auth/insufficient-permission',
  'auth/internal-error',
  'invalid_grant',
  'invalid_target',
  'invalid_request',
  'unauthorized_client',
  'access_denied',
  'PERMISSION_DENIED',
  'UNAUTHENTICATED',
  'INVALID_ARGUMENT',
  'NOT_FOUND',
  'RESOURCE_EXHAUSTED',
  'UNAVAILABLE',
  'INTERNAL',
  'DEADLINE_EXCEEDED',
  7,
  16,
  5,
  14,
  4,
]);
const allowedHttpStatuses = new Set([400, 401, 403, 404, 408, 409, 429, 500, 502, 503, 504]);

/** Separates credential boundaries without logging claims, credentials, or response bodies. */
export async function diagnoseCredentials({
  env,
  report,
  setStage,
  load = async () => {
    const [{ wifConfiguration }, { getVercelOidcToken }, { IdentityPoolClient }] =
      await Promise.all([
        import('../server/adminCredentials.ts'),
        import('@vercel/oidc'),
        import('google-auth-library'),
      ]);
    return { wifConfiguration, getVercelOidcToken, IdentityPoolClient };
  },
}) {
  setStage('wif_configuration');
  const { wifConfiguration, getVercelOidcToken, IdentityPoolClient } = await load();
  const config = wifConfiguration(env);
  setStage('oidc_acquire');
  const subjectToken = await getVercelOidcToken();
  if (typeof subjectToken !== 'string' || !subjectToken) throw new Error('Missing token');
  report('WIF_OIDC_ACQUIRE_OK');

  // The provider enforces the default Vercel audience. Do not exchange or decode it.
  const { service_account_impersonation_url: impersonationUrl, ...stsOptions } = config.options;
  setStage('sts');
  const sourceClient = new IdentityPoolClient({
    ...stsOptions,
    subject_token_supplier: { getSubjectToken: async () => subjectToken },
  });
  const { token } = await sourceClient.getAccessToken();
  if (typeof token !== 'string' || !token) throw new Error('Missing token');
  report('WIF_STS_OK');

  // Supported authenticated request uses the cached STS token and the same fixed
  // IAM endpoint, scopes, and lifetime as the production adapter. No project lookup.
  setStage('impersonation');
  const response = await sourceClient.request({
    url: impersonationUrl,
    method: 'POST',
    data: { scope: config.options.scopes, lifetime: '3600s' },
  });
  if (
    typeof response.data?.accessToken !== 'string' ||
    !response.data.accessToken ||
    !(Date.parse(response.data.expireTime) > Date.now())
  )
    throw new Error('Invalid token response');
  report('WIF_IMPERSONATION_OK');
}

/** No writes, token output, document content, or real user identifiers. */
export async function runPreflight({
  env = process.env,
  load = () => import('../server/firebase.ts'),
  diagnose = diagnoseCredentials,
  report = (...values) => {
    writeSync(1, values.join(' ') + '\n');
  },
} = {}) {
  let stage = 'initialize';
  let db;
  try {
    if (
      env.VERCEL_ENV !== 'production' ||
      env.FIREBASE_PROJECT_ID !== 'antboard-2025' ||
      env.FIREBASE_ADMIN_AUTH_MODE !== 'vercel-wif' ||
      env.FIREBASE_AUTH_EMULATOR_HOST ||
      env.FIRESTORE_EMULATOR_HOST
    )
      throw new Error('invalid configuration');
    await diagnose({
      env,
      report,
      setStage: (value) => {
        stage = value;
      },
    });
    stage = 'auth_initialize';
    const { getAdminAuth, getAdminDb } = await load();
    stage = 'auth';
    try {
      await getAdminAuth().getUser('__antty_wif_readonly_probe__');
      throw new Error('Unexpected probe collision');
    } catch (error) {
      if (error?.code !== 'auth/user-not-found') throw error;
    }
    report('WIF_AUTH_LOOKUP_OK');
    stage = 'firestore';
    db = getAdminDb();
    await db.runTransaction(
      async (transaction) => {
        await transaction.get(db.doc('_antty_probe/no-write-check'));
      },
      { readOnly: true },
    );
    report('WIF_FIRESTORE_READ_TRANSACTION_OK');
    stage = 'cleanup';
    await db.terminate();
    db = undefined;
    report('WIF_PREFLIGHT_OK');
    return true;
  } catch (error) {
    const candidates = [
      error?.code,
      error?.response?.data?.error,
      error?.response?.data?.error?.status,
    ];
    report(
      'WIF_PREFLIGHT_FAILED',
      stage,
      candidates.find((code) => allowedCodes.has(code)) ?? 'unavailable',
      allowedHttpStatuses.has(error?.response?.status) ? error.response.status : 'unknown_http',
    );
    return false;
  } finally {
    if (db) await db.terminate().catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Never let SDK exception bodies expose credential material to build logs.
  const fatal = () => {
    writeSync(2, 'WIF_PREFLIGHT_FAILED asynchronous unavailable\n');
    process.exit(1);
  };
  process.on('uncaughtException', fatal);
  process.on('unhandledRejection', fatal);
  const timeout = setTimeout(() => {
    writeSync(2, 'WIF_PREFLIGHT_TIMEOUT\n');
    process.exit(1);
  }, 90000);
  const success = await runPreflight();
  clearTimeout(timeout);
  process.exit(success ? 0 : 1);
}
