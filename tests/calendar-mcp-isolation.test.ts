import test from 'node:test';
import assert from 'node:assert/strict';
import { createMcpDataService, type WorkspaceStore } from '../server/mcpData.ts';
import { agentCalendarOperations } from '../server/calendar/service.ts';
import { calendarConfig } from '../server/calendar/config.ts';

const storage: WorkspaceStore = {
  async read() {
    throw new Error('Unexpected storage access');
  },
  async list() {
    throw new Error('Unexpected storage access');
  },
  async mutate() {
    throw new Error('Unexpected storage access');
  },
};

test('MCP defaults bind every calendar operation exclusively to the agent service', () => {
  const data = createMcpDataService(storage);
  for (const name of [
    'getCalendarStatus',
    'listCalendarEvents',
    'createCalendarEvent',
    'updateCalendarEvent',
    'deleteCalendarEvent',
  ] as const) {
    assert.equal(data[name], agentCalendarOperations[name]);
  }
});

test('configured UI credentials never substitute for missing agent authorization', async () => {
  const previous = { ...process.env };
  try {
    for (const key of Object.keys(process.env)) if (/CALENDAR/.test(key)) delete process.env[key];
    Object.assign(process.env, {
      FIREBASE_PROJECT_ID: 'test-firebase',
      CALENDAR_APP_ORIGIN: 'https://app.example',
      GOOGLE_CALENDAR_PROJECT_ID: 'test-calendar-ui',
      GOOGLE_CALENDAR_CLIENT_ID: 'ui-client.apps.googleusercontent.com',
      GOOGLE_CALENDAR_CLIENT_SECRET: 'synthetic-client-secret',
      CALENDAR_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
    });
    assert.equal(calendarConfig().clientId, 'ui-client.apps.googleusercontent.com');
    const data = createMcpDataService(storage);
    assert.deepEqual(await data.getCalendarStatus('test-user'), {
      configured: false,
      status: 'not_configured',
      calendar: 'primary',
    });
    await assert.rejects(
      async () => data.listCalendarEvents('test-user', {}),
      /CALENDAR_NOT_CONFIGURED/,
    );
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  }
});
