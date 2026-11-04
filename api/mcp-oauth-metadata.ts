import type { IncomingMessage, ServerResponse } from 'node:http';
import { getMcpConfig, jsonResponse, safeMcpError, type McpConfig } from '../server/mcpHttp.js';
import { getMcpOAuthConfig, type McpOAuthConfig } from '../server/mcpOAuth.js';

interface Dependencies {
  config(): McpConfig;
  oauth(settings: McpConfig): McpOAuthConfig | null;
}
/** Public metadata contains no account data. Credential-bearing endpoints keep their origin checks. */
export function createMcpOAuthMetadataHandler(
  dependencies: Dependencies = {
    config: getMcpConfig,
    oauth: getMcpOAuthConfig,
  },
) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      const settings = dependencies.config();
      if (req.headers.host !== settings.host)
        return jsonResponse(res, 403, { error: 'Request origin is not allowed' });
      const oauth = dependencies.oauth(settings);
      if (!oauth) return jsonResponse(res, 404, { error: 'OAuth access is not enabled' });
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
      if (req.method === 'OPTIONS') {
        res.statusCode = 204;
        res.end();
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.setHeader('Allow', 'GET, HEAD, OPTIONS');
        return jsonResponse(res, 405, { error: 'Method not allowed' });
      }
      return jsonResponse(res, 200, {
        resource: oauth.resource,
        authorization_servers: [oauth.issuer],
        scopes_supported: oauth.scopes,
        bearer_methods_supported: ['header'],
        resource_name: 'Antty personal workspace',
      });
    } catch (error) {
      const failure = safeMcpError(error);
      return jsonResponse(res, failure.status, { error: failure.error });
    }
  };
}
export default createMcpOAuthMetadataHandler();
