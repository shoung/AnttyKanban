import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { once } from 'node:events';
import { createServer, request as httpRequest } from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL, URL } from 'node:url';

// Import the actual default handlers, including every transitive production module.
// Do not install a TypeScript loader or replace authentication/storage dependencies.
const output = process.argv[2];
const handlers = new Map();
for (const name of ['calendar', 'calendar-agent', 'agent-tokens', 'mcp', 'mcp-oauth-metadata']) {
  const module = await import(pathToFileURL(path.join(output, 'api', `${name}.js`)).href);
  handlers.set(`/api/${name}`, module.default);
}

const server = createServer((request, response) => {
  const handler = handlers.get(new URL(request.url, 'http://localhost').pathname);
  void handler(request, response);
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;

async function expectResponse(route, status, headers = {}) {
  const response = await new Promise((resolve, reject) => {
    const request = httpRequest(`${origin}${route}`, { headers }, resolve);
    request.on('error', reject);
    request.end();
  });
  assert.equal(response.statusCode, status, `${route} should return ${status}`);
  assert.match(response.headers['content-type'], /^application\/json/);
  assert.equal(response.headers['cache-control'], 'no-store');
  const chunks = [];
  for await (const chunk of response) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  assert.equal(typeof body.error, 'string');
  assert.ok(body.error.length > 0);
}

try {
  await expectResponse('/api/calendar', 401);
  await expectResponse('/api/calendar-agent', 401);
  await expectResponse('/api/calendar-agent?action=callback', 503);
  await expectResponse('/api/calendar-agent?action=events', 400);
  await expectResponse('/api/calendar', 503, { Authorization: 'Bearer unavailable' });
  await expectResponse('/api/calendar?action=callback', 503);
  await expectResponse('/api/agent-tokens', 503);
  await expectResponse('/api/mcp', 503);
  await expectResponse('/api/mcp-oauth-metadata', 503);

  // Valid, non-secret configuration reaches the real authentication/origin guards.
  // Missing bearer tokens and disallowed origins must stop before any remote access.
  process.env.FIREBASE_PROJECT_ID = 'demo-native-runtime';
  process.env.ANTTY_MCP_ENABLED = 'true';
  process.env.ANTTY_APP_ORIGIN = 'https://native-runtime.example';
  for (const route of ['/api/agent-tokens', '/api/mcp']) {
    await expectResponse(route, 401, { Host: 'native-runtime.example' });
    await expectResponse(route, 403, {
      Host: 'native-runtime.example',
      Origin: 'https://untrusted.example',
    });
    await expectResponse(route, 403, { Host: 'untrusted.example' });
  }
  await expectResponse('/api/mcp-oauth-metadata', 404, { Host: 'native-runtime.example' });
  // Exercise the actual WIF-backed SDK initialization offline as native emitted JS.
  Object.assign(process.env, {
    FIREBASE_PROJECT_ID: 'antboard-2025',
    FIREBASE_ADMIN_AUTH_MODE: 'vercel-wif',
    GCP_PROJECT_NUMBER: '376367007034',
    GCP_SERVICE_ACCOUNT_EMAIL: 'antty-runtime@antboard-2025.iam.gserviceaccount.com',
    GCP_WORKLOAD_IDENTITY_POOL_ID: 'antty-vercel',
    GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID: 'production',
    VERCEL_ENV: 'production',
  });
  const { getAdminDb, getAdminAuth } = await import(
    pathToFileURL(path.join(output, 'server', 'firebase.js')).href
  );
  assert.equal(getAdminDb().projectId, 'antboard-2025');
  assert.equal(getAdminAuth().app.options.projectId, 'antboard-2025');
  await getAdminDb().terminate();
} finally {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
