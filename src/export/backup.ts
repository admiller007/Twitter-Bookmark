/**
 * Backup export and import.
 *
 * Import merges by post_id so re-importing a backup - or importing one from
 * another machine - never duplicates a bookmark. Merging is conservative: it
 * prefers whichever side actually holds information, and never silently drops
 * a classification or a personal note.
 */

import type { Bookmark } from '../shared/types';
import { DB_VERSION } from '../database/schema';
import { buildSearchTokens, createEmptyBookmark } from '../database/schema';
import { CONTENT_TYPES } from '../shared/types';

export interface BackupFile {
  format: 'x-bookmark-vault/backup';
  version: 1;
  exported_at: string;
  extension_version: string;
  schema_version: number;
  count: number;
  bookmarks: Bookmark[];
}

export function buildBackup(
  bookmarks: Bookmark[],
  extensionVersion: string,
  exportedAt: string,
): BackupFile {
  return {
    format: 'x-bookmark-vault/backup',
    version: 1,
    exported_at: exportedAt,
    extension_version: extensionVersion,
    schema_version: DB_VERSION,
    count: bookmarks.length,
    bookmarks,
  };
}

export class BackupParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupParseError';
  }
}

/** Accepts both backup files and plain bookmark JSON exports. */
export function parseBackup(raw: string): Bookmark[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new BackupParseError(
      `That file is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const candidate =
    Array.isArray(parsed)
      ? parsed
      : typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, unknown>)['bookmarks']
        : undefined;

  if (!Array.isArray(candidate)) {
    throw new BackupParseError(
      'That file does not look like an X Bookmark Vault backup (no "bookmarks" array).',
    );
  }

  const bookmarks: Bookmark[] = [];
  for (const item of candidate) {
    const normalized = normalizeImportedBookmark(item);
    if (normalized) bookmarks.push(normalized);
  }

  if (bookmarks.length === 0) {
    throw new BackupParseError('No usable bookmarks were found in that file.');
  }
  return bookmarks;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function strArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function numOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Coerces an arbitrary object into a complete Bookmark, or null if unusable. */
export function normalizeImportedBookmark(value: unknown): Bookmark | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;

  const postId = str(raw['post_id']);
  if (!postId || !/^\d{6,25}$/.test(postId)) return null;

  const base = createEmptyBookmark(
    {
      post_id: postId,
      post_url: str(raw['post_url']) ?? `https://x.com/i/status/${postId}`,
      author_name: str(raw['author_name']),
      author_handle: str(raw['author_handle']),
      author_profile_url: str(raw['author_profile_url']),
      posted_at: str(raw['posted_at']),
      text: str(raw['text']),
      external_urls: strArray(raw['external_urls']),
      media_type: (['none', 'image', 'video', 'gif', 'mixed'] as const).includes(
        raw['media_type'] as never,
      )
        ? (raw['media_type'] as Bookmark['media_type'])
        : 'none',
      image_urls: strArray(raw['image_urls']),
      video_available: raw['video_available'] === true,
      media_thumbnail_urls: strArray(raw['media_thumbnail_urls']),
      quoted_post_id: str(raw['quoted_post_id']),
      quoted_post_url: str(raw['quoted_post_url']),
      quoted_post_author: str(raw['quoted_post_author']),
      quoted_post_text: str(raw['quoted_post_text']),
      reply_to_post_id: str(raw['reply_to_post_id']),
      reply_to_url: str(raw['reply_to_url']),
      like_count: numOrNull(raw['like_count']),
      reply_count: numOrNull(raw['reply_count']),
      repost_count: numOrNull(raw['repost_count']),
      view_count: numOrNull(raw['view_count']),
      source: raw['source'] === 'network' ? 'network' : 'dom',
    },
    str(raw['collected_at']) ?? new Date().toISOString(),
  );

  const contentType = raw['content_type'];
  const record: Bookmark = {
    ...base,
    updated_at: str(raw['updated_at']) ?? base.collected_at,
    is_currently_bookmarked: raw['is_currently_bookmarked'] !== false,
    favorite: raw['favorite'] === true,
    personal_note: str(raw['personal_note']),
    manual_tags: strArray(raw['manual_tags']),
    category: str(raw['category']),
    subcategory: str(raw['subcategory']),
    tags: strArray(raw['tags']),
    content_type: CONTENT_TYPES.includes(contentType as never)
      ? (contentType as Bookmark['content_type'])
      : null,
    actionable: typeof raw['actionable'] === 'boolean' ? raw['actionable'] : null,
    revisit_score: numOrNull(raw['revisit_score']),
    summary: str(raw['summary']),
    why_saved_might_be_useful: str(raw['why_saved_might_be_useful']),
    classified_at: str(raw['classified_at']),
    classifier_version: str(raw['classifier_version']),
    classification_status: (
      ['unclassified', 'pending', 'classified', 'failed', 'skipped'] as const
    ).includes(raw['classification_status'] as never)
      ? (raw['classification_status'] as Bookmark['classification_status'])
      : str(raw['category'])
        ? 'classified'
        : 'unclassified',
    classification_error: str(raw['classification_error']),
    search_tokens: [],
  };

  record.search_tokens = buildSearchTokens(record);
  return record;
}

