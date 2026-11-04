import { randomUUID } from 'node:crypto';
import { FieldPath } from 'firebase-admin/firestore';
import { getAdminDb } from './firebase.js';
import { enforceUid } from './authPolicy.js';
import { idSchema, MAX_BODY_BYTES } from '../mindmap/lib/model.js';
import {
  createMapRecord,
  readMapRecord,
  updateMapRecord,
  mapRecordForStorage,
} from '../services/mapPolicy.js';
import { boardPath, decodeBoard, prepareBoardWrite } from '../services/boardSafety.js';
import * as calendar from './calendar/service.js';
import type { McpDataService } from './mcpServer.js';

export interface WorkspaceStore {
  read(path: string): Promise<unknown | null>;
  list(
    path: string,
    input: { limit: number; after?: string },
  ): Promise<{ id: string; value: unknown }[]>;
  mutate(
    path: string,
    operation: (previous: unknown | null) => { next: unknown | null; result: unknown },
  ): Promise<unknown>;
}
const fail = (message: string, status: number): never => {
  throw Object.assign(new Error(message), { status });
};
function bounded(value: unknown) {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return fail('Invalid JSON data', 400);
  }
  if (serialized === undefined || Buffer.byteLength(serialized) > MAX_BODY_BYTES)
    fail('Workspace data is too large', 413);
}
function collection(uid: string) {
  return `users/${enforceUid(uid)}/mindmaps`;
}
function mapPath(uid: string, id: string) {
  return `${collection(uid)}/${idSchema.parse(id)}`;
}
function checkedMap(uid: string, id: string, raw: unknown) {
  if (raw === null) fail('Mind map not found', 404);
  const map = readMapRecord(uid, raw);
  if (map.id !== id) fail('Mind map identifier does not match its document', 409);
  return map;
}
export function firestoreWorkspaceStore(): WorkspaceStore {
  const db = getAdminDb();
  return {
    async read(path) {
      const row = await db.doc(path).get();
      return row.exists ? row.data() : null;
    },
    async list(path, input) {
      let query = db.collection(path).orderBy(FieldPath.documentId()).limit(input.limit);
      if (input.after) query = query.startAfter(input.after);
      return (await query.get()).docs.map((row) => ({ id: row.id, value: row.data() }));
    },
    async mutate(path, operation) {
      return db.runTransaction(async (tx) => {
        const ref = db.doc(path);
        const row = await tx.get(ref);
        const output = operation(row.exists ? row.data() : null);
        if (output.next === null) tx.delete(ref);
        else tx.set(ref, output.next as Record<string, unknown>);
        return output.result;
      });
    },
  };
}

type CalendarOperations = Pick<
  McpDataService,
  | 'getCalendarStatus'
  | 'listCalendarEvents'
  | 'createCalendarEvent'
  | 'updateCalendarEvent'
  | 'deleteCalendarEvent'
>;
export function createMcpDataService(
  storage: WorkspaceStore = firestoreWorkspaceStore(),
  calendarOperations: CalendarOperations = calendar,
): McpDataService {
  return {
    async listMaps(uid, input) {
      if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 50)
        fail('Invalid page size', 400);
      if (input.after) idSchema.parse(input.after);
      const rows = await storage.list(collection(uid), { ...input, limit: input.limit + 1 });
      const items = rows.slice(0, input.limit).map(({ id, value }) => {
        const map = checkedMap(uid, id, value);
        return { id: map.id, title: map.title, revision: map.revision, updatedAt: map.updatedAt };
      });
      return { items, ...(rows.length > input.limit ? { nextAfter: items.at(-1)!.id } : {}) };
    },
    async getMap(uid, id) {
      return checkedMap(uid, id, await storage.read(mapPath(uid, id)));
    },
    async createMap(uid, input) {
      enforceUid(uid);
      const id = randomUUID();
      const map = createMapRecord(uid, id, input);
      bounded(map);
      return storage.mutate(mapPath(uid, id), (previous) => {
        if (previous !== null) fail('Mind map already exists', 409);
        return { next: mapRecordForStorage(map), result: map };
      });
    },
    async updateMap(uid, id, input) {
      bounded(input);
      return storage.mutate(mapPath(uid, id), (previous) => {
        const map = updateMapRecord(uid, checkedMap(uid, id, previous), input);
        bounded(map);
        return { next: mapRecordForStorage(map), result: map };
      });
    },
    async deleteMap(uid, id, expectedRevision) {
      return storage.mutate(mapPath(uid, id), (previous) => {
        const map = checkedMap(uid, id, previous);
        if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== map.revision)
          fail('Mind map revision conflict; reread before deleting', 409);
        return { next: null, result: { deleted: true, id } };
      });
    },
    async getBoard(uid) {
      enforceUid(uid);
      const raw = await storage.read(boardPath(uid));
      bounded(raw);
      return decodeBoard(uid, raw);
    },
    async replaceBoard(uid, projects, expectedRevision) {
      enforceUid(uid);
      bounded(projects);
      return storage.mutate(boardPath(uid), (previous) => {
        let next;
        try {
          next = {
            ...prepareBoardWrite(uid, projects, expectedRevision, previous),
            updatedAt: new Date().toISOString(),
          };
        } catch (error) {
          return fail(
            error instanceof Error ? error.message : 'Invalid board data',
            error instanceof Error && /revision conflict/i.test(error.message) ? 409 : 400,
          );
        }
        bounded(next);
        return { next, result: next };
      });
    },
    ...calendarOperations,
  };
}
