import { z } from 'zod';

export type MindNode = { id: string; text: string; children: MindNode[] };
export type MapDocument = {
  id: string;
  title: string;
  revision: number;
  updatedAt: string;
  root: MindNode;
};
export const MAX_NODES = 1000;
export const MAX_DEPTH = 32;
export const MAX_BODY_BYTES = 512_000;
export const idSchema = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
export const titleSchema = z.string().trim().min(1).max(200);

// Validate iteratively before recursive parsing, so malicious deep input cannot overflow the stack.
export const nodeSchema = z.unknown().transform((input, ctx): MindNode => {
  const queue: { value: unknown; depth: number }[] = [{ value: input, depth: 0 }];
  const ids = new Set<string>();
  let count = 0;
  while (queue.length) {
    const { value, depth } = queue.pop()!;
    const n = value as MindNode | null;
    if (
      ++count > MAX_NODES ||
      depth > MAX_DEPTH ||
      !n ||
      typeof n !== 'object' ||
      !idSchema.safeParse(n.id).success ||
      ids.has(n.id) ||
      typeof n.text !== 'string' ||
      n.text.length > 2000 ||
      !n.text.trim() ||
      !Array.isArray(n.children) ||
      n.children.length > MAX_NODES
    ) {
      ctx.addIssue({
        code: 'custom',
        message:
          'Invalid tree: unique IDs, non-empty text, at most 1000 nodes and depth 32 required.',
      });
      return z.NEVER;
    }
    ids.add(n.id);
    for (const child of n.children) queue.push({ value: child, depth: depth + 1 });
  }
  function clean(n: MindNode): MindNode {
    return { id: n.id, text: n.text, children: n.children.map(clean) };
  }
  return clean(input as MindNode);
});
export const createMapSchema = z.object({
  title: titleSchema,
  root: nodeSchema.optional(),
});
export const updateMapSchema = z.object({
  title: titleSchema,
  root: nodeSchema,
  expectedRevision: z.number().int().positive(),
});
export const mapDocumentSchema = z.object({
  id: idSchema,
  title: titleSchema,
  revision: z.number().int().positive(),
  updatedAt: z.string().datetime(),
  root: nodeSchema,
});

export function toMarkdown(document: Pick<MapDocument, 'title' | 'root'>): string {
  const escape = (s: string) =>
    s
      .replace(/\\/g, '\\\\')
      .replace(/([`*_{}[\]<>#])/g, '\\$1')
      .replace(/\r?\n/g, ' ');
  const lines = [`# ${escape(document.title)}`, ''];
  function walk(node: MindNode, depth: number) {
    lines.push(`${'  '.repeat(depth)}- ${escape(node.text)}`);
    node.children.forEach((child) => walk(child, depth + 1));
  }
  walk(document.root, 0);
  return lines.join('\n') + '\n';
}

export function parseMarkdown(markdown: string): {
  title: string;
  root: MindNode;
} {
  if (new TextEncoder().encode(markdown).length > MAX_BODY_BYTES)
    throw new Error('Markdown is too large');
  const lines = markdown.split(/\r?\n/);
  let title = 'Imported map';
  const roots: MindNode[] = [];
  const stack: MindNode[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    if (/^# /.test(line) && roots.length === 0) {
      title = line.slice(2).trim();
      continue;
    }
    const match = /^( *)(?:[-*+] |\d+\. )(.*)$/.exec(line);
    if (!match || match[1].length % 2)
      throw new Error('Use a # title and a list indented with two spaces per level');
    const depth = match[1].length / 2;
    if (depth > stack.length || depth > MAX_DEPTH) throw new Error('Invalid indentation');
    const node: MindNode = {
      id: crypto.randomUUID(),
      text: match[2].replace(/\\([\\`*_{}[\]<>#])/g, '$1'),
      children: [],
    };
    if (depth === 0) roots.push(node);
    else stack[depth - 1].children.push(node);
    stack[depth] = node;
    stack.length = depth + 1;
  }
  const root =
    roots.length === 1 ? roots[0] : { id: crypto.randomUUID(), text: title, children: roots };
  return createMapSchema.required().parse({ title, root });
}
