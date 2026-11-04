import test from 'node:test';
import assert from 'node:assert/strict';
import { move, find, remove, update, layout, type Tree } from '../mindmap/components/tree';
const tree: Tree = {
  id: 'root',
  text: 'Root',
  children: [
    { id: 'a', text: 'A', children: [{ id: 'b', text: 'B', children: [] }] },
    { id: 'c', text: 'C', children: [] },
  ],
};
test('reparent preserves IDs and prevents cycles and moving root', () => {
  assert.equal(move(tree, 'a', 'b'), tree);
  assert.equal(move(tree, 'root', 'c'), tree);
  const moved = move(tree, 'b', 'c');
  assert.equal(find(moved, 'a')?.children.length, 0);
  assert.equal(find(moved, 'c')?.children[0].id, 'b');
  assert.equal(find(tree, 'a')?.children.length, 1);
});
test('edit/remove are immutable and descendant removal is complete', () => {
  const edited = update(tree, 'b', (n) => ({ ...n, text: 'New' }));
  assert.equal(find(edited, 'b')?.text, 'New');
  assert.equal(find(tree, 'b')?.text, 'B');
  assert.equal(find(remove(tree, 'a'), 'b'), undefined);
});
test('layout is deterministic, collapses children and separates siblings', () => {
  const a = layout(tree, new Set());
  assert.deepEqual(a, layout(tree, new Set()));
  assert.equal(a.size, 4);
  assert.ok(a.get('a')!.y < a.get('c')!.y);
  const collapsed = layout(tree, new Set(['a']));
  assert.equal(collapsed.has('b'), false);
  assert.equal(collapsed.size, 3);
});
