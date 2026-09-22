/**
 * Promise wrapper around IndexedDB.
 *
 * The database lives in the extension's own origin, which is why the content
 * script (running in x.com's origin) hands everything to the background worker
 * rather than writing directly.
 *
 * Errors are never swallowed: a failed transaction rejects with a message the
 * UI can show.
 */

import type {
  Bookmark,
  BookmarkClassification,
  BookmarkSource,
  DiagnosticEvent,
  SyncSession,
} from '../shared/types';
import {
  BOOKMARK_INDEX,
  DB_NAME,
  DB_VERSION,
  MIGRATIONS,
  STORE,
  applyClassificationToBookmark,
  buildSearchTokens,
  fromStored,
  mergeBookmark,
  toStored,
  type MergeOutcome,
  type StoredBookmark,
} from './schema';
import { nowIso } from '../shared/util';

const MAX_DIAGNOSTIC_EVENTS = 500;

let dbPromise: Promise<IDBDatabase> | null = null;

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

export function openDatabase(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  const pending = new Promise<IDBDatabase>((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, DB_VERSION);

    open.onupgradeneeded = (event) => {
      const db = open.result;
      const tx = open.transaction;
      if (!tx) {
        reject(new Error('Upgrade transaction unavailable'));
        return;
      }
      const from = event.oldVersion;
      // Apply every migration newer than the installed version, in order.
      for (const migration of MIGRATIONS) {
        if (migration.version > from) migration.apply(db, tx);
      }
    };

    open.onsuccess = () => {
      const db = open.result;
      db.onversionchange = () => {
        // Another context wants to upgrade; release the handle so it can.
        db.close();
        if (dbPromise === pending) dbPromise = null;
      };
      resolve(db);
    };

    open.onerror = () =>
      reject(
        new Error(
          `Could not open the local database: ${open.error?.message ?? 'unknown IndexedDB error'}`,
        ),
      );

    open.onblocked = () =>
      reject(
        new Error(
          'The local database is blocked by another tab. Close other X Bookmark Vault tabs and try again.',
        ),
      );
  });

  // Both ways an open can fail are recoverable - another tab holding the
  // database while an upgrade is pending, or a transient storage error - and
  // the messages above tell the user to try again. Caching the rejected
  // promise would make that retry impossible, so the handle is dropped on
  // failure and the next call opens afresh.
  pending.catch(() => {
    if (dbPromise === pending) dbPromise = null;
  });

  dbPromise = pending;
  return pending;
}

/** Test hook: drops the cached connection. */
export function resetDatabaseHandle(): void {
  dbPromise = null;
}

/* ---------------------------------------------------------------- bookmarks */

export async function getBookmark(postId: string): Promise<Bookmark | undefined> {
  const db = await openDatabase();
  const tx = db.transaction(STORE.bookmarks, 'readonly');
  const stored = await request<StoredBookmark | undefined>(
    tx.objectStore(STORE.bookmarks).get(postId),
  );
  return stored ? fromStored(stored) : undefined;
}

export async function getAllBookmarks(): Promise<Bookmark[]> {
  const db = await openDatabase();
  const tx = db.transaction(STORE.bookmarks, 'readonly');
  const all = await request<StoredBookmark[]>(tx.objectStore(STORE.bookmarks).getAll());
  return all.map(fromStored);
}

export async function countBookmarks(): Promise<number> {
  const db = await openDatabase();
  const tx = db.transaction(STORE.bookmarks, 'readonly');
  return request<number>(tx.objectStore(STORE.bookmarks).count());
}

/** Every post id currently stored, used by the incremental sync heuristic. */
export async function getAllPostIds(): Promise<string[]> {
  const db = await openDatabase();
  const tx = db.transaction(STORE.bookmarks, 'readonly');
  const keys = await request<IDBValidKey[]>(tx.objectStore(STORE.bookmarks).getAllKeys());
  return keys.map(String);
}

export interface UpsertSummary {
  newCount: number;
  updatedCount: number;
  unchangedCount: number;
  /** Per-post outcome, in the order supplied. */
  outcomes: Array<{ post_id: string; outcome: MergeOutcome }>;
}

/**
 * Merges a batch of scraped records in a single transaction.
 * Duplicate post ids inside the batch collapse onto one record.
 */
export async function upsertBookmarks(
  incoming: BookmarkSource[],
  collectedAt = nowIso(),
): Promise<UpsertSummary> {
  const summary: UpsertSummary = {
    newCount: 0,
    updatedCount: 0,
    unchangedCount: 0,
    outcomes: [],
  };
  if (incoming.length === 0) return summary;

  const db = await openDatabase();
  const tx = db.transaction(STORE.bookmarks, 'readwrite');
  const store = tx.objectStore(STORE.bookmarks);

  // Track within-batch writes so a repeated id merges instead of racing.
  const staged = new Map<string, Bookmark>();

  for (const source of incoming) {
    if (!source || typeof source.post_id !== 'string' || !/^\d{6,25}$/.test(source.post_id)) {
      continue;
    }

    const existing =
      staged.get(source.post_id) ??
      (await request<StoredBookmark | undefined>(store.get(source.post_id)).then((s) =>
        s ? fromStored(s) : undefined,
      ));

    const { record, outcome } = mergeBookmark(existing, source, collectedAt);

    if (outcome === 'new') summary.newCount += 1;
    else if (outcome === 'updated') summary.updatedCount += 1;
    else summary.unchangedCount += 1;

    summary.outcomes.push({ post_id: source.post_id, outcome });

    if (outcome !== 'unchanged') {
      staged.set(source.post_id, record);
      store.put(toStored(record));
    } else {
      staged.set(source.post_id, record);
    }
  }

  await transactionDone(tx);
  return summary;
}

