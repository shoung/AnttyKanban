import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { authenticateFirebaseIdentity, getAdminAuth } from '../server/firebase.js';
import {
  createFirebaseOAuthService,
  getFirebaseOAuthConfig,
  oauthError,
  type FirebaseOAuthConfig,
} from '../server/mcpFirebaseOAuth.js';
import { firestoreOAuthRepository } from '../server/mcpFirebaseOAuthStore.js';
import {
  assertMcpRequestOrigin,
  consumeMcpQuota,
  getMcpConfig,
  jsonResponse,
  LocalRateLimiter,
  readBoundedJson,
  safeMcpError,
} from '../server/mcpHttp.js';

export const config = { api: { bodyParser: false } };
const cookieName = '__Host-antty_mcp_oauth';
const cookie = (value: string, seconds: number) =>
  `${cookieName}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${seconds}`;
const browser = (req: IncomingMessage) => {
  const values = (req.headers.cookie ?? '')
    .split(';')
    .map((x) => x.trim())
    .filter((x) => x.startsWith(`${cookieName}=`));
  if (values.length !== 1) return oauthError();
  return values[0].slice(cookieName.length + 1);
};
type Service = ReturnType<typeof createFirebaseOAuthService>;
interface Dependencies {
  config(): FirebaseOAuthConfig | null;
  service(config: FirebaseOAuthConfig): Service;
  authenticate(req: IncomingMessage): Promise<{ uid: string; authTime: number }>;
  quota(key: string, limit: number, windowMs: number): Promise<void>;
}
async function readForm(req: IncomingMessage & { body?: unknown }) {
  if (!/^application\/x-www-form-urlencoded(?:\s*;|$)/i.test(req.headers['content-type'] ?? ''))
    return oauthError('invalid_request', 415);
  const length = req.headers['content-length'];
  if (length && (!/^\d+$/.test(length) || Number(length) > 8192))
    return oauthError('invalid_request', 413);
  let body: string;
  if (req.body !== undefined) {
    if (typeof req.body !== 'string') return oauthError('invalid_request');
    body = req.body;
  } else {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > 8192) return oauthError('invalid_request', 413);
      chunks.push(bytes);
    }
    body = Buffer.concat(chunks).toString('utf8');
  }
  if (Buffer.byteLength(body) > 8192) return oauthError('invalid_request', 413);
  return new URLSearchParams(body);
}
export function createFirebaseOAuthHandler(
  dependencies: Dependencies = {
    config: () => getFirebaseOAuthConfig(getMcpConfig()),
    service: (settings) =>
      createFirebaseOAuthService(settings, {
        repository: firestoreOAuthRepository(),
        getAccount: (uid) => getAdminAuth().getUser(uid),
      }),
    authenticate: authenticateFirebaseIdentity,
    quota: consumeMcpQuota,
  },
) {
  const limiter = new LocalRateLimiter(60, 60_000);
  return async function handle(req: IncomingMessage & { body?: unknown }, res: ServerResponse) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    try {
      const settings = dependencies.config();
      if (!settings) return oauthError('temporarily_unavailable', 503);
      // Discovery and top-level authorization navigation are cross-origin by design.
      // Host is always fixed; credential-bearing endpoints enforce Origin below.
      assertMcpRequestOrigin({ ...req.headers, origin: undefined }, settings, false);
      limiter.consume(req.socket.remoteAddress ?? 'unknown');
      if ((req.url?.length ?? 0) > 8192) return oauthError('invalid_request', 413);
      const url = new URL(req.url ?? '/', settings.origin);
      const query = url.searchParams;
      if (query.getAll('action').length > 1) return oauthError('invalid_request');
      const action = query.get('action') ?? url.pathname.split('/').at(-1);
      query.delete('action');
      if (
        !['metadata', 'authorize', 'consent', 'token', 'revoke', 'connections'].includes(
          action ?? '',
        )
      )
        return oauthError('invalid_request', 404);
      const read = req.method === 'GET';
      if (
        (['metadata', 'authorize'].includes(action!) && !read) ||
        (['token', 'revoke'].includes(action!) && req.method !== 'POST') ||
        (['consent', 'connections'].includes(action!) &&
          !['GET', 'POST', 'DELETE'].includes(req.method ?? ''))
      )
        return oauthError('invalid_request', 405);
      if (action === 'metadata') {
        if ([...query].length) return oauthError('invalid_request');
        res.setHeader('Access-Control-Allow-Origin', '*');
        return jsonResponse(res, 200, {
          issuer: settings.issuer,
          authorization_endpoint: `${settings.origin}/oauth/authorize`,
          token_endpoint: `${settings.origin}/oauth/token`,
          revocation_endpoint: `${settings.origin}/oauth/revoke`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code'],
          token_endpoint_auth_methods_supported: ['none'],
          revocation_endpoint_auth_methods_supported: ['none'],
          code_challenge_methods_supported: ['S256'],
          scopes_supported: settings.scopes,
          authorization_response_iss_parameter_supported: true,
        });
      }
      if (action !== 'authorize') assertMcpRequestOrigin(req.headers, settings, false);
      const service = dependencies.service(settings);
      if (action === 'authorize') {
        // Global persisted budgets bound active five-minute requests to at most 600,
        // and total stored requests to 300/hour without paid TTL or a scheduler.
        await dependencies.quota('oauth-authorize:global:minute', 120, 60_000);
        await dependencies.quota('oauth-authorize:global:hour', 300, 3_600_000);
        await dependencies.quota(
          `oauth-authorize:peer:${req.socket.remoteAddress ?? 'unknown'}`,
          10,
          60_000,
        );
        const pending = await service.begin(query);
        res.setHeader('Set-Cookie', cookie(pending.browserSecret, 300));
        res.statusCode = 303;
        res.setHeader(
          'Location',
          `${settings.origin}/mcp/consent?request=${encodeURIComponent(pending.id)}`,
        );
        return res.end();
      }
      if (action === 'token' || action === 'revoke') {
        if ([...query].length || req.headers.authorization) return oauthError('invalid_request');
        await dependencies.quota('oauth-token:global', 120, 60_000);
        const form = await readForm(req);
        if (action === 'revoke') {
          await service.revokeToken(form);
          return jsonResponse(res, 200, {});
        }
        return jsonResponse(res, 200, await service.exchange(form));
      }
      const mutation = req.method !== 'GET';
      assertMcpRequestOrigin(req.headers, settings, mutation);
      const identity = await dependencies.authenticate(req);
      await dependencies.quota(`oauth-manage:${identity.uid}`, 60, 60_000);
      if (action === 'consent') {
        if (read) {
          if ([...query.keys()].some((k) => k !== 'request' || query.getAll(k).length !== 1))
            return oauthError('invalid_request');
          return jsonResponse(
            res,
            200,
            await service.details(identity, query.get('request') ?? '', browser(req)),
          );
        }
        if (req.method !== 'POST' || [...query].length) return oauthError('invalid_request');
        const input = z
          .object({ request: z.string().max(100), approve: z.boolean() })
          .strict()
          .parse(await readBoundedJson(req, 1024));
        await dependencies.quota(`oauth-consent:${identity.uid}`, 10, 3_600_000);
        const result = await service.decide(identity, input.request, browser(req), input.approve);
        res.setHeader('Set-Cookie', cookie('', 0));
        return jsonResponse(res, 200, result);
      }
      if (read) {
        if ([...query.keys()].some((k) => k !== 'after' || query.getAll(k).length !== 1))
          return oauthError('invalid_request');
        const rows = await service.list(identity.uid, query.get('after') ?? undefined),
          grants = rows.slice(0, 50);
        return jsonResponse(res, 200, {
          endpoint: settings.resource,
          scopes: settings.scopes,
          grants,
          ...(rows.length > 50 ? { nextAfter: grants.at(-1)!.id } : {}),
        });
      }
      if (req.method !== 'DELETE' || [...query].length) return oauthError('invalid_request');
      const input = z
        .object({ id: z.string().regex(/^[a-f0-9]{64}$/) })
        .strict()
        .parse(await readBoundedJson(req, 1024));
      await service.revoke(identity.uid, input.id);
      return jsonResponse(res, 200, { revoked: true });
    } catch (failure) {
      const safe = safeMcpError(failure);
      const error =
        (failure as { error?: string }).error ??
        (safe.status === 503
          ? 'temporarily_unavailable'
          : safe.status === 401
            ? 'login_required'
            : safe.status >= 500
              ? 'server_error'
              : 'invalid_request');
      if (safe.status === 429) res.setHeader('Retry-After', '60');
      return jsonResponse(res, safe.status, { error });
    }
  };
}
export default createFirebaseOAuthHandler();
