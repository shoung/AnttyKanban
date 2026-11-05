import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { authenticateFirebaseIdentity, getAdminAuth } from '../server/firebase.js';
import {
  createMcpLinkService,
  getMcpLinkConfig,
  linkFailure,
  type LinkFirebaseIdentity,
  type McpLinkConfig,
} from '../server/mcpLink.js';
import { createLinkCodeExchange } from '../server/mcpLinkProvider.js';
import { firestoreLinkRepository } from '../server/mcpLinkStore.js';
import { getMcpOAuthConfig } from '../server/mcpOAuth.js';
import {
  assertMcpRequestOrigin,
  consumeMcpQuota,
  getMcpConfig,
  jsonResponse,
  LocalRateLimiter,
  readBoundedJson,
  safeMcpError,
  type McpConfig,
} from '../server/mcpHttp.js';

export const config = { api: { bodyParser: false } };
const cookieName = '__Host-antty_mcp_link';
const cookie = (value: string, seconds: number) =>
  `${cookieName}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${seconds}`;
function browserSecret(req: IncomingMessage) {
  const parts = (req.headers.cookie ?? '')
    .split(';')
    .map((value) => value.trim())
    .filter((value) => value.startsWith(`${cookieName}=`));
  if (parts.length !== 1) return linkFailure();
  return parts[0].slice(cookieName.length + 1);
}
type Operations = ReturnType<typeof createMcpLinkService>;
interface Dependencies {
  config(): { settings: McpConfig; link: McpLinkConfig | null };
  authenticate(req: IncomingMessage): Promise<LinkFirebaseIdentity>;
  quota(key: string, limit: number, windowMs: number): Promise<void>;
  service(config: McpLinkConfig): Operations;
}
export function createMcpLinkHandler(
  dependencies: Dependencies = {
    config: () => {
      const settings = getMcpConfig();
      return { settings, link: getMcpLinkConfig(getMcpOAuthConfig(settings)) };
    },
    authenticate: authenticateFirebaseIdentity,
    quota: consumeMcpQuota,
    service: (link) =>
      createMcpLinkService(link, {
        repository: firestoreLinkRepository(),
        getAccount: (uid) => getAdminAuth().getUser(uid),
        exchange: createLinkCodeExchange(link),
      }),
  },
) {
  const limiter = new LocalRateLimiter(60, 60_000);
  return async function handle(req: IncomingMessage & { body?: unknown }, res: ServerResponse) {
    try {
      const { settings, link } = dependencies.config();
      assertMcpRequestOrigin(
        req.headers,
        settings,
        req.method === 'POST' || req.method === 'DELETE',
      );
      limiter.consume(req.socket.remoteAddress ?? 'unknown');
      if (!link) return jsonResponse(res, 503, { error: 'Identity linking is not configured' });
      const query = new URL(req.url ?? '/', settings.origin).searchParams;
      const callback = query.get('action') === 'callback';
      const allowedQuery = callback
        ? ['action', 'code', 'state', 'iss', 'error', 'error_description']
        : req.method === 'GET'
          ? ['after']
          : [];
      if (
        [...query.keys()].some(
          (key) => !allowedQuery.includes(key) || query.getAll(key).length !== 1,
        )
      )
        return linkFailure();
      const service = dependencies.service(link);
      if (callback) {
        if (req.method !== 'GET') return linkFailure();
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Referrer-Policy', 'no-referrer');
        let result = 'failed';
        try {
          if (query.has('error')) return linkFailure();
          await service.complete({
            state: query.get('state') ?? '',
            issuer: query.get('iss') ?? '',
            code: query.get('code') ?? '',
            browserSecret: browserSecret(req),
          });
          res.setHeader('Set-Cookie', cookie('', 0));
          result = 'success';
        } catch {
          /* Never return provider details, codes or identity tokens in the redirect. */
        }
        res.statusCode = 303;
        res.setHeader('Location', `${settings.origin}/?mcpLink=${result}`);
        return res.end();
      }
      if (!['GET', 'POST', 'DELETE'].includes(req.method ?? '')) {
        res.setHeader('Allow', 'GET, POST, DELETE');
        return jsonResponse(res, 405, { error: 'Method not allowed' });
      }
      const identity = await dependencies.authenticate(req);
      await dependencies.quota(`mcp-link-management:${identity.uid}`, 60, 60_000);
      if (req.method === 'GET') {
        const after = z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional()
          .parse(query.get('after') ?? undefined);
        const rows = await service.list(identity.uid, after);
        const links = rows.slice(0, 50);
        return jsonResponse(res, 200, {
          configured: true,
          authorizationOrigin: new URL(link.oauth.issuer).origin,
          endpoint: link.oauth.resource,
          scopes: ['maps:read'],
          days: 7,
          links,
          ...(rows.length > 50 ? { nextAfter: links.at(-1)!.id } : {}),
        });
      }
      if (req.method === 'POST') {
        z.object({ consent: z.literal(true) })
          .strict()
          .parse(await readBoundedJson(req, 1024));
        await dependencies.quota(`mcp-link-issuance:${identity.uid}`, 10, 3_600_000);
        const started = await service.begin(identity);
        res.setHeader('Set-Cookie', cookie(started.browserSecret, 300));
        return jsonResponse(res, 200, { authorizationUrl: started.authorizationUrl });
      }
      const input = z
        .object({ id: z.string().regex(/^[a-f0-9]{64}$/) })
        .strict()
        .parse(await readBoundedJson(req, 1024));
      await service.revoke(identity.uid, input.id);
      return jsonResponse(res, 200, { revoked: true });
    } catch (error) {
      const failure = safeMcpError(error);
      if (failure.status === 429) res.setHeader('Retry-After', '60');
      return jsonResponse(res, failure.status, { error: failure.error });
    }
  };
}
export default createMcpLinkHandler();
