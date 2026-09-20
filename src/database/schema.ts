/**
 * IndexedDB schema, versioning and record merge rules.
 *
 * Everything in this file is pure so the merge and tokenisation rules can be
 * tested without a browser. Schema changes are made by appending a migration -
 * the first schema is explicitly not assumed to be the last.
 */

import type {
  Bookmark,
  BookmarkClassification,
  BookmarkSource,
  ClassificationStatus,
} from '../shared/types';

export const DB_NAME = 'x-bookmark-vault';

/** Bump this and append to MIGRATIONS when the schema changes. */
export const DB_VERSION = 1;

export const STORE = {
  bookmarks: 'bookmarks',
  syncSessions: 'sync_sessions',
  diagnostics: 'diagnostics',
  meta: 'meta',
} as const;

export const BOOKMARK_INDEX = {
  collectedAt: 'by_collected_at',
  postedAt: 'by_posted_at',
  authorHandle: 'by_author_handle',
  category: 'by_category',
  classificationStatus: 'by_classification_status',
  isCurrentlyBookmarked: 'by_is_currently_bookmarked',
  searchTokens: 'by_search_tokens',
} as const;

export interface Migration {
  version: number;
  describe: string;
  apply(db: IDBDatabase, transaction: IDBTransaction): void;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    describe: 'initial schema: bookmarks, sync sessions, diagnostics, meta',
    apply(db) {
      if (!db.objectStoreNames.contains(STORE.bookmarks)) {
        const store = db.createObjectStore(STORE.bookmarks, { keyPath: 'post_id' });
        store.createIndex(BOOKMARK_INDEX.collectedAt, 'collected_at');
        store.createIndex(BOOKMARK_INDEX.postedAt, 'posted_at');
        store.createIndex(BOOKMARK_INDEX.authorHandle, 'author_handle');
        store.createIndex(BOOKMARK_INDEX.category, 'category');
        store.createIndex(BOOKMARK_INDEX.classificationStatus, 'classification_status');
        // IndexedDB cannot index booleans, so a 0/1 mirror field is indexed.
        store.createIndex(BOOKMARK_INDEX.isCurrentlyBookmarked, 'bookmarked_flag');
        store.createIndex(BOOKMARK_INDEX.searchTokens, 'search_tokens', { multiEntry: true });
      }
      if (!db.objectStoreNames.contains(STORE.syncSessions)) {
        const store = db.createObjectStore(STORE.syncSessions, { keyPath: 'sync_id' });
        store.createIndex('by_started_at', 'started_at');
      }
      if (!db.objectStoreNames.contains(STORE.diagnostics)) {
        const store = db.createObjectStore(STORE.diagnostics, {
          keyPath: 'id',
          autoIncrement: true,
        });
        store.createIndex('by_ts', 'ts');
      }
      if (!db.objectStoreNames.contains(STORE.meta)) {
        db.createObjectStore(STORE.meta, { keyPath: 'key' });
      }
    },
  },
];

/** Stored shape adds an indexable mirror of is_currently_bookmarked. */
export type StoredBookmark = Bookmark & { bookmarked_flag: 0 | 1 };

export function toStored(bookmark: Bookmark): StoredBookmark {
  return { ...bookmark, bookmarked_flag: bookmark.is_currently_bookmarked ? 1 : 0 };
}

export function fromStored(stored: StoredBookmark): Bookmark {
  const { bookmarked_flag: _flag, ...rest } = stored;
  return rest;
}

/* ------------------------------------------------------------- tokenisation */

const MAX_TOKENS = 220;

/**
 * Splits text into lowercase search tokens.
 *
 * Unicode-aware so non-Latin posts are searchable, and it keeps hashtags and
 * handles as their bare word form.
 */
