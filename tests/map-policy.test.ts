import test from 'node:test';
import assert from 'node:assert/strict';
import { createMapRecord, updateMapRecord, readMapRecord } from '../services/mapPolicy.ts';
import type { MindNode } from '../mindmap/lib/model';
const root = { id: 'root', text: '想法', children: [] };
test('map records enforce owner and revision without accepting caller identity', () => {
  const created = createMapRecord('alice', 'map1', { title: '我的圖', root, ownerUid: 'bob' });
  assert.equal(created.ownerUid, 'alice');
  assert.equal(created.revision, 1);
  assert.throws(() => readMapRecord('bob', created), /owner|account/i);
  assert.throws(
    () => updateMapRecord('alice', created, { title: 'next', root, expectedRevision: 2 }),
    /conflict/i,
  );
  const next = updateMapRecord('alice', created, { title: 'next', root, expectedRevision: 1 });
  assert.equal(next.revision, 2);
  assert.equal(next.id, 'map1');
});
test('map rejects malformed and oversize documents', () => {
  assert.throws(() => createMapRecord('alice', '../bob', { title: 'bad', root }));
  assert.throws(() => createMapRecord('alice', 'map1', { title: '', root }));
  assert.throws(() =>
    createMapRecord('alice', 'map1', { title: 't', root: { ...root, children: [root] } }),
  );
});
test('Firestore storage roundtrips deep and escaped trees without nested maps', async () => {
  const { mapRecordForStorage } = await import('../services/mapPolicy.ts');
  let tree: MindNode = { id: 'leaf', text: '"\\'.repeat(800), children: [] };
  for (let i = 0; i < 32; i++) tree = { id: `n${i}`, text: '"\\'.repeat(800), children: [tree] };
  const doc = createMapRecord('alice', 'deep', { title: 'Deep', root: tree });
  const stored = mapRecordForStorage(doc);
  assert.equal(typeof stored.rootJson, 'string');
  assert.equal('root' in stored, false);
  assert.deepEqual(readMapRecord('alice', stored).root, doc.root);
});
test('create rejects oversized stored envelope before persisting it', () => {
  const children = Array.from({ length: 250 }, (_, i) => ({
    id: `c${i}`,
    text: '"'.repeat(1900),
    children: [],
  }));
  assert.throws(
    () =>
      createMapRecord('alice', 'large', {
        title: 'Escaped size',
        root: { id: 'r', text: 'r', children },
      }),
    /too large/i,
  );
});
