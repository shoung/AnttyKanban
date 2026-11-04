import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { authenticateRequest } from '../server/firebase.js';
import {
  createTokenService,
  firestoreTokenRepository,
  type McpTokenSummary,
} from '../server/mcpTokens.js';
import { parseTokenRequest } from '../server/mcpPolicy.js';
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
interface TokenOperations {
  list(uid: string, after?: string): Promise<McpTokenSummary[]>;
  issue(uid: string, input: unknown): Promise<unknown>;
  revoke(uid: string, id: string): Promise<void>;
}
interface Dependencies {
  config(): McpConfig;
  authenticate(req: IncomingMessage): Promise<{ uid: string }>;
  quota(key: string, limit: number, windowMs: number): Promise<void>;
  tokens(): TokenOperations;
}
const revokeSchema = z.object({ id: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export function createAgentTokenHandler(
  dependencies: Dependencies = {
    config: getMcpConfig,
    authenticate: authenticateRequest,
    quota: consumeMcpQuota,
    tokens: () => createTokenService(firestoreTokenRepository()),
  },
) {
  const limiter = new LocalRateLimiter(120, 60_000);
  return async function handle(req: IncomingMessage & { body?: unknown }, res: ServerResponse) {
    try {
      const settings = dependencies.config();
      assertMcpRequestOrigin(
        req.headers,
        settings,
        req.method === 'POST' || req.method === 'DELETE',
      );
      limiter.consume(req.socket.remoteAddress ?? 'unknown');
      const { uid } = await dependencies.authenticate(req);
      await dependencies.quota(`token-management:${uid}`, 120, 60_000);
      if (req.method === 'GET') {
        const query = new URL(req.url ?? '/', settings.origin).searchParams;
        if ([...query.keys()].some((key) => key !== 'after') || query.getAll('after').length > 1)
          return jsonResponse(res, 400, { error: 'Invalid token page query' });
        const after = query.get('after') ?? undefined;
        if (after !== undefined && !/^[a-f0-9]{64}$/.test(after))
          return jsonResponse(res, 400, { error: 'Invalid token page cursor' });
        const rows = await dependencies.tokens().list(uid, after);
        const tokens = rows.slice(0, 50);
        return jsonResponse(res, 200, {
          tokens,
          ...(rows.length > 50 ? { nextAfter: tokens.at(-1)!.id } : {}),
          endpoint: `${settings.origin}/api/mcp`,
          mode: 'personal-bearer',
        });
      }
      if (req.method === 'POST') {
        const input = parseTokenRequest(await readBoundedJson(req, 8192));
        await dependencies.quota(`token-issuance:${uid}`, 10, 3_600_000);
        return jsonResponse(res, 201, await dependencies.tokens().issue(uid, input));
      }
      if (req.method === 'DELETE') {
        const input = revokeSchema.parse(await readBoundedJson(req, 8192));
        await dependencies.tokens().revoke(uid, input.id);
        return jsonResponse(res, 200, { revoked: true });
      }
      res.setHeader('Allow', 'GET, POST, DELETE');
      return jsonResponse(res, 405, { error: 'Method not allowed' });
    } catch (error) {
      const failure = safeMcpError(error);
      if (failure.status === 429) res.setHeader('Retry-After', '60');
      return jsonResponse(res, failure.status, { error: failure.error });
    }
  };
}
export default createAgentTokenHandler();
