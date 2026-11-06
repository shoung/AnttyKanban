import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { enforceUid } from './authPolicy.js';
import {
  allowedScopes,
  assertActiveMcpAccount,
  tokenHash,
  type McpPrincipal,
  type McpScope,
} from './mcpPolicy.js';
import type { McpConfig } from './mcpHttp.js';

const secret = () => randomBytes(32).toString('base64url');
const hash = (value: string) => tokenHash(value);
const secretSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const scopesSchema = z
  .array(z.enum(allowedScopes))
  .min(1)
  .max(6)
  .refine((x) => new Set(x).size === x.length);
const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const clientSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/),
    name: z.string().trim().min(1).max(100),
    redirectUris: z.array(z.string().url().max(2048)).min(1).max(5),
  })
  .strict();
export interface FirebaseOAuthConfig {
  /** Server-only, required pilot boundary. Never advertise this UID in metadata. */
  testUid: string;
  origin: string;
  host: string;
  issuer: string;
  resource: string;
  metadataUrl: string;
  scopes: McpScope[];
  clients: z.infer<typeof clientSchema>[];
}
class OAuthRequestError extends Error {
  readonly error: string;
  readonly status: number;
  constructor(error: string, status: number) {
    super('OAuth request could not be completed');
    this.error = error;
    this.status = status;
  }
}
export function oauthError(error = 'invalid_grant', status = 400): never {
  throw new OAuthRequestError(error, status);
}
export function getFirebaseOAuthConfig(
  settings: McpConfig,
  env: Record<string, string | undefined> = process.env,
): FirebaseOAuthConfig | null {
  if (env.ANTTY_MCP_FIREBASE_OAUTH_ENABLED !== 'true') return null;
  try {
    const url = new URL(settings.origin);
    if (
      url.protocol !== 'https:' ||
      url.origin !== settings.origin ||
      url.host !== settings.host ||
      env.ANTTY_MCP_OAUTH_ENABLED === 'true' ||
      env.ANTTY_MCP_LINK_ENABLED === 'true'
    )
      throw new Error();
    const clients = z
      .array(clientSchema)
      .min(1)
      .max(5)
      .parse(JSON.parse(env.ANTTY_MCP_FIREBASE_OAUTH_CLIENTS ?? 'null'));
    if (new Set(clients.map((c) => c.id)).size !== clients.length) throw new Error();
    for (const c of clients) {
      if (new Set(c.redirectUris).size !== c.redirectUris.length) throw new Error();
      for (const redirect of c.redirectUris) {
        const u = new URL(redirect);
        if (
          u.protocol !== 'https:' ||
          u.username ||
          u.password ||
          u.hash ||
          u.href !== redirect ||
          ['code', 'state', 'error', 'iss'].some((k) => u.searchParams.has(k))
        )
          throw new Error();
      }
    }
    const scopes = scopesSchema.parse(
      (env.ANTTY_MCP_FIREBASE_OAUTH_SCOPES ?? 'maps:read').split(' '),
    );
    const testUid = z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,128}$/)
      .parse(env.ANTTY_MCP_FIREBASE_OAUTH_TEST_UID);
    return {
      testUid,
      ...settings,
      issuer: settings.origin,
      resource: `${settings.origin}/api/mcp`,
      metadataUrl: `${settings.origin}/.well-known/oauth-protected-resource/api/mcp`,
      clients,
      scopes,
    };
  } catch {
    return oauthError('server_error', 503);
  }
}

const requestSchema = z
  .object({
    clientId: z.string(),
    redirectUri: z.string(),
    resource: z.string(),
    scopes: scopesSchema,
    state: z.string().max(1024),
    challenge: secretSchema,
    browserHash: hashSchema,
    createdAt: time,
    expiresAt: time,
    used: z.boolean(),
    ownerUid: z.string().optional(),
    ownerEpoch: secretSchema.optional(),
  })
  .strict();
const grantSchema = z
  .object({
    ownerUid: z.string(),
    clientId: z.string(),
    redirectUri: z.string(),
    resource: z.string(),
    scopes: scopesSchema,
    createdAt: time,
    expiresAt: time,
    authTime: time,
    enabled: z.boolean(),
  })
  .strict();
const codeSchema = z
  .object({ grantId: hashSchema, challenge: secretSchema, expiresAt: time, used: z.boolean() })
  .strict();
