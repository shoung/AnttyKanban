import { z } from 'zod';
import { decodeBoard, prepareBoardWrite } from '../services/boardSafety.js';
import type { Task } from '../types.js';

const identifier = z
  .string()
  .min(1)
  .max(128)
  .refine((v) => !v.includes('/') && v !== '.' && v !== '..');
const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const title = z.string().trim().min(1).max(2000);
const color = z.enum([
  'white',
  'gray',
  'red',
  'orange',
  'yellow',
  'green',
  'blue',
  'indigo',
  'purple',
  'pink',
]);
const taskFields = {
  title,
  description: z.string().max(8000),
  tags: z.array(z.string().max(100)).max(100),
  assignee: z.string().max(200),
  columnId: identifier,
  order: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  color,
};
const base = { expectedRevision: revision };
const project = { ...base, projectId: identifier };
const column = { ...project, columnId: identifier };
const task = { ...project, taskId: identifier };
export const boardOperationSchemas = {
  project_create: z.object({ ...base, name: title }).strict(),
  project_update: z.object({ ...project, name: title }).strict(),
  project_delete: z.object(project).strict(),
  column_create: z
    .object({
      ...project,
      title,
      color: z
        .string()
        .regex(/^#[0-9a-fA-F]{6}$/)
        .default('#64748b'),
    })
    .strict(),
  column_update: z
    .object({
      ...column,
      title,
      color: z
        .string()
        .regex(/^#[0-9a-fA-F]{6}$/)
        .optional(),
    })
    .strict(),
  column_delete: z.object(column).strict(),
  task_create: z
    .object({
      ...column,
      title,
      description: taskFields.description.optional(),
      tags: taskFields.tags.default([]),
      assignee: taskFields.assignee.default(''),
      color: color.optional(),
    })
    .strict(),
  task_update: z
    .object({
      ...task,
      patch: z
        .object(taskFields)
        .partial()
        .strict()
        .refine((v) => Object.keys(v).length > 0),
    })
    .strict(),
  task_delete: z.object(task).strict(),
};
export const boardMutationSchema = z.discriminatedUnion('operation', [
  boardOperationSchemas.project_create.extend({ operation: z.literal('project_create') }),
  boardOperationSchemas.project_update.extend({ operation: z.literal('project_update') }),
  boardOperationSchemas.project_delete.extend({ operation: z.literal('project_delete') }),
  boardOperationSchemas.column_create.extend({ operation: z.literal('column_create') }),
  boardOperationSchemas.column_update.extend({ operation: z.literal('column_update') }),
  boardOperationSchemas.column_delete.extend({ operation: z.literal('column_delete') }),
  boardOperationSchemas.task_create.extend({ operation: z.literal('task_create') }),
  boardOperationSchemas.task_update.extend({ operation: z.literal('task_update') }),
  boardOperationSchemas.task_delete.extend({ operation: z.literal('task_delete') }),
]);
export interface BoardMutationResult {
  id: string;
  revision: number;
}
const fail = (message: string, status: number): never => {
  throw Object.assign(new Error(message), { status });
};

/** Applied inside the same store transaction as the mandatory board revision check. */
export function applyBoardMutation(uid: string, raw: unknown, input: unknown, createdId: string) {
  const mutation = boardMutationSchema.parse(input);
  const current = decodeBoard(uid, raw);
  let next;
  try {
    next = prepareBoardWrite(
      uid,
      structuredClone(current.projects),
      mutation.expectedRevision,
      raw,
    );
  } catch {
    return fail('Board revision conflict; reread before editing', 409);
  }
  let id = createdId;
  if (mutation.operation === 'project_create') {
    if (next.projects.some((p) => p.id === id)) fail('Board identifier conflict', 409);
    next.projects.push({ id, name: mutation.name, columns: [], tasks: [] });
  } else {
    const target = next.projects.find((p) => p.id === mutation.projectId);
    if (!target) return fail('Board project not found', 404);
    id = target.id;
    switch (mutation.operation) {
      case 'project_update':
        target.name = mutation.name;
        break;
      case 'project_delete':
        next.projects = next.projects.filter((p) => p.id !== target.id);
        break;
      case 'column_create':
        id = createdId;
        if (target.columns.some((c) => c.id === id)) fail('Board identifier conflict', 409);
        target.columns.push({ id, title: mutation.title, color: mutation.color });
        break;
      case 'column_update':
      case 'column_delete': {
        const item = target.columns.find((c) => c.id === mutation.columnId);
        if (!item) return fail('Board column not found', 404);
        id = item.id;
        if (mutation.operation === 'column_delete') {
          if (target.tasks.some((t) => t.columnId === id))
            fail('Column must be empty before deletion', 409);
          target.columns = target.columns.filter((c) => c.id !== id);
        } else {
          item.title = mutation.title;
          if (mutation.color !== undefined) item.color = mutation.color;
        }
        break;
      }
      case 'task_create': {
        if (!target.columns.some((c) => c.id === mutation.columnId))
          return fail('Board column not found', 404);
        id = createdId;
        if (target.tasks.some((t) => t.id === id)) fail('Board identifier conflict', 409);
        const order = target.tasks
          .filter((t) => t.columnId === mutation.columnId)
          .reduce((max, t) => Math.max(max, t.order + 1), 0);
        if (!Number.isSafeInteger(order))
          fail('Task order limit reached; reorder existing tasks before creating', 409);
        const value: Task = {
          id,
          title: mutation.title,
          tags: mutation.tags,
          assignee: mutation.assignee,
          columnId: mutation.columnId,
          order,
          comments: [],
        };
        if (mutation.description !== undefined) value.description = mutation.description;
        if (mutation.color !== undefined) value.color = mutation.color;
        target.tasks.push(value);
        break;
      }
      case 'task_update':
      case 'task_delete': {
        const item = target.tasks.find((t) => t.id === mutation.taskId);
        if (!item) return fail('Board task not found', 404);
        id = item.id;
        if (mutation.operation === 'task_delete')
          target.tasks = target.tasks.filter((t) => t.id !== id);
        else {
          if (
            mutation.patch.columnId !== undefined &&
            !target.columns.some((c) => c.id === mutation.patch.columnId)
          )
            return fail('Board column not found', 404);
          Object.assign(item, mutation.patch);
        }
        break;
      }
    }
  }
  // Revalidate every nested reference and preserve the existing storage contract.
  const checked = prepareBoardWrite(uid, next.projects, mutation.expectedRevision, raw);
  return {
    next: { ...checked, updatedAt: new Date().toISOString() },
    result: { id, revision: checked.revision },
  };
}
