import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { CalendarError, type CalendarService, type CalendarStatus } from './core.js';

type Request = IncomingMessage & { body?: unknown };
interface Dependencies {
  authenticate(req: Request): Promise<{ uid: string }>;
  service(): CalendarService;
  status(uid: string): Promise<CalendarStatus>;
  origin(): string;
}
const MAX_BODY_BYTES = 32_768;
async function jsonBody(req: Request): Promise<Record<string, unknown>> {
  if (!req.headers['content-type']?.startsWith('application/json'))
    throw new CalendarError('JSON_REQUIRED', 415);
  let body: unknown = req.body;
  if (body === undefined) {
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      length += buffer.length;
      if (length > MAX_BODY_BYTES) throw new CalendarError('REQUEST_TOO_LARGE', 413);
      chunks.push(buffer);
    }
    body = Buffer.concat(chunks).toString('utf8');
  }
  if (typeof body === 'string' || Buffer.isBuffer(body)) {
    const raw = body.toString();
    if (Buffer.byteLength(raw) > MAX_BODY_BYTES) throw new CalendarError('REQUEST_TOO_LARGE', 413);
    try {
      body = JSON.parse(raw || '{}');
    } catch {
      throw new CalendarError('INVALID_JSON');
    }
  }
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new CalendarError('INVALID_JSON');
  if (Buffer.byteLength(JSON.stringify(body)) > MAX_BODY_BYTES)
    throw new CalendarError('REQUEST_TOO_LARGE', 413);
  return body as Record<string, unknown>;
}
function keys(body: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(body).some((key) => !allowed.includes(key)))
    throw new CalendarError('INVALID_REQUEST');
}
function cookieName(origin: string): string {
  return origin.startsWith('https:') ? '__Host-antty_calendar_oauth' : 'antty_calendar_oauth';
}
function cookie(origin: string, value: string, maxAge: number): string {
  return `${cookieName(origin)}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${origin.startsWith('https:') ? '; Secure' : ''}`;
}
function bindingCookie(req: Request, origin: string): string {
  const prefix = `${cookieName(origin)}=`;
  return (
    (req.headers.cookie ?? '')
      .split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith(prefix))
      ?.slice(prefix.length) ?? ''
  );
}
function send(res: ServerResponse, status: number, data: unknown) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(data));
}
function publicError(error: unknown): { status: number; code: string } {
  if (error instanceof CalendarError) return { status: error.status, code: error.code };
  const status = (error as { status?: number })?.status;
  if (status === 401) return { status: 401, code: 'AUTHENTICATION_REQUIRED' };
  if (status === 503) return { status: 503, code: 'CALENDAR_NOT_CONFIGURED' };
  return { status: 500, code: 'CALENDAR_REQUEST_FAILED' };
}

export function createCalendarHandler(deps: Dependencies) {
  return async function handler(req: Request, res: ServerResponse): Promise<void> {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    const url = new URL(req.url ?? '/', 'https://request.invalid');
    let callbackOrigin: string | undefined;
    try {
      const action = url.searchParams.get('action') ?? 'status';
      if (url.searchParams.getAll('action').length > 1) throw new CalendarError('INVALID_REQUEST');
      if (action === 'callback') {
        if (req.method !== 'GET') throw new CalendarError('METHOD_NOT_ALLOWED', 405);
        callbackOrigin = deps.origin();
        if (url.searchParams.get('error')) throw new CalendarError('OAUTH_CANCELLED');
        if (
          url.searchParams.getAll('code').length !== 1 ||
          url.searchParams.getAll('state').length !== 1
        )
          throw new CalendarError('OAUTH_STATE_INVALID');
        await deps
          .service()
          .completeConnect(
            url.searchParams.get('state') ?? '',
            bindingCookie(req, callbackOrigin),
            url.searchParams.get('code') ?? '',
          );
        res.setHeader('Set-Cookie', cookie(callbackOrigin, '', 0));
        res.statusCode = 303;
        res.setHeader('Location', `${callbackOrigin}/?calendar=connected`);
        res.end();
        return;
      }
      if (!['status', 'connect', 'disconnect', 'events'].includes(action))
        throw new CalendarError('INVALID_REQUEST');
      const allowedQuery =
        action === 'events' && req.method === 'GET'
          ? ['action', 'timeMin', 'timeMax', 'pageToken']
          : ['action'];
      for (const key of url.searchParams.keys()) {
        if (!allowedQuery.includes(key) || url.searchParams.getAll(key).length !== 1)
          throw new CalendarError('INVALID_REQUEST');
      }
      const allowedMethods =
        action === 'status'
          ? ['GET']
          : action === 'events'
            ? ['GET', 'POST', 'PATCH', 'DELETE']
            : ['POST'];
      if (!allowedMethods.includes(req.method ?? '')) {
        res.setHeader('Allow', allowedMethods.join(', '));
        throw new CalendarError('METHOD_NOT_ALLOWED', 405);
      }
      const { uid } = await deps.authenticate(req);
      if (action === 'status') {
        send(res, 200, await deps.status(uid));
        return;
      }
      if (req.method !== 'GET' && req.headers.origin !== deps.origin())
        throw new CalendarError('ORIGIN_NOT_ALLOWED', 403);
      const service = deps.service();
      if (action === 'events' && req.method === 'GET') {
        const input: { timeMin?: string; timeMax?: string; pageToken?: string } = {};
        for (const key of ['timeMin', 'timeMax', 'pageToken'] as const) {
          const value = url.searchParams.get(key);
          if (value !== null) input[key] = value;
        }
        send(res, 200, await service.listEvents(uid, input));
        return;
      }
      const body = await jsonBody(req);
      if (action === 'connect') {
        keys(body, []);
        const binding = randomBytes(32).toString('base64url');
        const result = await service.beginConnect(uid, binding);
        res.setHeader('Set-Cookie', cookie(deps.origin(), binding, 600));
        send(res, 200, result);
        return;
      }
      if (action === 'disconnect') {
        keys(body, ['confirmProjectRevocation']);
        send(res, 200, await service.disconnect(uid, body.confirmProjectRevocation === true));
        return;
      }
      if (req.method === 'POST') {
        send(res, 201, await service.createEvent(uid, body));
        return;
      }
      keys(body, req.method === 'PATCH' ? ['eventId', 'event', 'etag'] : ['eventId', 'etag']);
      if (typeof body.eventId !== 'string' || typeof body.etag !== 'string' || !body.etag)
        throw new CalendarError('EVENT_ETAG_REQUIRED');
      if (req.method === 'PATCH') {
        send(res, 200, await service.updateEvent(uid, body.eventId, body.event, body.etag));
        return;
      }
      await service.deleteEvent(uid, body.eventId, body.etag);
      send(res, 200, { deleted: true });
    } catch (error) {
      const safe = publicError(error);
      if (callbackOrigin) {
        res.setHeader('Set-Cookie', cookie(callbackOrigin, '', 0));
        res.statusCode = 303;
        res.setHeader('Location', `${callbackOrigin}/?calendar=${encodeURIComponent(safe.code)}`);
        res.end();
        return;
      }
      send(res, safe.status, { error: safe.code });
    }
  };
}
