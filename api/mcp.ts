import type { IncomingMessage, ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { bearerToken } from '../server/authPolicy.js';
import { authenticateMcpToken } from '../server/mcpTokens.js';
import { createMcpDataService } from '../server/mcpData.js';
import { createMcpServer, type McpDataService } from '../server/mcpServer.js';
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
import type { McpPrincipal } from '../server/mcpPolicy.js';

// Disable platform eager parsing so oversized bodies never reach the SDK.
export const config = { api: { bodyParser: false } };
interface Dependencies {
  config(): McpConfig;
  authenticate(token: string): Promise<McpPrincipal>;
  quota(key: string, limit: number, windowMs: number): Promise<void>;
  data(): McpDataService;
}
export function createMcpHandler(
  dependencies: Dependencies = {
    config: getMcpConfig,
    authenticate: authenticateMcpToken,
    quota: consumeMcpQuota,
    data: createMcpDataService,
  },
) {
  const preAuthLimiter = new LocalRateLimiter(120, 60_000);
  return async function handle(req: IncomingMessage & { body?: unknown }, res: ServerResponse) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      const settings = dependencies.config();
      assertMcpRequestOrigin(req.headers, settings, false);
      preAuthLimiter.consume(req.socket.remoteAddress ?? 'unknown');
      const principal = await dependencies.authenticate(bearerToken(req.headers.authorization));
      await dependencies.quota(`mcp:${principal.uid}`, 120, 60_000);
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return jsonResponse(res, 405, { error: 'This stateless MCP endpoint accepts POST only' });
      }
      const body = await readBoundedJson(req, 512_000);
      if (!body || typeof body !== 'object' || Array.isArray(body))
        return jsonResponse(res, 400, { error: 'A single JSON-RPC message is required' });
      const server = createMcpServer(principal, dependencies.data());
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
        enableDnsRebindingProtection: true,
        allowedHosts: [settings.host],
        allowedOrigins: [settings.origin],
      });
      res.once('close', () => {
        void server.close().catch(() => undefined);
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (error) {
      const failure = safeMcpError(error);
      if (failure.status === 401) res.setHeader('WWW-Authenticate', 'Bearer realm="antty-mcp"');
      if (failure.status === 429) res.setHeader('Retry-After', '60');
      if (!res.headersSent) jsonResponse(res, failure.status, { error: failure.error });
    }
  };
}
export default createMcpHandler();
