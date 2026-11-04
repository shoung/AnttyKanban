import { boardPath, prepareBoardWrite, validateProjects, decodeBoard } from './boardSafety.ts';
export interface ImageInventory {
  path: string | null;
  hasLegacyUrl: boolean;
  taskIds: string[];
}
export interface BrowserMigrationPlan {
  ownerUid: string;
  sourcePath: 'boards/default';
  targetPath: string;
  targetExists: boolean;
  source: Record<string, unknown>;
  sourceHash: string;
  projectHash: string;
  counts: { projects: number; tasks: number; comments: number; images: number };
  images: ImageInventory[];
}
function canonical(value: unknown): string {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  )
    return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const raw = value as Record<string, unknown>;
    return (
      '{' +
      Object.keys(raw)
        .sort()
        .map((k) => JSON.stringify(k) + ':' + canonical(raw[k]))
        .join(',') +
      '}'
    );
  }
  throw new Error(
    'Source contains unsupported data types. Use an administrator export; no data was changed.',
  );
}
async function hash(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonical(value));
  const result = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(result), (b) => b.toString(16).padStart(2, '0')).join('');
}
export async function createBrowserMigrationPlan(
  uid: string,
  source: unknown,
  targetExists: boolean,
): Promise<BrowserMigrationPlan> {
  const targetPath = boardPath(uid);
  if (!source || typeof source !== 'object' || !('projects' in source))
    throw new Error('Legacy board is missing or invalid.');
  validateProjects(source.projects);
  const sourceHash = await hash(source);
  // Snapshot the complete JSON-safe source, preserving legacy fields and URLs in the private backup.
  const copy = JSON.parse(canonical(source)) as Record<string, unknown>;
  const images = new Map<string, ImageInventory>();
  let tasks = 0,
    comments = 0,
    imageReferences = 0;
  for (const project of source.projects)
    for (const task of project.tasks) {
      tasks++;
      comments += task.comments.length;
      if (!task.imagePath && !task.imageUrl) continue;
      imageReferences++;
      const key = task.imagePath || task.imageUrl!;
      const entry = images.get(key) || {
        path: task.imagePath || null,
        hasLegacyUrl: Boolean(task.imageUrl),
        taskIds: [],
      };
      entry.taskIds.push(task.id);
      images.set(key, entry);
    }
  return {
    ownerUid: uid,
    sourcePath: 'boards/default',
    targetPath,
    targetExists,
    source: copy,
    sourceHash,
    projectHash: await hash(source.projects),
    counts: { projects: source.projects.length, tasks, comments, images: imageReferences },
    images: [...images.values()],
  };
}
export async function migrationDocument(
  uid: string,
  plan: BrowserMigrationPlan,
  source: unknown,
  targetExists: boolean,
) {
  if (uid !== plan.ownerUid || boardPath(uid) !== plan.targetPath)
    throw new Error('Account changed; prepare a new backup.');
  if (targetExists) throw new Error('Destination already exists; nothing was overwritten.');
  const current = await createBrowserMigrationPlan(uid, source, false);
  if (current.sourceHash !== plan.sourceHash)
    throw new Error('Source changed after backup; nothing was written.');
  return prepareBoardWrite(uid, current.source.projects, 0, null);
}
export async function verifyMigrationTarget(
  uid: string,
  plan: BrowserMigrationPlan,
  target: unknown,
): Promise<'absent' | 'verified' | 'different'> {
  if (uid !== plan.ownerUid) throw new Error('Account changed.');
  if (target === null) return 'absent';
  try {
    const parsed = decodeBoard(uid, target);
    return parsed.revision === 1 && (await hash(parsed.projects)) === plan.projectHash
      ? 'verified'
      : 'different';
  } catch {
    return 'different';
  }
}

export function assertLegacyProject(config: {
  authProject?: string;
  dbProject?: string;
  storageProject?: string;
  storageBucket?: string;
}) {
  if (
    config.authProject !== 'antboard-2025' ||
    config.dbProject !== 'antboard-2025' ||
    config.storageProject !== 'antboard-2025'
  )
    throw new Error('Wrong Firebase project. Legacy migration is restricted to antboard-2025.');
  if (config.storageBucket !== 'antboard-2025.firebasestorage.app')
    throw new Error('Wrong Firebase Storage bucket. Legacy image inventory is blocked.');
  return { projectId: config.dbProject, storageBucket: config.storageBucket };
}