/** Writes a complete record, e.g. from a backup import. */
export async function putBookmarks(bookmarks: Bookmark[]): Promise<void> {
  if (bookmarks.length === 0) return;
  const db = await openDatabase();
  const tx = db.transaction(STORE.bookmarks, 'readwrite');
  const store = tx.objectStore(STORE.bookmarks);
  for (const bookmark of bookmarks) store.put(toStored(bookmark));
  await transactionDone(tx);
}

export async function deleteBookmarks(postIds: string[]): Promise<void> {
  if (postIds.length === 0) return;
  const db = await openDatabase();
  const tx = db.transaction(STORE.bookmarks, 'readwrite');
  const store = tx.objectStore(STORE.bookmarks);
  for (const id of postIds) store.delete(id);
  await transactionDone(tx);
}

/** Updates user-owned metadata. Classifier output is left untouched. */
export async function updateManualFields(
  postId: string,
  patch: Partial<Pick<Bookmark, 'favorite' | 'personal_note' | 'manual_tags'>>,
): Promise<Bookmark> {
  const db = await openDatabase();
  const tx = db.transaction(STORE.bookmarks, 'readwrite');
  const store = tx.objectStore(STORE.bookmarks);
  const stored = await request<StoredBookmark | undefined>(store.get(postId));
  if (!stored) throw new Error(`Bookmark ${postId} is not in the local database.`);

  const next: Bookmark = { ...fromStored(stored), ...patch, updated_at: nowIso() };
  next.search_tokens = buildSearchTokens(next);
  store.put(toStored(next));
  await transactionDone(tx);
  return next;
}

/** Bulk category / tag edits from the library UI. */
export async function bulkUpdateBookmarks(
  postIds: string[],
  patch: Partial<Pick<Bookmark, 'category' | 'subcategory' | 'tags' | 'favorite' | 'manual_tags'>>,
): Promise<number> {
  if (postIds.length === 0) return 0;
  const db = await openDatabase();
  const tx = db.transaction(STORE.bookmarks, 'readwrite');
  const store = tx.objectStore(STORE.bookmarks);
  let updated = 0;

  for (const id of postIds) {
    const stored = await request<StoredBookmark | undefined>(store.get(id));
    if (!stored) continue;
    const next: Bookmark = { ...fromStored(stored), ...patch, updated_at: nowIso() };
    next.search_tokens = buildSearchTokens(next);
    store.put(toStored(next));
    updated += 1;
  }

  await transactionDone(tx);
  return updated;
}

export async function setClassificationStatus(
  postIds: string[],
  status: Bookmark['classification_status'],
  error: string | null = null,
): Promise<void> {
  if (postIds.length === 0) return;
  const db = await openDatabase();
  const tx = db.transaction(STORE.bookmarks, 'readwrite');
  const store = tx.objectStore(STORE.bookmarks);

  for (const id of postIds) {
    const stored = await request<StoredBookmark | undefined>(store.get(id));
    if (!stored) continue;
    store.put(toStored({ ...fromStored(stored), classification_status: status, classification_error: error }));
  }
  await transactionDone(tx);
}

export async function saveClassifications(
  classifications: BookmarkClassification[],
  classifierVersion: string,
): Promise<number> {
  if (classifications.length === 0) return 0;
  const db = await openDatabase();
  const tx = db.transaction(STORE.bookmarks, 'readwrite');
  const store = tx.objectStore(STORE.bookmarks);
  const at = nowIso();
  let saved = 0;

  for (const classification of classifications) {
    const stored = await request<StoredBookmark | undefined>(store.get(classification.postId));
    if (!stored) continue;
    const next = applyClassificationToBookmark(
      fromStored(stored),
      classification,
      classifierVersion,
      at,
    );
    store.put(toStored(next));
    saved += 1;
  }

  await transactionDone(tx);
  return saved;
}

/** Post ids that have never been classified successfully. */
export async function getUnclassifiedIds(includeFailed = true): Promise<string[]> {
  const db = await openDatabase();
  const tx = db.transaction(STORE.bookmarks, 'readonly');
  const index = tx.objectStore(STORE.bookmarks).index(BOOKMARK_INDEX.classificationStatus);

  const wanted: Array<Bookmark['classification_status']> = includeFailed
    ? ['unclassified', 'pending', 'failed']
    : ['unclassified', 'pending'];

  const ids: string[] = [];
  for (const status of wanted) {
    const keys = await request<IDBValidKey[]>(index.getAllKeys(IDBKeyRange.only(status)));
    for (const key of keys) ids.push(String(key));
  }
  return ids;
}

