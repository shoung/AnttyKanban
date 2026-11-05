import { decodeProtectedHeader, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { createMcpOAuthKeyResolver } from './mcpOAuth.js';
import { invalidLinkText, linkFailure, type McpLinkConfig } from './mcpLink.js';

/** An OIDC identity proof is accepted only by the linking flow, never by the MCP resource. */
export function createLinkIdentityVerifier(
  config: McpLinkConfig,
  key: JWTVerifyGetKey,
  now = Date.now,
) {
  return async (token: string, nonce: string): Promise<string> => {
    try {
      if (typeof token !== 'string' || token.length > 8192) return linkFailure(401);
      const header = decodeProtectedHeader(token);
      if (
        header.typ !== 'JWT' ||
        header.jku !== undefined ||
        header.jwk !== undefined ||
        header.x5u !== undefined
      )
        return linkFailure(401);
      const timestamp = now();
      const { payload } = await jwtVerify(token, key, {
        algorithms: ['RS256'],
        issuer: config.oauth.issuer,
        audience: config.clientId,
        requiredClaims: ['iss', 'sub', 'aud', 'iat', 'exp', 'nonce', 'auth_time'],
        maxTokenAge: 300,
        clockTolerance: 0,
        currentDate: new Date(timestamp),
      });
      if (
        payload.aud !== config.clientId ||
        (payload.azp !== undefined && payload.azp !== config.clientId) ||
        payload.nonce !== nonce ||
        !Number.isSafeInteger(payload.iat) ||
        payload.iat! * 1000 > timestamp ||
        !Number.isSafeInteger(payload.auth_time) ||
        (payload.auth_time as number) * 1000 > timestamp ||
        timestamp - (payload.auth_time as number) * 1000 > 300_000 ||
        !Number.isSafeInteger(payload.exp) ||
        payload.exp! <= payload.iat! ||
        typeof payload.sub !== 'string' ||
        !payload.sub.length ||
        payload.sub.length > 512 ||
        invalidLinkText(payload.sub)
      )
        return linkFailure(401);
      return payload.sub;
    } catch {
      return linkFailure(401);
    }
  };
}
export function createLinkCodeExchange(
  config: McpLinkConfig,
  fetcher: typeof fetch = fetch,
  key = createMcpOAuthKeyResolver(config.oauth),
) {
  const verify = createLinkIdentityVerifier(config, key);
  return async (code: string, verifier: string, nonce: string) => {
    try {
      const response = await fetcher(new URL('oauth/token', config.oauth.issuer), {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: config.clientId,
          code,
          code_verifier: verifier,
          redirect_uri: config.callbackUrl,
        }),
      });
      if (
        response.status !== 200 ||
        !response.body ||
        Number(response.headers.get('content-length')) > 32_768
      ) {
        await response.body?.cancel();
        return linkFailure(503);
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.length;
          if (size > 32_768) {
            await reader.cancel();
            return linkFailure(503);
          }
          chunks.push(chunk.value);
        }
      } finally {
        reader.releaseLock();
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        id_token?: unknown;
        refresh_token?: unknown;
      };
      // A link is not an offline grant. Never persist returned provider credentials.
      if (typeof body.id_token !== 'string' || body.refresh_token !== undefined)
        return linkFailure(503);
      return await verify(body.id_token, nonce);
    } catch {
      return linkFailure(503);
    }
  };
}
