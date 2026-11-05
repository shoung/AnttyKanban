import { once } from 'node:events';
import type { Server } from 'node:http';

/** Windows can allocate Fetch-forbidden service ports when listen(0) is used. */
export async function listenForFetch(server: Server) {
  const forbidden = new Set([
    2049, 3659, 4045, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6697, 10080,
  ]);
  for (let attempt = 0; attempt < 32; attempt++) {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = (server.address() as { port: number }).port;
    if (port >= 1024 && !forbidden.has(port)) return `http://127.0.0.1:${port}`;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  throw new Error('Could not allocate a Fetch-compatible loopback port');
}
