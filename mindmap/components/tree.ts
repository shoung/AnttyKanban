export interface Tree {
  id: string;
  text: string;
  children: Tree[];
}
export const uid = () => crypto.randomUUID();
export const walk = (root: Tree): Tree[] => [root, ...root.children.flatMap(walk)];
export const find = (root: Tree, id: string): Tree | undefined =>
  walk(root).find((n) => n.id === id);
export const parentOf = (root: Tree, id: string): Tree | undefined =>
  walk(root).find((n) => n.children.some((c) => c.id === id));
export function update(root: Tree, id: string, fn: (n: Tree) => Tree): Tree {
  return root.id === id
    ? fn(root)
    : { ...root, children: root.children.map((c) => update(c, id, fn)) };
}
export function remove(root: Tree, id: string): Tree {
  return {
    ...root,
    children: root.children.filter((c) => c.id !== id).map((c) => remove(c, id)),
  };
}
export function move(root: Tree, id: string, target: string): Tree {
  const n = find(root, id);
  if (!n || id === root.id || find(n, target)) return root;
  return update(remove(root, id), target, (p) => ({
    ...p,
    children: [...p.children, n],
  }));
}
export function markdown(root: Tree, depth = 0): string {
  return (
    `${'  '.repeat(depth)}- ${root.text.replace(/\n/g, ' ')}\n` +
    root.children.map((c) => markdown(c, depth + 1)).join('')
  );
}
export function layout(root: Tree, collapsed: Set<string>) {
  const positions = new Map<string, { x: number; y: number; depth: number; branch: number }>();
  let row = 0;
  function place(n: Tree, depth: number, branch: number): number {
    const children = collapsed.has(n.id) ? [] : n.children;
    const ys: number[] = children.map((c, i) => place(c, depth + 1, depth === 0 ? i : branch));
    const y = ys.length ? (ys[0] + ys[ys.length - 1]) / 2 : row++ * 135;
    positions.set(n.id, { x: depth * 280, y, depth, branch });
    return y;
  }
  place(root, 0, 0);
  return positions;
}
export const example = (): Tree => ({
  id: uid(),
  text: '下一個好點子',
  children: [
    {
      id: uid(),
      text: '我們想解決什麼？',
      children: [
        { id: uid(), text: '真正需要幫助的人', children: [] },
        { id: uid(), text: '現在遇到的困擾', children: [] },
      ],
    },
    {
      id: uid(),
      text: '還有什麼可能？',
      children: [
        { id: uid(), text: '先不急著說不', children: [] },
        { id: uid(), text: '試一個不同的角度', children: [] },
      ],
    },
    {
      id: uid(),
      text: '從哪一步開始？',
      children: [{ id: uid(), text: '最小可行的實驗', children: [] }],
    },
  ],
});
