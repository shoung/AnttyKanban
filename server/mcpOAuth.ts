import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import {
  createRemoteJWKSet,
  customFetch,
  decodeProtectedHeader,
  jwtVerify,
  type JWTVerifyGetKey,
} from 'jose';
import { z } from 'zod';
import { enforceUid } from './authPolicy.js';
import { isCredentialUnavailable } from './adminCredentials.js';
import { getAdminAuth, getAdminDb } from './firebase.js';
import {
  allowedScopes,
  assertActiveMcpAccount,
  type McpPrincipal,
  type McpScope,
} from './mcpPolicy.js';
import type { McpConfig } from './mcpHttp.js';

const configurationError = (): never => {
  throw Object.assign(new Error('OAuth access is not configured'), { status: 503 });
};
const unauthorized = (): never => {
  throw Object.assign(new Error('Invalid or unavailable OAuth access'), { status: 401 });
};
const unavailable = (): never => {
  throw Object.assign(new Error('OAuth verification is temporarily unavailable'), { status: 503 });
};
const identifier = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (value) =>
      !/\s/u.test(value) &&
      [...value].every((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127),
  );
const scopesSchema = z
  .array(z.enum(allowedScopes))
  .min(1)
  .max(allowedScopes.length)
  .refine((values) => new Set(values).size === values.length);
const clientIdsSchema = z
  .array(identifier)
  .min(1)
  .max(20)
  .refine((values) => new Set(values).size === values.length);