/**
 * Marks bookmarks that were not observed during a Full Rescan.
 * Records are never deleted automatically - only flagged.
 */
export async function markMissingAsUnbookmarked(seenIds: Set<string>): Promise<number> {
  const db = await openDatabase();
  const tx = db.transaction(STORE.bookmarks, 'readwrite');
  const store = tx.objectStore(STORE.bookmarks);
  const all = await request<StoredBookmark[]>(store.getAll());
  let marked = 0;

  for (const stored of all) {
    if (seenIds.has(stored.post_id)) continue;
    if (!stored.is_currently_bookmarked) continue;
    store.put(toStored({ ...fromStored(stored), is_currently_bookmarked: false, updated_at: nowIso() }));
    marked += 1;
  }

  await transactionDone(tx);
  return marked;
}

/* ------------------------------------------------------------ sync sessions */

export async function saveSyncSession(session: SyncSession): Promise<void> {
  const db = await openDatabase();
  const tx = db.transaction(STORE.syncSessions, 'readwrite');
  tx.objectStore(STORE.syncSessions).put(session);
  await transactionDone(tx);
}

export async function getSyncSession(syncId: string): Promise<SyncSession | undefined> {
  const db = await openDatabase();
  const tx = db.transaction(STORE.syncSessions, 'readonly');
  return request<SyncSession | undefined>(tx.objectStore(STORE.syncSessions).get(syncId));
}

export async function getRecentSyncSessions(limit = 20): Promise<SyncSession[]> {
  const db = await openDatabase();
  const tx = db.transaction(STORE.syncSessions, 'readonly');
  const all = await request<SyncSession[]>(tx.objectStore(STORE.syncSessions).getAll());
  return all.sort((a, b) => b.started_at.localeCompare(a.started_at)).slice(0, limit);
}

/** The most recent session that can still be resumed. */
export async function getResumableSession(): Promise<SyncSession | undefined> {
  const sessions = await getRecentSyncSessions(5);
  return sessions.find((s) => s.status === 'running' || s.status === 'paused');
}

/* -------------------------------------------------------------- diagnostics */

export async function appendDiagnostic(event: Omit<DiagnosticEvent, 'id'>): Promise<void> {
  const db = await openDatabase();
  const tx = db.transaction(STORE.diagnostics, 'readwrite');
  const store = tx.objectStore(STORE.diagnostics);
  store.add(event);

  // Keep the log bounded; it is a rolling local buffer, not an archive.
  const count = await request<number>(store.count());
  if (count > MAX_DIAGNOSTIC_EVENTS) {
    const cursorReq = store.openCursor();
    let toDelete = count - MAX_DIAGNOSTIC_EVENTS;
    await new Promise<void>((resolve, reject) => {
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor || toDelete <= 0) return resolve();
        cursor.delete();
        toDelete -= 1;
        cursor.continue();
      };
      cursorReq.onerror = () => reject(cursorReq.error);
    });
  }

  await transactionDone(tx);
}

export async function getDiagnostics(limit = 200): Promise<DiagnosticEvent[]> {
  const db = await openDatabase();
  const tx = db.transaction(STORE.diagnostics, 'readonly');
  const all = await request<DiagnosticEvent[]>(tx.objectStore(STORE.diagnostics).getAll());
  return all.slice(-limit).reverse();
}

export async function clearDiagnostics(): Promise<void> {
  const db = await openDatabase();
  const tx = db.transaction(STORE.diagnostics, 'readwrite');
  tx.objectStore(STORE.diagnostics).clear();
  await transactionDone(tx);
}

/* ---------------------------------------------------------------- meta / kv */

export async function getMeta<T>(key: string): Promise<T | undefined> {
  const db = await openDatabase();
  const tx = db.transaction(STORE.meta, 'readonly');
  const row = await request<{ key: string; value: T } | undefined>(
    tx.objectStore(STORE.meta).get(key),
  );
  return row?.value;
}

export async function setMeta<T>(key: string, value: T): Promise<void> {
  const db = await openDatabase();
  const tx = db.transaction(STORE.meta, 'readwrite');
  tx.objectStore(STORE.meta).put({ key, value });
  await transactionDone(tx);
}

/** Distinct categories currently in use, most common first. */
export async function getKnownCategories(): Promise<Array<{ name: string; count: number }>> {
  const bookmarks = await getAllBookmarks();
  const counts = new Map<string, number>();
  for (const bookmark of bookmarks) {
    if (!bookmark.category) continue;
    counts.set(bookmark.category, (counts.get(bookmark.category) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

export async function getKnownSubcategories(): Promise<Map<string, string[]>> {
  const bookmarks = await getAllBookmarks();
  const map = new Map<string, Set<string>>();
  for (const bookmark of bookmarks) {
    if (!bookmark.category || !bookmark.subcategory) continue;
    const set = map.get(bookmark.category) ?? new Set<string>();
    set.add(bookmark.subcategory);
    map.set(bookmark.category, set);
  }
  return new Map([...map.entries()].map(([key, value]) => [key, [...value]]));
}
