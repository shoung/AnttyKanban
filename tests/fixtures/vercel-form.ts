import type { IncomingMessage } from 'node:http';
import { parse } from 'node:querystring';
import { PassThrough } from 'node:stream';

/** Standalone @vercel/node 28.0.0 form helper + raw replay behavior.
 * https://github.com/vercel/vercel/blob/84878e532142f0ac584953695658b324eb9e5b80/packages/node/src/serverless-functions/helpers.ts
 * Only synthetic loopback requests use this fixture. No platform dependencies or credentials.
 */
export async function withVercelFormBody(req: IncomingMessage & { body?: unknown }) {
  if (!req.headers['content-type']?.startsWith('application/x-www-form-urlencoded')) return;
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const body = Buffer.concat(chunks);
  Object.defineProperty(req, 'body', { get: () => parse(body.toString()) });
  // Match restoreBody: data/end and read are replayed, but async iteration is not.
  const replay = new PassThrough();
  const on = replay.on.bind(replay);
  const originalOn = req.on.bind(req);
  req.read = replay.read.bind(replay);
  req.on = req.addListener = (name, listener) =>
    (name === 'data' || name === 'end'
      ? on(name, listener)
      : originalOn(name, listener)) as typeof req;
  replay.end(body);
}