const bindingSchema = z
  .object({
    schemaVersion: z.literal(1),
    issuer: z.string().max(2048),
    subject: identifier,
    ownerUid: z.string(),
    clientIds: clientIdsSchema,
    scopes: scopesSchema,
    enabled: z.literal(true),
    firebaseAuthTime: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    validAfter: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    expiresAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
export type McpOAuthBinding = z.infer<typeof bindingSchema>;
export interface McpOAuthConfig {
  issuer: string;
  jwksUri: string;
  resource: string;
  metadataUrl: string;
  clientIds: string[];
  scopes: McpScope[];
  algorithm: 'RS256' | 'ES256';
}
function publicHttps(value: string | undefined) {
  if (!value || value.length > 2048) return configurationError();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return configurationError();
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.href !== value ||
    !url.hostname.includes('.') ||
    isIP(url.hostname) ||
    url.hostname.startsWith('[') ||
    /(?:^|\.)(?:localhost|local|internal|test)$/i.test(url.hostname)
  ) {
    return configurationError();
  }
  return url;
}
/** Operator configuration, never values from a token, request, or browser. */
export function getMcpOAuthConfig(
  settings: McpConfig,
  env: Record<string, string | undefined> = process.env,
): McpOAuthConfig | null {
  if (env.ANTTY_MCP_OAUTH_ENABLED !== 'true') return null;
  try {
    const issuer = publicHttps(env.ANTTY_MCP_OAUTH_ISSUER);
    const jwks = publicHttps(env.ANTTY_MCP_OAUTH_JWKS_URI);
    if (issuer.origin !== jwks.origin) configurationError();
    const origin = publicHttps(`${settings.origin}/`);
    if (origin.origin !== settings.origin || origin.host !== settings.host) configurationError();
    const clientIds = clientIdsSchema.parse(JSON.parse(env.ANTTY_MCP_OAUTH_CLIENT_IDS ?? 'null'));
    const scopes = scopesSchema.parse((env.ANTTY_MCP_OAUTH_SCOPES ?? '').split(' '));
    const algorithm = z.enum(['RS256', 'ES256']).parse(env.ANTTY_MCP_OAUTH_ALGORITHM ?? 'RS256');
    return {
      issuer: issuer.href,
      jwksUri: jwks.href,
      resource: `${settings.origin}/api/mcp`,
      metadataUrl: `${settings.origin}/.well-known/oauth-protected-resource/api/mcp`,
      clientIds,
      scopes,
      algorithm,
    };
  } catch {
    return configurationError();
  }
}
export const oauthBindingId = (issuer: string, subject: string) =>
  createHash('sha256')
    .update(JSON.stringify([issuer, subject]))
    .digest('hex');
export interface OAuthBindingRepository {
  get(id: string): Promise<unknown>;
}
export function firestoreOAuthBindings(): OAuthBindingRepository {
  return {
    async get(id) {
      const row = await getAdminDb().collection('mcpOAuthBindings').doc(id).get();
      return row.exists ? row.data() : null;
    },
  };
}
interface Dependencies {
  key: JWTVerifyGetKey;
  bindings: OAuthBindingRepository;
  getAccount(uid: string): Promise<{ disabled: boolean; tokensValidAfterTime?: string }>;
  now?: () => number;
}
/** RFC 9068 access tokens only. A valid signature alone never establishes Firebase ownership. */
export function createMcpOAuthAuthenticator(config: McpOAuthConfig, dependencies: Dependencies) {
  return async (token: string): Promise<McpPrincipal> => {
    try {
      if (typeof token !== 'string' || token.length > 8192 || token.split('.').length !== 3)
        unauthorized();
      const header = decodeProtectedHeader(token);
      // Do not allow a credential to select a key source, even if a library ignores these fields.
      if (header.jku !== undefined || header.x5u !== undefined || header.jwk !== undefined)
        unauthorized();
      const now = (dependencies.now ?? Date.now)();
      const { payload } = await jwtVerify(token, dependencies.key, {
        algorithms: [config.algorithm],
        issuer: config.issuer,
        audience: config.resource,
        typ: 'at+jwt',
        requiredClaims: ['iss', 'sub', 'aud', 'iat', 'exp', 'jti', 'client_id'],
        maxTokenAge: 3600,
        clockTolerance: 0,
        currentDate: new Date(now),
      });
      if (
        !Number.isSafeInteger(payload.iat) ||
        !Number.isSafeInteger(payload.exp) ||
        payload.iat! * 1000 > now ||
        payload.exp! <= payload.iat! ||
        payload.exp! - payload.iat! > 3600
      )
        unauthorized();
      const subject = identifier.parse(payload.sub);
      identifier.parse(payload.jti);
      const clientId = identifier.parse(payload.client_id);
      if (!config.clientIds.includes(clientId)) unauthorized();
      const rawScope = z.string().max(1024).parse(payload.scope);
      const allScopes = z
        .array(z.enum([...allowedScopes, 'openid', 'profile', 'email', 'offline_access']))
        .min(1)
        .max(10)
        .refine((values) => new Set(values).size === values.length)
        .parse(rawScope.split(' '));
      const scopes = scopesSchema.parse(
        allScopes.filter((scope): scope is McpScope => allowedScopes.includes(scope as McpScope)),
      );
      if (scopes.some((scope) => !config.scopes.includes(scope))) unauthorized();
      const row = bindingSchema.parse(
        await dependencies.bindings.get(oauthBindingId(config.issuer, subject)).catch(unavailable),
      );
      if (
        row.issuer !== config.issuer ||
        row.subject !== subject ||
        row.validAfter > payload.iat! * 1000 ||
        row.expiresAt <= now ||
        row.expiresAt <= row.validAfter ||
        row.firebaseAuthTime > now ||
        !row.clientIds.includes(clientId)
      )
        unauthorized();
      const uid = enforceUid(row.ownerUid);
      const permitted = scopes.filter((scope) => row.scopes.includes(scope));
      if (permitted.length === 0) unauthorized();
      const account = await dependencies.getAccount(uid).catch((error: unknown) => {
        if ((error as { code?: unknown })?.code === 'auth/user-not-found') return unauthorized();
        return unavailable();
      });
      // A refresh minted after Firebase revocation must not resurrect the original linking session.
      assertActiveMcpAccount(account, row.firebaseAuthTime);
      assertActiveMcpAccount(account, payload.iat! * 1000);
      return {
        uid,
        scopes: permitted,
        tokenIssuedAt: payload.iat! * 1000,
        authentication: 'oauth',
      };
    } catch (error) {
      if (isCredentialUnavailable(error)) return unavailable();
      return unauthorized();
    }
  };
}
/** A pinned key source, bounded response and no redirects; no credential is sent to the issuer. */
export function createMcpOAuthKeyResolver(
  config: McpOAuthConfig,
  fetcher: typeof fetch = fetch,
): JWTVerifyGetKey {
  const remote = createRemoteJWKSet(new URL(config.jwksUri), {
    timeoutDuration: 5000,
    cooldownDuration: 30_000,
    cacheMaxAge: 300_000,
    [customFetch]: async (url, options) => {
      const response = await fetcher(url, options);
      if (
        response.status !== 200 ||
        !response.body ||
        Number(response.headers.get('content-length')) > 131_072
      ) {
        await response.body?.cancel();
        return unavailable();
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > 131_072) {
            await reader.cancel();
            return unavailable();
          }
          chunks.push(part.value);
        }
      } finally {
        reader.releaseLock();
      }
      return new Response(Buffer.concat(chunks).toString('utf8'), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });
  return async (header, token) => {
    try {
      return await remote(header, token);
    } catch (error) {
      // Unknown or ambiguous signing keys are invalid credentials, not a reason to retry auth.
      if (
        ['ERR_JWKS_NO_MATCHING_KEY', 'ERR_JWKS_MULTIPLE_MATCHING_KEYS'].includes(
          String((error as { code?: unknown })?.code),
        )
      )
        throw error;
      return unavailable();
    }
  };
}
// A single bounded cache per serverless instance; a configuration change discards old trust.
let cached: { fingerprint: string; key: JWTVerifyGetKey } | undefined;
export function authenticateMcpOAuthToken(token: string, config: McpOAuthConfig) {
  const fingerprint = JSON.stringify([config.issuer, config.jwksUri, config.algorithm]);
  if (cached?.fingerprint !== fingerprint) {
    cached = { fingerprint, key: createMcpOAuthKeyResolver(config) };
  }
  return createMcpOAuthAuthenticator(config, {
    key: cached.key,
    bindings: firestoreOAuthBindings(),
    getAccount: (uid) => getAdminAuth().getUser(uid),
  })(token);
}
