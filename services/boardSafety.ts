import type { Project } from '../types.js';

export interface BoardState {
  ownerUid: string;
  projects: Project[];
  revision: number;
}
export interface BoardDocument extends BoardState {
  schemaVersion: 1;
}
function invalid(): never {
  throw new Error('Invalid board data or account');
}
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string';
const id = (value: unknown): value is string =>
  text(value) && value.length > 0 && value.length <= 128 && !value.includes('/');

export function boardPath(uid: string): string {
  if (!id(uid) || uid === '.' || uid === '..') invalid();
  return `users/${uid}/boards/default`;
}

/** Shared by browser and server. Never coerces malformed data into empty content. */
export function validateProjects(value: unknown): asserts value is Project[] {
  if (!Array.isArray(value) || value.length > 200) invalid();
  const projectIds = new Set<string>();
  for (const project of value) {
    if (
      !record(project) ||
      !id(project.id) ||
      !text(project.name) ||
      !Array.isArray(project.columns) ||
      !Array.isArray(project.tasks)
    )
      invalid();
    if (projectIds.has(project.id)) invalid();
    projectIds.add(project.id);
    const columnIds = new Set<string>();
    for (const column of project.columns) {
      if (
        !record(column) ||
        !id(column.id) ||
        !text(column.title) ||
        !text(column.color) ||
        columnIds.has(column.id)
      )
        invalid();
      columnIds.add(column.id);
    }
    const taskIds = new Set<string>();
    for (const task of project.tasks) {
      if (
        !record(task) ||
        !id(task.id) ||
        taskIds.has(task.id) ||
        !text(task.title) ||
        !text(task.columnId) ||
        !columnIds.has(task.columnId) ||
        !text(task.assignee) ||
        !Number.isSafeInteger(task.order) ||
        (task.order as number) < 0 ||
        !Array.isArray(task.tags) ||
        !task.tags.every(text) ||
        !Array.isArray(task.comments)
      )
        invalid();
      taskIds.add(task.id);
      for (const field of ['description', 'color', 'imageUrl', 'imagePath'])
        if (task[field] !== undefined && !text(task[field])) invalid();
      for (const comment of task.comments)
        if (
          !record(comment) ||
          !id(comment.id) ||
          !text(comment.text) ||
          !text(comment.authorId) ||
          !text(comment.authorName) ||
          !text(comment.createdAt)
        )
          invalid();
    }
  }
}

export function decodeBoard(uid: string, raw: unknown): BoardState {
  boardPath(uid);
  if (raw === null) return { ownerUid: uid, projects: [], revision: 0 };
  if (
    !record(raw) ||
    raw.ownerUid !== uid ||
    raw.schemaVersion !== 1 ||
    !Number.isSafeInteger(raw.revision) ||
    (raw.revision as number) < 1
  )
    invalid();
  validateProjects(raw.projects);
  return { ownerUid: uid, projects: raw.projects, revision: raw.revision as number };
}

export function prepareBoardWrite(
  uid: string,
  projects: unknown,
  expectedRevision: number,
  raw: unknown,
): BoardDocument {
  const current = decodeBoard(uid, raw);
  if (
    !Number.isSafeInteger(expectedRevision) ||
    expectedRevision < 0 ||
    expectedRevision !== current.revision
  )
    throw new Error('Board revision conflict. Reload before saving.');
  validateProjects(projects);
  if (current.revision >= Number.MAX_SAFE_INTEGER) invalid();
  return { ownerUid: uid, projects, revision: current.revision + 1, schemaVersion: 1 };
}

export interface AccountTicket {
  uid: string | null;
  epoch: number;
}
export class AccountEpoch {
  private uid: string | null = null;
  private epoch = 0;
  switchTo(uid: string | null): AccountTicket {
    this.uid = uid;
    this.epoch += 1;
    return { uid, epoch: this.epoch };
  }
  isCurrent(ticket: AccountTicket): boolean {
    return ticket.uid === this.uid && ticket.epoch === this.epoch;
  }
}

export function attachmentPath(
  uid: string,
  contentType: string,
  size: number,
  objectId: string,
): string {
  boardPath(uid);
  if (
    !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(contentType) ||
    !Number.isSafeInteger(size) ||
    size <= 0 ||
    size > 10 * 1024 * 1024 ||
    !id(objectId) ||
    objectId === '.' ||
    objectId === '..'
  )
    invalid();
  return `users/${uid}/task-images/${objectId}`;
}

export function attachmentSource(
  uid: string | null,
  path?: string,
  url?: string,
): { kind: 'none' } | { kind: 'private'; path: string } | { kind: 'legacy'; url: string } {
  if (!uid) return { kind: 'none' };
  if (path?.startsWith('users/')) {
    const prefix = `users/${uid}/task-images/`;
    return path.startsWith(prefix) && id(path.slice(prefix.length))
      ? { kind: 'private', path }
      : { kind: 'none' };
  }
  if (url) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'https:' || parsed.protocol === 'http:')
        return { kind: 'legacy', url };
    } catch {
      /* Invalid URL is not displayed. */
    }
  }
  return { kind: 'none' };
}