const tokenSchema = z.object({ grantId: hashSchema, createdAt: time, expiresAt: time }).strict();
export type OAuthTable = 'requests' | 'owners' | 'grants' | 'codes' | 'tokens';
export interface OAuthTransaction {
  get(table: OAuthTable, id: string): Promise<unknown>;
  set(table: OAuthTable, id: string, row: unknown): void;
}
export interface OAuthRepository {
  transaction<T>(work: (tx: OAuthTransaction) => Promise<T>): Promise<T>;
  listGrants(uid: string, after?: string): Promise<{ id: string; row: unknown }[]>;
}
interface Identity {
  uid: string;
  authTime: number;
}
interface Dependencies {
  repository: OAuthRepository;
  getAccount(uid: string): Promise<{ disabled: boolean; tokensValidAfterTime?: string }>;
  now?: () => number;
}
function params(input: URLSearchParams, allowed: string[]) {
  if ([...input.keys()].some((k) => !allowed.includes(k) || input.getAll(k).length !== 1))
    oauthError('invalid_request');
  return Object.fromEntries(input.entries());
}
const same = (value: string, expected: string) => {
  const bytes = Buffer.from(hash(value));
  const other = Buffer.from(expected);
  return bytes.length === other.length && timingSafeEqual(bytes, other);
};
export function createFirebaseOAuthService(
  config: FirebaseOAuthConfig,
  dependencies: Dependencies,
) {
  // Only our own authorization decisions and stored-record validation failures are
  // auth failures. SDK/transport errors (including unknown codes) fail closed as
  // service outages, without exposing upstream messages or prompting reauthorization.
  async function backend<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (failure) {
      if (failure instanceof OAuthRequestError || failure instanceof z.ZodError) throw failure;
      return oauthError('temporarily_unavailable', 503);
    }
  }
  const repository: OAuthRepository = {
    transaction: (work) => backend(() => dependencies.repository.transaction(work)),
    listGrants: (uid, after) => backend(() => dependencies.repository.listGrants(uid, after)),
  };
  const now = dependencies.now ?? Date.now;
  const client = (id: string, redirect?: string) => {
    const value = config.clients.find((c) => c.id === id);
    if (!value || (redirect !== undefined && !value.redirectUris.includes(redirect)))
      return oauthError();
    return value;
  };
  const account = async (uid: string, authTime?: number) => {
    let user: Awaited<ReturnType<Dependencies['getAccount']>>;
    try {
      enforceUid(uid);
    } catch {
      return oauthError();
    }
    if (uid !== config.testUid) return oauthError('access_denied', 403);
    try {
      user = await dependencies.getAccount(uid);
    } catch (failure) {
      if ((failure as { code?: unknown })?.code === 'auth/user-not-found') return oauthError();
      return oauthError('temporarily_unavailable', 503);
    }
    try {
      assertActiveMcpAccount(user, authTime);
    } catch {
      return oauthError();
    }
  };
  const bound = (row: z.infer<typeof requestSchema>, browser: string) => {
    if (
      !secretSchema.safeParse(browser).success ||
      !same(browser, row.browserHash) ||
      row.used ||
      row.expiresAt <= now()
    )
      oauthError();
    client(row.clientId, row.redirectUri);
    if (row.resource !== config.resource || row.scopes.some((s) => !config.scopes.includes(s)))
      oauthError();
  };
  const grantActive = (grant: z.infer<typeof grantSchema>) => {
    client(grant.clientId, grant.redirectUri);
    if (
      !grant.enabled ||
      grant.expiresAt <= now() ||
      grant.resource !== config.resource ||
      grant.scopes.some((s) => !config.scopes.includes(s))
    )
      oauthError();
  };
  return {
    async begin(input: URLSearchParams) {
      const p = params(input, [
        'response_type',
        'client_id',
        'redirect_uri',
        'resource',
        'scope',
        'state',
        'code_challenge',
        'code_challenge_method',
        // Optional presentation hint sent by hosted ChatGPT; never used for authorization.
        'ui_locales',
      ]);
      if (!p.redirect_uri) return oauthError('invalid_request');
      client(p.client_id, p.redirect_uri);
      const scopes = scopesSchema.safeParse(p.scope?.split(' '));
      if (
        p.response_type !== 'code' ||
        p.resource !== config.resource ||
        p.code_challenge_method !== 'S256' ||
        !secretSchema.safeParse(p.code_challenge).success ||
        !p.state ||
        p.state.length > 1024
      )
        oauthError('invalid_request');
      if (!scopes.success || scopes.data.some((s) => !config.scopes.includes(s)))
        oauthError('invalid_scope');
      const id = secret(),
        browserSecret = secret();
      const createdAt = now();
      await repository.transaction(async (tx) => {
        tx.set('requests', hash(id), {
          clientId: p.client_id,
          redirectUri: p.redirect_uri,
          resource: p.resource,
          scopes: scopes.data,
          state: p.state,
          challenge: p.code_challenge,
          browserHash: hash(browserSecret),
          createdAt,
          expiresAt: createdAt + 300_000,
          used: false,
        });
      });
      return { id, browserSecret };
    },
    async details(identity: Identity, id: string, browser: string) {
      if (!secretSchema.safeParse(id).success) return oauthError();
      await account(identity.uid, identity.authTime);
      const row = await repository.transaction(async (tx) => {
        const request = requestSchema.parse(await tx.get('requests', hash(id)));
        bound(request, browser);
        if (request.ownerUid && request.ownerUid !== identity.uid) oauthError();
        const owner = z
          .object({ epoch: secretSchema })
          .strict()
          .nullable()
          .parse(await tx.get('owners', hash(identity.uid)));
        const epoch = owner?.epoch ?? secret();
        if (request.ownerEpoch && request.ownerEpoch !== epoch) oauthError();
        if (!owner) tx.set('owners', hash(identity.uid), { epoch });
        tx.set('requests', hash(id), { ...request, ownerUid: identity.uid, ownerEpoch: epoch });
        return request;
      });
      return {
        clientName: client(row.clientId).name,
        clientId: row.clientId,
        redirectUri: row.redirectUri,
        resource: row.resource,
        scopes: row.scopes,
        days: 7,
        expiresAt: row.expiresAt,
      };
    },
    async decide(identity: Identity, id: string, browser: string, approve: boolean) {
      if (!secretSchema.safeParse(id).success) return oauthError();
      if (
        approve &&
        (!Number.isSafeInteger(identity.authTime) ||
          now() - identity.authTime > 300_000 ||
          identity.authTime > now() + 30_000)
      )
        return oauthError('login_required', 401);
      await account(identity.uid, identity.authTime);
      const code = secret(),
        grantId = hash(secret());
      return repository.transaction(async (tx) => {
        const request = requestSchema.parse(await tx.get('requests', hash(id)));
        bound(request, browser);
        const owner = z
          .object({ epoch: secretSchema })
          .strict()
          .nullable()
          .parse(await tx.get('owners', hash(identity.uid)));
        if (request.ownerUid !== identity.uid || !owner || request.ownerEpoch !== owner.epoch)
          oauthError();
        tx.set('requests', hash(id), { ...request, used: true });
        const redirect = new URL(request.redirectUri);
        redirect.searchParams.set('state', request.state);
        redirect.searchParams.set('iss', config.issuer);
        if (!approve) redirect.searchParams.set('error', 'access_denied');
        else {
          const createdAt = now();
          tx.set('grants', grantId, {
            ownerUid: identity.uid,
            clientId: request.clientId,
            redirectUri: request.redirectUri,
            resource: request.resource,
            scopes: request.scopes,
            createdAt,
            expiresAt: createdAt + 7 * 86_400_000,
            authTime: identity.authTime,
            enabled: true,
          });
          tx.set('codes', hash(code), {
            grantId,
            challenge: request.challenge,
            expiresAt: createdAt + 60_000,
            used: false,
          });
          redirect.searchParams.set('code', code);
        }
        return { redirectUri: redirect.href };
      });
    },
    async exchange(input: URLSearchParams) {
      const p = params(input, [
        'grant_type',
        'client_id',
        'redirect_uri',
        'resource',
        'code',
        'code_verifier',
      ]);
      if (p.grant_type !== 'authorization_code') return oauthError('unsupported_grant_type');
      if (
        !secretSchema.safeParse(p.code).success ||
        !p.code_verifier ||
        !/^[A-Za-z0-9._~-]{43,128}$/.test(p.code_verifier)
      )
        return oauthError();
      client(p.client_id, p.redirect_uri);
      const token = `anttyoa_${secret()}`;
      const snapshot = await repository.transaction(async (tx) =>
        codeSchema.parse(await tx.get('codes', hash(p.code))),
      );
      const grant = await repository.transaction(async (tx) =>
        grantSchema.parse(await tx.get('grants', snapshot.grantId)),
      );
      await account(grant.ownerUid, grant.authTime);
      const result = await repository.transaction(async (tx) => {
        const code = codeSchema.parse(await tx.get('codes', hash(p.code)));
        const current = grantSchema.parse(await tx.get('grants', code.grantId));
        grantActive(current);
        if (
          code.expiresAt <= now() ||
          current.clientId !== p.client_id ||
          current.redirectUri !== p.redirect_uri ||
          current.resource !== p.resource ||
          createHash('sha256').update(p.code_verifier).digest('base64url') !== code.challenge
        )
          oauthError();
        // Authenticated code replay revokes this grant; invalid proof never burns a code.
        if (code.used) {
          tx.set('grants', code.grantId, { ...current, enabled: false });
          return null;
        }
        const createdAt = now(),
          expiresAt = Math.min(createdAt + 3_600_000, current.expiresAt);
        tx.set('codes', hash(p.code), { ...code, used: true });
        tx.set('tokens', hash(token), { grantId: code.grantId, createdAt, expiresAt });
        return { expiresAt, scope: current.scopes.join(' ') };
      });
      if (!result) return oauthError();
      return {
        access_token: token,
        token_type: 'Bearer' as const,
        expires_in: Math.floor((result.expiresAt - now()) / 1000),
        scope: result.scope,
      };
    },
    async authenticate(token: string): Promise<McpPrincipal> {
      try {
        if (!/^anttyoa_[A-Za-z0-9_-]{43}$/.test(token)) return oauthError('invalid_token', 401);
        const { record, grant } = await repository.transaction(async (tx) => {
          const record = tokenSchema.parse(await tx.get('tokens', hash(token)));
          const grant = grantSchema.parse(await tx.get('grants', record.grantId));
          grantActive(grant);
          if (
            record.expiresAt <= now() ||
            record.createdAt > now() ||
            record.expiresAt > grant.expiresAt
          )
            oauthError('invalid_token', 401);
          return { record, grant };
        });
        await account(grant.ownerUid, Math.min(grant.authTime, record.createdAt));
        return {
          uid: enforceUid(grant.ownerUid),
          scopes: grant.scopes,
          tokenIssuedAt: record.createdAt,
          authentication: 'oauth',
        };
      } catch (failure) {
        if (failure instanceof OAuthRequestError && failure.status === 503) throw failure;
        if (failure instanceof OAuthRequestError || failure instanceof z.ZodError)
          return oauthError('invalid_token', 401);
        return oauthError('temporarily_unavailable', 503);
      }
    },
    async list(uid: string, after?: string) {
      enforceUid(uid);
      if (uid !== config.testUid) return oauthError('access_denied', 403);
      if (after && !hashSchema.safeParse(after).success) return oauthError('invalid_request');
      return (await repository.listGrants(uid, after)).map(({ id, row }) => {
        const grant = grantSchema.parse(row);
        if (grant.ownerUid !== uid) return oauthError();
        return {
          id,
          clientId: grant.clientId,
          clientName: config.clients.find((c) => c.id === grant.clientId)?.name ?? grant.clientId,
          scopes: grant.scopes,
          createdAt: grant.createdAt,
          expiresAt: grant.expiresAt,
          enabled: grant.enabled && grant.expiresAt > now(),
        };
      });
    },
    async revoke(uid: string, id: string) {
      enforceUid(uid);
      if (!hashSchema.safeParse(id).success) return oauthError();
      await repository.transaction(async (tx) => {
        const grant = grantSchema.parse(await tx.get('grants', id));
        if (grant.ownerUid !== uid) oauthError();
        // Epoch invalidates already-open consent, while only this grant's tokens are revoked.
        tx.set('owners', hash(uid), { epoch: secret() });
        tx.set('grants', id, { ...grant, enabled: false });
      });
    },
    async revokeToken(input: URLSearchParams) {
      const p = params(input, ['token', 'token_type_hint', 'client_id']);
      client(p.client_id);
      if (!p.token || p.token.length > 256) return;
      await repository.transaction(async (tx) => {
        const record = tokenSchema.nullable().parse(await tx.get('tokens', hash(p.token)));
        if (!record) return;
        const grant = grantSchema.parse(await tx.get('grants', record.grantId));
        if (grant.clientId !== p.client_id) return;
        tx.set('owners', hash(grant.ownerUid), { epoch: secret() });
        tx.set('grants', record.grantId, { ...grant, enabled: false });
      });
    },
  };
}
