import { applicationDefault, type Credential } from 'firebase-admin/app';
import { IdentityPoolClient, type IdentityPoolClientOptions } from 'google-auth-library';
import { getVercelOidcToken } from '@vercel/oidc';

type Environment = Record<string, string | undefined>;
const unavailable = () =>
  Object.assign(new Error('Backend credentials unavailable'), { status: 503 });
const notConfigured = (): never => {
  throw Object.assign(new Error('Backend credentials are not configured'), { status: 503 });
};
export function adminAuthMode(
  env: Environment = process.env,
): 'vercel-wif' | 'application-default' {
  if (env.FIREBASE_ADMIN_AUTH_MODE === 'vercel-wif') return 'vercel-wif';
  if (
    env.FIREBASE_ADMIN_AUTH_MODE === 'application-default' &&
    env.VERCEL !== '1' &&
    env.NODE_ENV !== 'production'
  )
    return 'application-default';
  return notConfigured();
}
// Keep Vercel's default Team audience in the subject JWT. The Google STS
// request audience below identifies the provider; it is not the JWT audience.
export interface WifConfiguration {
  projectId: string;
  options: Omit<IdentityPoolClientOptions, 'subject_token_supplier'>;
}
export function wifConfiguration(env: Environment = process.env): WifConfiguration {
  const projectId = env.FIREBASE_PROJECT_ID || '';
  const number = env.GCP_PROJECT_NUMBER || '';
  const account = env.GCP_SERVICE_ACCOUNT_EMAIL || '';
  const pool = env.GCP_WORKLOAD_IDENTITY_POOL_ID || '';
  const provider = env.GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID || '';
  if (
    env.VERCEL_ENV !== 'production' ||
    !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId) ||
    !/^[0-9]{6,20}$/.test(number) ||
    !/^[a-z][a-z0-9-]{0,31}$/.test(pool) ||
    !/^[a-z][a-z0-9-]{0,31}$/.test(provider) ||
    !new RegExp(
      `^[a-z0-9][a-z0-9-]{4,28}[a-z0-9]@${projectId}\\.iam\\.gserviceaccount\\.com$`,
    ).test(account)
  )
    return notConfigured();
  const resource = `iam.googleapis.com/projects/${number}/locations/global/workloadIdentityPools/${pool}/providers/${provider}`;
  return {
    projectId,
    options: {
      audience: `//${resource}`,
      subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
      token_url: 'https://sts.googleapis.com/v1/token',
      service_account_impersonation_url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${account}:generateAccessToken`,
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    },
  };
}
interface GoogleTokenClient {
  credentials: { expiry_date?: number | null };
  getAccessToken(): Promise<{ token?: string | null }>;
}
interface WifDependencies {
  token(): Promise<string>;
  client(options: IdentityPoolClientOptions): GoogleTokenClient;
}
/** Adapts short-lived Vercel OIDC → Google STS/SA impersonation to Firebase's Credential interface. */
export function createWifCredential(
  config: WifConfiguration,
  deps: WifDependencies = {
    token: () => getVercelOidcToken(),
    client: (options) => new IdentityPoolClient(options),
  },
): Credential {
  const client = deps.client({
    ...config.options,
    subject_token_supplier: { getSubjectToken: () => deps.token() },
  });
  return {
    async getAccessToken() {
      try {
        const { token } = await client.getAccessToken();
        const expiry = client.credentials.expiry_date;
        if (!token || typeof expiry !== 'number' || !Number.isFinite(expiry)) throw unavailable();
        const expires = Math.floor((expiry - Date.now()) / 1000);
        if (expires <= 0) throw unavailable();
        return { access_token: token, expires_in: expires };
      } catch {
        throw unavailable();
      } // Never forward upstream bodies, OIDC tokens, or credential material.
    },
  };
}
export function wifAuthClient(
  config: WifConfiguration,
  token: () => Promise<string> = () => getVercelOidcToken(),
): IdentityPoolClient {
  return new IdentityPoolClient({
    ...config.options,
    subject_token_supplier: {
      getSubjectToken: () => token(),
    },
  });
}
export function adminCredential(env: Environment = process.env): Credential {
  return adminAuthMode(env) === 'vercel-wif'
    ? createWifCredential(wifConfiguration(env))
    : applicationDefault();
}

/** Firebase Auth wraps custom credential failures; preserve outage vs sign-in semantics. */
export function isCredentialUnavailable(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const value = error as { status?: unknown; code?: unknown; cause?: { status?: unknown } };
  return (
    value.status === 503 || (value.code === 'app/invalid-credential' && value.cause?.status === 503)
  );
}
