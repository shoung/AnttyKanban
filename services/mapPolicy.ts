import {
  createMapSchema,
  updateMapSchema,
  mapDocumentSchema,
  idSchema,
  MAX_BODY_BYTES,
  type MapDocument,
} from '../mindmap/lib/model';
export type MapRecord = MapDocument & { ownerUid: string; schemaVersion: 1 };
export type StoredMapRecord = Omit<MapRecord, 'root'> & { rootJson: string };
const fail = (message: string, status: number): never => {
  throw Object.assign(new Error(message), { status });
};
function bounded(input: unknown) {
  if (new TextEncoder().encode(JSON.stringify(input)).byteLength > MAX_BODY_BYTES)
    fail('Map is too large', 413);
}
/** Avoid Firestore's 20-level nested map/array limit. The full persisted envelope is bounded. */
export function mapRecordForStorage(record: MapRecord): StoredMapRecord {
  const { root, ...metadata } = record;
  const stored = { ...metadata, rootJson: JSON.stringify(root) };
  bounded(stored);
  return stored;
}
export function readMapRecord(uid: string, input: unknown): MapRecord {
  const record = input as MapRecord & { rootJson?: unknown };
  if (!record || record.ownerUid !== uid) fail('Map owner does not match account', 403);
  if (record.schemaVersion !== 1) fail('Unsupported map version', 400);
  bounded(record);
  const root = typeof record.rootJson === 'string' ? JSON.parse(record.rootJson) : record.root;
  return { ...mapDocumentSchema.parse({ ...record, root }), ownerUid: uid, schemaVersion: 1 };
}
export function createMapRecord(uid: string, id: string, input: unknown): MapRecord {
  bounded(input);
  idSchema.parse(id);
  const body = createMapSchema.parse(input);
  const record: MapRecord = {
    id,
    title: body.title,
    root: body.root || { id: 'root', text: body.title, children: [] },
    revision: 1,
    updatedAt: new Date().toISOString(),
    ownerUid: uid,
    schemaVersion: 1,
  };
  mapRecordForStorage(record); // Reject an envelope that cannot subsequently be read back.
  return record;
}
export function updateMapRecord(uid: string, previous: unknown, input: unknown): MapRecord {
  bounded(input);
  const old = readMapRecord(uid, previous);
  const body = updateMapSchema.parse(input);
  if (body.expectedRevision !== old.revision || old.revision >= Number.MAX_SAFE_INTEGER)
    fail('Revision conflict: export your draft and reload', 409);
  const record: MapRecord = {
    ...old,
    title: body.title,
    root: body.root,
    revision: old.revision + 1,
    updatedAt: new Date().toISOString(),
  };
  mapRecordForStorage(record);
  return record;
}