export interface BackupMergeResult {
  record: Bookmark;
  outcome: 'inserted' | 'merged' | 'unchanged';
}

function isNewer(a: string | null, b: string | null): boolean {
  if (!a) return false;
  if (!b) return true;
  return Date.parse(a) > Date.parse(b);
}

/**
 * Merges one imported record into the local one.
 *
 * - collected_at keeps the earliest of the two: first discovery is a fact.
 * - Scraped fields take the imported value only when the local one is empty,
 *   or when the imported record is strictly newer.
 * - A classification is adopted when the local record has none, or when the
 *   imported classification is newer.
 * - Personal note, favourite and manual tags are user-owned: they are only
 *   ever filled in, never cleared, by an import.
 */
export function mergeImportedBookmark(
  local: Bookmark | undefined,
  imported: Bookmark,
): BackupMergeResult {
  if (!local) return { record: imported, outcome: 'inserted' };

  const importedNewer = isNewer(imported.updated_at, local.updated_at);
  const record: Bookmark = { ...local };
  let changed = false;

  const scrapedKeys: Array<keyof Bookmark> = [
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

  for (const key of scrapedKeys) {
    const incoming = imported[key];
    const current = record[key];
    const incomingEmpty =
      incoming === null || incoming === undefined || (Array.isArray(incoming) && incoming.length === 0);
    const currentEmpty =
      current === null || current === undefined || (Array.isArray(current) && current.length === 0);

    if (incomingEmpty) continue;
    if (!currentEmpty && !importedNewer) continue;
    if (JSON.stringify(current) === JSON.stringify(incoming)) continue;

    (record as unknown as Record<string, unknown>)[key] = incoming;
    changed = true;
  }

  // Earliest discovery wins.
  if (isNewer(record.collected_at, imported.collected_at)) {
    record.collected_at = imported.collected_at;
    changed = true;
  }

  const adoptClassification =
    imported.classification_status === 'classified' &&
    (local.classification_status !== 'classified' ||
      isNewer(imported.classified_at, local.classified_at));

  if (adoptClassification) {
    record.category = imported.category;
    record.subcategory = imported.subcategory;
    record.tags = imported.tags;
    record.content_type = imported.content_type;
    record.actionable = imported.actionable;
    record.revisit_score = imported.revisit_score;
    record.summary = imported.summary;
    record.why_saved_might_be_useful = imported.why_saved_might_be_useful;
    record.classified_at = imported.classified_at;
    record.classifier_version = imported.classifier_version;
    record.classification_status = 'classified';
    record.classification_error = null;
    changed = true;
  }

  // User-owned fields: fill gaps, never erase.
  if (imported.favorite && !record.favorite) {
    record.favorite = true;
    changed = true;
  }
  if (imported.personal_note && !record.personal_note) {
    record.personal_note = imported.personal_note;
    changed = true;
  }
  if (imported.manual_tags.length > 0) {
    const merged = [...new Set([...record.manual_tags, ...imported.manual_tags])];
    if (merged.length !== record.manual_tags.length) {
      record.manual_tags = merged;
      changed = true;
    }
  }

  // A local record already flagged as un-bookmarked is restored if the backup
  // says it was still bookmarked more recently.
  if (imported.is_currently_bookmarked && !record.is_currently_bookmarked && importedNewer) {
    record.is_currently_bookmarked = true;
    changed = true;
  }

  if (!changed) return { record: local, outcome: 'unchanged' };

  record.updated_at = importedNewer ? imported.updated_at : local.updated_at;
  record.search_tokens = buildSearchTokens(record);
  return { record, outcome: 'merged' };
}

export interface ImportSummary {
  inserted: number;
  merged: number;
  unchanged: number;
  records: Bookmark[];
}

/** Pure merge of a whole backup against the current library. */
export function mergeBackup(existing: Bookmark[], imported: Bookmark[]): ImportSummary {
  const byId = new Map(existing.map((bookmark) => [bookmark.post_id, bookmark]));
  const summary: ImportSummary = { inserted: 0, merged: 0, unchanged: 0, records: [] };

  for (const incoming of imported) {
    const { record, outcome } = mergeImportedBookmark(byId.get(incoming.post_id), incoming);
    if (outcome === 'inserted') summary.inserted += 1;
    else if (outcome === 'merged') summary.merged += 1;
    else summary.unchanged += 1;

    // Later duplicates inside one file merge onto the running result.
    byId.set(incoming.post_id, record);
    if (outcome !== 'unchanged') summary.records.push(record);
  }

  return summary;
}
