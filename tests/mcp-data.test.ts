import test from 'node:test';
import assert from 'node:assert/strict';
import { createMcpDataService, type WorkspaceStore } from '../server/mcpData.ts';
import type { McpDataService } from '../server/mcpServer.ts';

function setup() {
  const records = new Map<string, unknown>();
  const paths: string[] = [];
  const storage: WorkspaceStore = {
    async read(path) {
      paths.push(path);
      return records.get(path) ?? null;
    },
    async list(path, input) {
      paths.push(path);
      return [...records.entries()]
        .filter(
          ([key]) =>
            key.startsWith(path + '/') && (!input.after || key.split('/').at(-1)! > input.after),
        )
        .slice(0, input.limit)
        .map(([key, value]) => ({ id: key.split('/').at(-1)!, value }));
    },
    async mutate(path, operation) {
      paths.push(path);
      const output = operation(records.get(path) ?? null);
      if (output.next === null) records.delete(path);
      else records.set(path, output.next);
      return output.result;
    },
  };
  const calendar = {} as Pick<
    McpDataService,
    | 'getCalendarStatus'
    | 'listCalendarEvents'
    | 'createCalendarEvent'
    | 'updateCalendarEvent'
    | 'deleteCalendarEvent'
  >;
  return { records, paths, data: createMcpDataService(storage, calendar) };
}

test('MCP map data stays inside authenticated account paths and uses revision preconditions', async () => {
  const { data, records, paths } = setup();
  const map = (await data.createMap('alice', { title: 'First' })) as {
    id: string;
    revision: number;
    root: unknown;
  };
  assert.equal(records.has(`users/alice/mindmaps/${map.id}`), true);
  assert.equal(map.revision, 1);
  await assert.rejects(data.getMap('bob', map.id), /not found/i);
  await assert.rejects(
    data.updateMap('alice', map.id, { title: 'stale', root: map.root, expectedRevision: 0 }),
    /revision|invalid|small/i,
  );
  await data.updateMap('alice', map.id, { title: 'New', root: map.root, expectedRevision: 1 });
  await assert.rejects(data.deleteMap('alice', map.id, 1), /revision/i);
  assert.equal(((await data.getMap('alice', map.id)) as { title: string }).title, 'New');
  await data.deleteMap('alice', map.id, 2);
  await assert.rejects(data.getMap('alice', map.id), /not found/i);
  assert.equal(
    paths.every((path) => /^users\/(alice|bob)\/mindmaps\//.test(path)),
    true,
  );
});

test('MCP does not trust corrupted owners or oversized board data and never loads legacy boards', async () => {
  const { data, records, paths } = setup();
  assert.deepEqual(await data.getBoard('alice'), { ownerUid: 'alice', projects: [], revision: 0 });
  await data.replaceBoard('alice', [], 0);
  await assert.rejects(data.replaceBoard('alice', [], 0), /revision/i);
  const current = records.get('users/alice/boards/default') as Record<string, unknown>;
  records.set('users/alice/boards/default', { ...current, ownerUid: 'bob' });
  await assert.rejects(data.getBoard('alice'));
  await assert.rejects(data.replaceBoard('alice', [{ name: 'x'.repeat(600_000) }], 1), /large/i);
  assert.equal(
    paths.every((path) => path === 'users/alice/boards/default'),
    true,
  );
});

test('MCP map listing exposes only bounded account summaries and rejects misplaced IDs', async () => {
  const { data, records } = setup();
  const map = (await data.createMap('alice', { title: 'Alice' })) as { id: string };
  await data.createMap('bob', { title: 'Bob' });
  const list = (await data.listMaps('alice', { limit: 1 })) as {
    items: { title: string; root?: unknown }[];
  };
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0].title, 'Alice');
  assert.equal(list.items[0].root, undefined);
  records.set(`users/alice/mindmaps/${map.id}`, {
    ...(records.get(`users/alice/mindmaps/${map.id}`) as object),
    id: 'other',
  });
  await assert.rejects(data.getMap('alice', map.id), /identifier/i);
});

test('MCP refuses an input that fits the byte limit but would produce an unreadable oversized map', async () => {
  const { data, records } = setup();
  // A deterministic exact near-limit document avoids relying on the production size checker.
  const exact = {
    title: 'Title',
    root: {
      id: 'root',
      text: 'Title',
      children: Array.from({ length: 255 }, (_, i) => ({
        id: `n${i}`,
        text: 'x'.repeat(1963),
        children: [],
      })),
    },
  };
  const delta = 511_950 - Buffer.byteLength(JSON.stringify(exact));
  assert.ok(delta > 0 && delta < 2000);
  exact.root.children.push({ id: 'extra', text: 'x'.repeat(delta - 40), children: [] });
  assert.ok(Buffer.byteLength(JSON.stringify(exact)) < 512_000);
  await assert.rejects(data.createMap('alice', exact), /large/i);
  assert.equal(records.size, 0);
});