export function tokenize(input: string | null | undefined): string[] {
  if (!input) return [];
  const normalized = String(input).toLowerCase().normalize('NFKD');
  const matches = normalized.match(/[\p{L}\p{N}][\p{L}\p{N}_'-]*/gu) ?? [];
  const out: string[] = [];
  for (const raw of matches) {
    const token = raw.replace(/^[_'-]+|[_'-]+$/g, '');
    if (token.length < 2) continue;
    if (!out.includes(token)) out.push(token);
    if (out.length >= MAX_TOKENS) break;
  }
  return out;
}

/** Builds the full token list backing local search for one bookmark. */
export function buildSearchTokens(bookmark: Bookmark): string[] {
  const parts = [
    bookmark.text,
    bookmark.author_name,
    bookmark.author_handle,
    bookmark.quoted_post_text,
    bookmark.quoted_post_author,
    bookmark.category,
    bookmark.subcategory,
    bookmark.summary,
    bookmark.why_saved_might_be_useful,
    bookmark.personal_note,
    bookmark.tags.join(' '),
    bookmark.manual_tags.join(' '),
    bookmark.external_urls.map((url) => url.replace(/^https?:\/\//, '')).join(' '),
  ];
  return tokenize(parts.filter(Boolean).join(' \n '));
}

/* -------------------------------------------------------------------- merge */

/** Source fields that a later sync is allowed to refresh. */
const SOURCE_FIELDS: Array<keyof BookmarkSource> = [
  'post_url',
  'author_name',
  'author_handle',
  'author_profile_url',
  'posted_at',
  'text',
  'external_urls',
  'media_type',
  'image_urls',
  'video_available',
  'media_thumbnail_urls',
  'quoted_post_id',
  'quoted_post_url',
  'quoted_post_author',
  'quoted_post_text',
  'reply_to_post_id',
  'reply_to_url',
  'like_count',
  'reply_count',
  'repost_count',
  'view_count',
];

function isMeaningful(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => item === b[index]);
  }
  return a === b;
}

export function createEmptyBookmark(source: BookmarkSource, collectedAt: string): Bookmark {
  const bookmark: Bookmark = {
    ...source,
    collected_at: collectedAt,
    updated_at: collectedAt,
    is_currently_bookmarked: true,
    favorite: false,
    personal_note: null,
    manual_tags: [],
    category: null,
    subcategory: null,
    tags: [],
    content_type: null,
    actionable: null,
    revisit_score: null,
    summary: null,
    why_saved_might_be_useful: null,
    classified_at: null,
    classifier_version: null,
    classification_status: 'unclassified' as ClassificationStatus,
    classification_error: null,
    search_tokens: [],
  };
  bookmark.search_tokens = buildSearchTokens(bookmark);
  return bookmark;
}

export type MergeOutcome = 'new' | 'updated' | 'unchanged';

export interface MergeResult {
  record: Bookmark;
  outcome: MergeOutcome;
  changedFields: string[];
}

/**
 * Merges a freshly scraped record into whatever is already stored.
 *
 * Rules, in order of importance:
 *  - post_id is the primary key, so re-seeing a post never duplicates it.
 *  - collected_at is set once, on first discovery, and never moves.
 *  - Classification and user-owned fields are never touched here.
 *  - A missing value in the incoming record never erases a stored one: a
 *    degraded extraction pass can only add information, never remove it.
 */
export function mergeBookmark(
  existing: Bookmark | undefined,
  incoming: BookmarkSource,
  collectedAt: string,
): MergeResult {
  if (!existing) {
    return {
      record: createEmptyBookmark(incoming, collectedAt),
      outcome: 'new',
      changedFields: [],
    };
  }

  const record: Bookmark = { ...existing };
  const changedFields: string[] = [];

  for (const field of SOURCE_FIELDS) {
    const next = incoming[field];
    if (!isMeaningful(next)) continue;
    const current = (record as unknown as Record<string, unknown>)[field];
    if (sameValue(current, next)) continue;
    (record as unknown as Record<string, unknown>)[field] = next;
    changedFields.push(field);
  }

  // Seeing a bookmark again is proof it is still bookmarked.
  if (!record.is_currently_bookmarked) {
    record.is_currently_bookmarked = true;
    changedFields.push('is_currently_bookmarked');
  }

  // Network records are richer; record that provenance when it upgrades.
  if (incoming.source === 'network' && record.source !== 'network') {
    record.source = 'network';
  }

  if (changedFields.length === 0) {
    return { record: existing, outcome: 'unchanged', changedFields: [] };
  }

  record.updated_at = collectedAt;
  record.search_tokens = buildSearchTokens(record);
  return { record, outcome: 'updated', changedFields };
}

/** Applies a validated classification without touching scraped or user data. */
export function applyClassificationToBookmark(
  bookmark: Bookmark,
  classification: BookmarkClassification,
  classifierVersion: string,
  classifiedAt: string,
): Bookmark {
  const next: Bookmark = {
    ...bookmark,
    category: classification.category,
    subcategory: classification.subcategory,
    tags: classification.tags,
    content_type: classification.contentType,
    actionable: classification.actionable,
    revisit_score: classification.revisitScore,
    summary: classification.summary,
    why_saved_might_be_useful: classification.whySavedMightBeUseful,
    classified_at: classifiedAt,
    classifier_version: classifierVersion,
    classification_status: 'classified',
    classification_error: null,
  };
  next.search_tokens = buildSearchTokens(next);
  return next;
}
