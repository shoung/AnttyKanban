import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  CalendarService,
  CALENDAR_SCOPE,
  type CalendarConnection,
  type OAuthAttempt,
  type CalendarStore,
} from '../../server/calendar/core.ts';
import { googleGateway } from '../../server/calendar/google.ts';
import { createCipher } from '../../server/calendar/security.ts';
import { createCalendarHandler } from '../../server/calendar/http.ts';
import { createMcpHandler } from '../../api/mcp.ts';
import { createMcpDataService } from '../../server/mcpData.ts';
import { listenForFetch } from './listen-fetch.ts';

export const eventInput = {
  summary: 'Synthetic calendar event',
  start: { date: '2026-11-06' },
  end: { date: '2026-11-07' },
};
export const initialEvent = {
  ...eventInput,
  id: 'event1',
  etag: '"v1"',
  organizer: { self: true },
  attendees: [],
};

type Failure = {
  method: string;
  response?: Response;
  error?: Error;
  commitThenLose?: boolean;
  race?: boolean;
};
/** Real HTTP/MCP, CalendarService and Google gateway. Only identity/store/Google network are synthetic. */
export async function calendarTransportFixture(t: TestContext) {
  const events = new Map<string, Record<string, unknown>>([
    ['event1', structuredClone(initialEvent)],
  ]);
  const requests: Array<{ method: string; url: URL; headers: Headers; body: unknown }> = [];
  let failure: Failure | undefined;
  function service(channel: 'ui' | 'agent') {
    const connections = new Map<string, CalendarConnection>();
    const attempts = new Map<string, OAuthAttempt>();
    const store: CalendarStore = {
      async getConnection(uid) {
        return connections.get(uid) ?? null;
      },
      async saveConnection(uid, connection, revision) {
        if ((connections.get(uid)?.revision ?? 0) !== revision) return false;
        connections.set(uid, connection);
        return true;
      },
      async createAttempt(key, value) {
        attempts.set(key, value);
      },
      async consumeAttempt(key, binding, now) {
        const value = attempts.get(key);
        if (!value || value.bindingHash !== binding || value.expiresAt <= now) return null;
        attempts.delete(key);
        return value;
      },
    };
    const google = googleGateway({
      channel,
      projectId: `synthetic-${channel}`,
      clientId: `synthetic-${channel}`,
      clientSecret: 'synthetic-client-secret',
      appOrigin: 'https://app.example',
      redirectUri: 'https://app.example/callback',
      encryptionKey: Buffer.alloc(32, 7).toString('base64'),
    });
    const value = new CalendarService({
      context: { channel, clientId: `synthetic-${channel}`, projectId: `synthetic-${channel}` },
      store,
      cipher: createCipher(Buffer.alloc(32, channel === 'ui' ? 1 : 2).toString('base64')),
      expectedGoogleSubject: async () => 'synthetic-subject',
      google: {
        ...google,
        authorizationUrl: ({ state }) => `https://synthetic.example/authorize?state=${state}`,
        exchangeCode: async () => ({
          subject: 'synthetic-subject',
          refreshToken: 'synthetic-refresh',
          grantedScopes: [CALENDAR_SCOPE],
        }),
        refreshAccessToken: async () => `synthetic-${channel}-access`,
        revokeToken: async () => {},
      },
    });
    return value;
  }
  const ui = service('ui');
  const agent = service('agent');
  async function connect(value: CalendarService) {
    const { authorizationUrl } = await value.beginConnect('synthetic-owner', 'synthetic-browser');
    await value.completeConnect(
      new URL(authorizationUrl).searchParams.get('state')!,
      'synthetic-browser',
      'synthetic-code',
    );
  }
  await connect(ui);
  await connect(agent);
  const data = createMcpDataService(
    {
      async read() {
        throw new Error('Unexpected workspace access');
      },
      async list() {
        throw new Error('Unexpected workspace access');
      },
      async mutate() {
        throw new Error('Unexpected workspace access');
      },
    },
    {
      getCalendarStatus: (uid) => agent.getStatus(uid),
      listCalendarEvents: (uid, input) => agent.listEvents(uid, input),
      createCalendarEvent: (uid, input) => agent.createEvent(uid, input),
      updateCalendarEvent: (uid, id, input, etag) => agent.updateEvent(uid, id, input, etag),
      deleteCalendarEvent: (uid, id, etag) => agent.deleteEvent(uid, id, etag),
    },
  );
  let origin = '';
  const http = createCalendarHandler({
    authenticate: async (req) => {
      assert.equal(req.headers.authorization, 'Bearer synthetic-firebase-token');
      return { uid: 'synthetic-owner' };
    },
    service: () => ui,
    status: (uid) => ui.getStatus(uid),
    origin: () => origin,
  });
  const mcp = createMcpHandler({
    config: () => ({ origin, host: new URL(origin).host }),
    authenticate: async (token) => {
      assert.equal(token, 'antty_synthetic-mcp-token');
      return { uid: 'synthetic-owner', scopes: ['calendar:read', 'calendar:write'] };
    },
    quota: async () => {},
    data: () => data,
  });
  const server = createServer((req, res) =>
    req.url?.startsWith('/api/mcp') ? mcp(req, res) : http(req, res),
  );
  origin = await listenForFetch(server);
  const networkFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin === origin) return networkFetch(input, init);
    assert.equal(
      url.origin,
      'https://www.googleapis.com',
      'No network except this fixture and the synthetic provider',
    );
    assert.ok(url.pathname.startsWith('/calendar/v3/calendars/primary/events'));
    assert.match(
      request.headers.get('authorization') ?? '',
      /^Bearer synthetic-(ui|agent)-access$/,
    );
    const bodyText = await request.text();
    const body = bodyText ? JSON.parse(bodyText) : undefined;
    requests.push({ method: request.method, url, headers: request.headers, body });
    const currentFailure = failure?.method === request.method ? failure : undefined;
    if (currentFailure) failure = undefined;
    if (currentFailure?.response) return currentFailure.response;
    if (currentFailure?.error) throw currentFailure.error;
    const id = url.pathname.split('/')[6];
    const previous = events.get(id);
    if (request.method === 'GET')
      return Response.json(id ? previous : { items: [...events.values()] });
    assert.equal(url.searchParams.get('sendUpdates'), 'none');
    if (currentFailure?.race && previous) previous.etag = '"raced"';
    if (
      request.method !== 'POST' &&
      (!previous || request.headers.get('if-match') !== previous.etag)
    )
      return Response.json(
        { error: { message: 'synthetic private conflict detail' } },
        { status: previous ? 412 : 404 },
      );
    let response: Response;
    if (request.method === 'DELETE') {
      events.delete(id);
      response = new Response(null, { status: 204 });
    } else {
      const target = request.method === 'POST' ? 'created1' : id;
      const saved = { ...initialEvent, ...body, id: target, etag: '"v2"' };
      events.set(target, saved);
      response = Response.json(saved);
    }
    if (currentFailure?.commitThenLose)
      throw new Error('synthetic private response lost after commit');
    return response;
  });
  const client = new Client({ name: 'synthetic-calendar-transport', version: '1' });
  t.after(async () => {
    await client.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${origin}/api/mcp`), {
      requestInit: {
        headers: { Authorization: 'Bearer antty_synthetic-mcp-token' },
        redirect: 'error',
      },
    }),
  );
  return {
    events,
    requests,
    client,
    failNext: (next: Failure) => {
      failure = next;
    },
    async http(method: string, body?: unknown) {
      return fetch(`${origin}/api/calendar?action=events`, {
        method,
        headers: {
          Authorization: 'Bearer synthetic-firebase-token',
          Origin: origin,
          'Content-Type': 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    },
    async tool(name: string, args: Record<string, unknown> = {}) {
      const result = await client.callTool({ name, arguments: args });
      const text = (result.content as Array<{ type: string; text?: string }>).find(
        (c) => c.type === 'text',
      )?.text;
      assert.ok(text);
      return {
        error: result.isError === true,
        text,
        value: result.isError ? undefined : JSON.parse(text),
      };
    },
  };
}
