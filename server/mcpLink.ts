import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { enforceUid } from './authPolicy.js';
import { assertActiveMcpAccount } from './mcpPolicy.js';
import { oauthBindingId, type McpOAuthBinding, type McpOAuthConfig } from './mcpOAuth.js';

export const linkFailure = (status = 400): never => {
  throw Object.assign(
    new Error(
      status === 503
        ? 'Identity linking is unavailable'
        : status === 401
          ? 'Recent sign-in is required'
          : status === 409
            ? 'Identity is already linked to another account'
            : 'Invalid or expired identity link',
    ),
    { status },
  );
};
const opaque = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const client = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const secret = () => randomBytes(32).toString('base64url');
export const invalidLinkText = (value: string) =>
  /\s/u.test(value) ||
  [...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
export interface McpLinkConfig {
  oauth: McpOAuthConfig;
  clientId: string;
  callbackUrl: string;
}
/** Personal pilot only: standard Auth0 tenant, one MCP client, a distinct public link client. */
export function getMcpLinkConfig(
  oauth: McpOAuthConfig | null,
  env: Record<string, string | undefined> = process.env,
): McpLinkConfig | null {
  if (env.ANTTY_MCP_FIREBASE_OAUTH_ENABLED === 'true' || env.ANTTY_MCP_LINK_ENABLED !== 'true')
    return null;
  if (!oauth) return linkFailure(503);
  try {
    const issuer = new URL(oauth.issuer);
    const clientId = client.parse(env.ANTTY_MCP_LINK_CLIENT_ID);
    if (
      issuer.protocol !== 'https:' ||
      issuer.pathname !== '/' ||
      issuer.search ||
      issuer.hash ||
      issuer.username ||
      issuer.password ||
      issuer.port ||
      !/^[a-z0-9-]+(?:\.[a-z0-9-]+)?\.auth0\.com$/.test(issuer.hostname) ||
      oauth.jwksUri !== `${issuer.href}.well-known/jwks.json` ||
      oauth.algorithm !== 'RS256' ||
      oauth.clientIds.length !== 1 ||
      oauth.clientIds.includes(clientId) ||
      !oauth.scopes.includes('maps:read')
    )
      return linkFailure(503);
    return {
      oauth,
      clientId,
      callbackUrl: `${new URL(oauth.resource).origin}/api/mcp-link?action=callback`,
    };
  } catch {
    return linkFailure(503);
  }
}
const attemptSchema = z
  .object({
    ownerUid: z.string(),
    firebaseAuthTime: z.number().int().nonnegative(),
    createdAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().positive(),
    browserHash: z.string().regex(/^[a-f0-9]{64}$/),
    fingerprint: z.string(),
    revocationEpoch: opaque,
    nonce: opaque,
    verifier: opaque,
  })
  .strict();
export type LinkAttempt = z.infer<typeof attemptSchema>;
export interface LinkSummary {
  id: string;
  subject: string;
  expiresAt: number;
  enabled: boolean;
}
export interface LinkRepository {
  put(id: string, attempt: Omit<LinkAttempt, 'revocationEpoch'>): Promise<void>;
  /** Atomically validate and delete; wrong browser must not consume another browser's attempt. */
  take(id: string, browserHash: string, fingerprint: string, now: number): Promise<LinkAttempt>;
  /** Atomically refuse reassignment, including expired or revoked subjects. */
  bind(id: string, binding: McpOAuthBinding, attempt: LinkAttempt): Promise<void>;
  list(uid: string, after?: string): Promise<LinkSummary[]>;
  revoke(uid: string, id: string): Promise<void>;
}
export function validateLinkAttempt(
  value: unknown,
  browserHash: string,
  fingerprint: string,
  now: number,
): LinkAttempt {
  const parsed = attemptSchema.safeParse(value);
  if (!parsed.success) return linkFailure();
  const row = parsed.data;
  if (
    row.browserHash !== browserHash ||
    row.fingerprint !== fingerprint ||
    row.createdAt > now ||
    row.expiresAt <= now ||
    row.expiresAt - row.createdAt !== 300_000 ||
    row.firebaseAuthTime > row.createdAt ||
    row.createdAt - row.firebaseAuthTime > 300_000
  )
    return linkFailure();
  enforceUid(row.ownerUid);
  return row;
}
interface Dependencies {
  repository: LinkRepository;
  getAccount(uid: string): Promise<{ disabled: boolean; tokensValidAfterTime?: string }>;
  exchange(code: string, verifier: string, nonce: string): Promise<string>;
  now?: () => number;
}
export interface LinkFirebaseIdentity {
  uid: string;
  authTime: number;
}
export function createMcpLinkService(config: McpLinkConfig, dependencies: Dependencies) {
  const fingerprint = hash(JSON.stringify(config));
  const now = dependencies.now ?? Date.now;
  const checkAccount = async (uid: string, authTime: number) => {
    const account = await dependencies.getAccount(uid).catch((error: unknown) => {
      if ((error as { code?: string }).code === 'auth/user-not-found') return linkFailure(401);
      return linkFailure(503);
    });
    assertActiveMcpAccount(account, authTime);
  };
  return {
    async begin(identity: LinkFirebaseIdentity) {
      const uid = enforceUid(identity.uid);
      const timestamp = now();
      if (
        !Number.isSafeInteger(identity.authTime) ||
        identity.authTime > timestamp ||
        timestamp - identity.authTime > 300_000
      )
        return linkFailure(401);
      await checkAccount(uid, identity.authTime);
      const state = secret(),
        browserSecret = secret(),
        nonce = secret(),
        verifier = secret();
      await dependencies.repository.put(hash(state), {
        ownerUid: uid,
        firebaseAuthTime: identity.authTime,
        createdAt: timestamp,
        expiresAt: timestamp + 300_000,
        browserHash: hash(browserSecret),
        nonce,
        verifier,
        fingerprint,
      });
      const url = new URL('authorize', config.oauth.issuer);
      url.search = new URLSearchParams({
        response_type: 'code',
        client_id: config.clientId,
        redirect_uri: config.callbackUrl,
        scope: 'openid',
        state,
        nonce,
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256',
        max_age: '0',
        prompt: 'login',
      }).toString();
      return { authorizationUrl: url.href, browserSecret };
    },
    async complete(input: { state: string; browserSecret: string; issuer: string; code: string }) {
      if (
        !opaque.safeParse(input.state).success ||
        !opaque.safeParse(input.browserSecret).success ||
        input.issuer !== config.oauth.issuer ||
        !input.code ||
        input.code.length > 2048 ||
        invalidLinkText(input.code)
      )
        return linkFailure();
      const timestamp = now();
      // Consume before any external exchange: network failures require a fresh explicit link.
      const attempt = await dependencies.repository.take(
        hash(input.state),
        hash(input.browserSecret),
        fingerprint,
        timestamp,
      );
      await checkAccount(attempt.ownerUid, attempt.firebaseAuthTime);
      const subject = await dependencies.exchange(input.code, attempt.verifier, attempt.nonce);
      if (
        typeof subject !== 'string' ||
        subject.length < 1 ||
        subject.length > 512 ||
        invalidLinkText(subject)
      )
        return linkFailure(401);
      await checkAccount(attempt.ownerUid, attempt.firebaseAuthTime);
      const completedAt = now();
      if (attempt.expiresAt <= completedAt) return linkFailure();
      const binding: McpOAuthBinding = {
        schemaVersion: 1,
        issuer: config.oauth.issuer,
        subject,
        ownerUid: attempt.ownerUid,
        clientIds: [...config.oauth.clientIds],
        scopes: ['maps:read'],
        enabled: true,
        firebaseAuthTime: attempt.firebaseAuthTime,
        validAfter: Math.floor(completedAt / 1000) * 1000,
        expiresAt: completedAt + 7 * 86_400_000,
      };
      await dependencies.repository.bind(oauthBindingId(binding.issuer, subject), binding, attempt);
    },
    list: (uid: string, after?: string) => {
      if (after !== undefined && !/^[a-f0-9]{64}$/.test(after)) return linkFailure();
      return dependencies.repository.list(enforceUid(uid), after);
    },
    revoke: (uid: string, id: string) => {
      if (!/^[a-f0-9]{64}$/.test(id)) return linkFailure();
      return dependencies.repository.revoke(enforceUid(uid), id);
    },
  };
}
