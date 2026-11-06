import type { IncomingHttpHeaders, ServerResponse } from 'node:http';
import { ZodError } from 'zod';
import { CalendarError } from './calendar/core.js';
import { getAdminDb } from './firebase.js';
import { tokenHash } from './mcpPolicy.js';

export interface McpConfig {
  origin: string;
  host: string;
}
export function getMcpConfig(env: Record<string, string | undefined> = process.env): McpConfig {
  const fail = (): never => {
    throw Object.assign(new Error('Agent access is not configured'), { status: 503 });
  };
  if (env.ANTTY_MCP_ENABLED !== 'true' || !env.FIREBASE_PROJECT_ID || !env.ANTTY_APP_ORIGIN) fail();
  let url: URL;
  try {
    url = new URL(env.ANTTY_APP_ORIGIN!);
  } catch {
    return fail();
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/' ||
    url.origin !== env.ANTTY_APP_ORIGIN?.replace(/\/$/, '')
  )
    fail();
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && local && env.NODE_ENV !== 'production')
  )
    fail();
  return { origin: url.origin, host: url.host };
}

export function assertMcpRequestOrigin(
  headers: IncomingHttpHeaders,
  config: McpConfig,
  requireOrigin: boolean,
) {
  // Ignore forwarded-host: trusted public Host must match the fixed deployment origin.
  if (
    headers.host !== config.host ||
    (headers.origin !== undefined && headers.origin !== config.origin) ||
    (requireOrigin && headers.origin !== config.origin)
  ) {
    throw Object.assign(new Error('Request origin is not allowed'), { status: 403 });
  }
}

export async function readBoundedJson(
  req: AsyncIterable<Uint8Array | string> & { headers: IncomingHttpHeaders; body?: unknown },
  limit: number,
): Promise<unknown> {
  const fail = (message: string, status: number): never => {
    throw Object.assign(new Error(message), { status });
  };
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? ''))
    fail('JSON content type required', 415);
  const length = req.headers['content-length'];
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > limit))
    fail('Request body is too large', 413);
  if (req.body !== undefined) {
    let serialized: string;
    try {
      serialized = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    } catch {
      return fail('Invalid JSON body', 400);
    }
    if (serialized === undefined || Buffer.byteLength(serialized) > limit)
      fail('Request body is too large', 413);
    try {
      return JSON.parse(serialized);
    } catch {
      return fail('Invalid JSON body', 400);
    }
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > limit) fail('Request body is too large', 413);
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return fail('Invalid JSON body', 400);
  }
}

export class LocalRateLimiter {
  private buckets = new Map<string, { count: number; until: number }>();
  constructor(
    private limit: number,
    private windowMs: number,
  ) {}
  consume(key: string, now = Date.now()) {
    if (this.buckets.size > 10_000)
      for (const [id, value] of this.buckets) if (value.until <= now) this.buckets.delete(id);
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.until <= now) {
      if (this.buckets.size >= 20_000)
        throw Object.assign(new Error('Request rate exceeded'), { status: 429 });
      this.buckets.set(key, { count: 1, until: now + this.windowMs });
      return;
    }
    if (bucket.count >= this.limit)
      throw Object.assign(new Error('Request rate exceeded'), { status: 429 });
    bucket.count++;
  }
}

/** Firestore transaction makes account quotas effective across serverless instances. */
export async function consumeMcpQuota(
  key: string,
  limit: number,
  windowMs: number,
  now = Date.now(),
) {
  const db = getAdminDb();
  const ref = db.collection('mcpRateLimits').doc(tokenHash(key));
  await db.runTransaction(async (tx) => {
    const row = (await tx.get(ref)).data();
    const active = row && typeof row.until === 'number' && row.until > now;
    if (active && row.count >= limit)
      throw Object.assign(new Error('Request rate exceeded'), { status: 429 });
    tx.set(ref, { count: active ? row.count + 1 : 1, until: active ? row.until : now + windowMs });
  });
}
export function jsonResponse(res: ServerResponse, status: number, value: unknown) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(JSON.stringify(value));
}
export function safeMcpError(error: unknown): { status: number; error: string } {
  if (error instanceof CalendarError && error.code === 'GOOGLE_WRITE_UNCERTAIN')
    return {
      status: 502,
      error:
        'GOOGLE_WRITE_UNCERTAIN: The operation may have completed. Do not retry; read the calendar and check the result first.',
    };
  if (error instanceof ZodError) return { status: 400, error: 'Invalid request data' };
  const status = (error as { status?: number })?.status;
  if (
    typeof status === 'number' &&
    [400, 401, 403, 404, 405, 409, 413, 415, 429, 503].includes(status)
  )
    return { status, error: error instanceof Error ? error.message : 'Request failed' };
  return { status: 500, error: 'Request failed. Try again later.' };
}
