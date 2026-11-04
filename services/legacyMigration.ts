import { createHash } from 'node:crypto';
import { boardPath, prepareBoardWrite, validateProjects } from './boardSafety.ts';

/** Canonical ordering for a private backup hash; never logs the payload. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return (
      '{' +
      Object.keys(object)
        .sort()
        .map((key) => JSON.stringify(key) + ':' + canonical(object[key]))
        .join(',') +
      '}'
    );
  }
  return JSON.stringify(value);
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export function prepareLegacyMigration(uid: string, raw: unknown, targetExists: boolean) {
  const targetPath = boardPath(uid);
  if (targetExists)
    throw new Error('Destination already exists. Merge decision required; nothing was changed.');
  if (!raw || typeof raw !== 'object' || !('projects' in raw))
    throw new Error('Invalid legacy board');
  const projects = (raw as { projects: unknown }).projects;
  validateProjects(projects);
  const sourceHash = digest(canonical(raw));
  return {
    sourcePath: 'boards/default',
    targetPath,
    targetUid: uid,
    sourceHash,
    migrationId: digest(`legacy-board-v1:${uid}:${sourceHash}`),
    counts: {
      projects: projects.length,
      tasks: projects.reduce((sum, p) => sum + p.tasks.length, 0),
      comments: projects.reduce(
        (sum, p) => sum + p.tasks.reduce((n, t) => n + t.comments.length, 0),
        0,
      ),
      images: projects.reduce(
        (sum, p) => sum + p.tasks.filter((t) => t.imagePath || t.imageUrl).length,
        0,
      ),
    },
    document: prepareBoardWrite(uid, projects, 0, null),
  };
}
