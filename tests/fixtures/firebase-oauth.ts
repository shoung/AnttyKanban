import { createHash } from 'node:crypto';
import {
  createFirebaseOAuthService,
  getFirebaseOAuthConfig,
  type OAuthRepository,
} from '../../server/mcpFirebaseOAuth.ts';

export const NOW = 1_800_000_000_000;
export const settings = { origin: 'https://antty.example', host: 'antty.example' };
export const env = {
  ANTTY_MCP_FIREBASE_OAUTH_ENABLED: 'true',
  ANTTY_MCP_FIREBASE_OAUTH_CLIENTS: JSON.stringify([
    { id: 'chatgpt-personal', name: 'My ChatGPT', redirectUris: ['https://chatgpt.com/callback'] },
  ]),
  ANTTY_MCP_FIREBASE_OAUTH_SCOPES: 'maps:read',
};
const verifier = 'v'.repeat(43);
const challenge = createHash('sha256').update(verifier).digest('base64url');
export function memoryOAuthRepository(): OAuthRepository {
  const rows = new Map<string, unknown>();
  let queue: Promise<unknown> = Promise.resolve();
  return {
    transaction: (work) => {
      const run = queue.then(async () => {
        const snapshot = new Map(rows);
        const result = await work({
          get: async (table, id) => structuredClone(snapshot.get(`${table}/${id}`) ?? null),
          set: (table, id, row) => {
            snapshot.set(`${table}/${id}`, structuredClone(row));
          },
        });
        rows.clear();
        snapshot.forEach((row, key) => rows.set(key, row));
        return result;
      });
      queue = run.catch(() => undefined);
      return run;
    },
    listGrants: async (uid, after) =>
      [...rows]
        .filter(
          ([key, row]) =>
            key.startsWith('grants/') &&
            (row as { ownerUid: string }).ownerUid === uid &&
            (!after || key.slice(7) > after),
        )
        .sort(([a], [b]) => a.localeCompare(b))
        .slice(0, 51)
        .map(([key, row]) => ({ id: key.slice(7), row })),
  };
}
export function oauthFixture(repository = memoryOAuthRepository()) {
  const state = { now: NOW, disabled: false, cutoff: NOW - 120_000 };
  const config = getFirebaseOAuthConfig(settings, env)!;
  const service = createFirebaseOAuthService(config, {
    repository,
    now: () => state.now,
    getAccount: async () => ({
      disabled: state.disabled,
      tokensValidAfterTime: new Date(state.cutoff).toISOString(),
    }),
  });
  const identity = { uid: 'alice', authTime: NOW - 30_000 };
  const parameters = new URLSearchParams({
    response_type: 'code',
    client_id: 'chatgpt-personal',
    redirect_uri: 'https://chatgpt.com/callback',
    resource: config.resource,
    scope: 'maps:read',
    state: 'client-state',
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  async function begin() {
    const pending = await service.begin(parameters);
    await service.details(identity, pending.id, pending.browserSecret);
    return pending;
  }
  async function approve() {
    const pending = await begin();
    const result = await service.decide(identity, pending.id, pending.browserSecret, true);
    return { pending, code: new URL(result.redirectUri).searchParams.get('code')! };
  }
  const exchange = (code: string, patch: Record<string, string> = {}) =>
    service.exchange(
      new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: 'chatgpt-personal',
        redirect_uri: 'https://chatgpt.com/callback',
        resource: config.resource,
        code,
        code_verifier: verifier,
        ...patch,
      }),
    );
  return { service, config, state, identity, parameters, begin, approve, exchange };
}
