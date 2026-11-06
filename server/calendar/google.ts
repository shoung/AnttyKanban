import { CodeChallengeMethod, OAuth2Client } from 'google-auth-library';
import { CALENDAR_SCOPE, CalendarError, type GoogleGateway } from './core.js';
import type { CalendarConfig } from './config.js';

export function googleGateway(config: CalendarConfig): GoogleGateway {
  const client = () =>
    new OAuth2Client({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      redirectUri: config.redirectUri,
    });
  return {
    authorizationUrl({ state, challenge }) {
      return client().generateAuthUrl({
        access_type: 'offline',
        scope: ['openid', CALENDAR_SCOPE],
        state,
        prompt: 'consent select_account',
        include_granted_scopes: false,
        code_challenge: challenge,
        code_challenge_method: CodeChallengeMethod.S256,
      });
    },
    async exchangeCode(code, verifier) {
      try {
        const oauth = client();
        const { tokens } = await oauth.getToken({
          code,
          codeVerifier: verifier,
          redirect_uri: config.redirectUri,
        });
        if (!tokens.id_token) throw new CalendarError('GOOGLE_IDENTITY_REQUIRED');
        const ticket = await oauth.verifyIdToken({
          idToken: tokens.id_token,
          audience: config.clientId,
        });
        const payload = ticket.getPayload();
        if (!payload?.sub) throw new CalendarError('GOOGLE_IDENTITY_REQUIRED');
        return {
          subject: payload.sub,
          refreshToken: tokens.refresh_token ?? undefined,
          grantedScopes: (tokens.scope ?? '').split(' ').filter(Boolean),
        };
      } catch (error) {
        if (error instanceof CalendarError) throw error;
        // OAuth library errors can contain codes, client secrets and HTTP request bodies. Never forward them.
        throw new CalendarError('OAUTH_EXCHANGE_FAILED', 502);
      }
    },
    async refreshAccessToken(refreshToken) {
      try {
        const oauth = client();
        oauth.setCredentials({ refresh_token: refreshToken });
        const result = await oauth.getAccessToken();
        if (!result.token) throw new CalendarError('RECONNECT_REQUIRED', 401);
        return result.token;
      } catch (error) {
        if (error instanceof CalendarError) throw error;
        const data = (error as { response?: { data?: { error?: string } } }).response?.data;
        if (data?.error === 'invalid_grant') throw new CalendarError('RECONNECT_REQUIRED', 401);
        throw new CalendarError('GOOGLE_UNAVAILABLE', 502);
      }
    },
    async revokeToken(refreshToken) {
      const response = await fetch('https://oauth2.googleapis.com/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: refreshToken }),
        signal: AbortSignal.timeout(15_000),
      });
      // A revoked/expired token can already be invalid; only Google's explicit invalid_token is idempotent success.
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as { error?: string };
        if (response.status !== 400 || data.error !== 'invalid_token')
          throw new CalendarError('GOOGLE_UNAVAILABLE', 502);
      }
    },
    async request(token, path, method, body, etag) {
      if (
        !path.startsWith('/calendars/primary/events') ||
        path.includes('..') ||
        !['GET', 'POST', 'PATCH', 'DELETE'].includes(method)
      )
        throw new CalendarError('INVALID_REQUEST');
      // Once a write is dispatched, a transport/server failure cannot prove it did not commit.
      const unavailable = () =>
        new CalendarError(method === 'GET' ? 'GOOGLE_UNAVAILABLE' : 'GOOGLE_WRITE_UNCERTAIN', 502);
      let response: Response;
      try {
        response = await fetch(`https://www.googleapis.com/calendar/v3${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            ...(etag ? { 'If-Match': etag } : {}),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(15_000),
        });
      } catch {
        throw unavailable();
      }
      if (!response.ok) {
        if (response.status === 412) throw new CalendarError('EVENT_CHANGED', 409);
        if (response.status === 404 || response.status === 410)
          throw new CalendarError('EVENT_NOT_FOUND', 404);
        if (response.status === 401) throw new CalendarError('RECONNECT_REQUIRED', 401);
        if (response.status === 403) {
          const data = (await response.json().catch(() => null)) as {
            error?: { errors?: Array<{ reason?: string }> };
          } | null;
          if (
            Array.isArray(data?.error?.errors) &&
            data.error.errors.some((error) =>
              ['rateLimitExceeded', 'userRateLimitExceeded'].includes(error?.reason ?? ''),
            )
          )
            throw new CalendarError('RATE_LIMITED', 429);
          throw new CalendarError('GOOGLE_PERMISSION_DENIED', 403);
        }
        if (response.status === 429) throw new CalendarError('RATE_LIMITED', 429);
        throw unavailable();
      }
      if (response.status === 204 && method === 'DELETE') return undefined;
      try {
        const data: unknown = await response.json();
        const preflight = method === 'GET' && /^\/calendars\/primary\/events\//.test(path);
        if (method === 'POST' || method === 'PATCH' || preflight) {
          // Reject malformed acknowledgements and fail closed before using a preflight for a write.
          const event = data as Record<string, unknown> | null;
          const organizer = event?.organizer as { self?: unknown } | undefined;
          const hasDate = (value: unknown) => {
            const date = value as Record<string, unknown> | null;
            return date && (typeof date.date === 'string' || typeof date.dateTime === 'string');
          };
          if (
            !event ||
            typeof event.id !== 'string' ||
            !event.id ||
            typeof event.etag !== 'string' ||
            !event.etag ||
            !hasDate(event.start) ||
            !hasDate(event.end) ||
            (preflight && typeof organizer?.self !== 'boolean')
          )
            throw unavailable();
        }
        return data;
      } catch {
        // JSON/body stream errors can include upstream data; never forward those details.
        throw unavailable();
      }
    },
  };
}
