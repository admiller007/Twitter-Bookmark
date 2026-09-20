/**
 * Core data model for X Bookmark Vault.
 *
 * Field naming follows the snake_case shape used for CSV export and JSON
 * backups so that the persisted record, the export row and the backup file all
 * line up without a translation layer.
 */

export type MediaType = 'none' | 'image' | 'video' | 'gif' | 'mixed';

export const CONTENT_TYPES = [
  'tool',
  'article',
  'video',
  'thread',
  'news',
  'product',
  'tutorial',
  'idea',
  'code',
  'resource',
  'opinion',
  'other',
] as const;

export type ContentType = (typeof CONTENT_TYPES)[number];

export type ClassificationStatus = 'unclassified' | 'pending' | 'classified' | 'failed' | 'skipped';

/** Data scraped from X. Never invented — anything unavailable stays null. */
export interface BookmarkSource {
  /** Canonical primary key: the numeric X status id. */
  post_id: string;
  post_url: string;
  author_name: string | null;
  author_handle: string | null;
  author_profile_url: string | null;
  /** ISO-8601, from the post's <time datetime> attribute. */
  posted_at: string | null;
  text: string | null;
  external_urls: string[];
  media_type: MediaType;
  image_urls: string[];
  video_available: boolean;
  media_thumbnail_urls: string[];
  quoted_post_id: string | null;
  quoted_post_url: string | null;
  quoted_post_author: string | null;
  quoted_post_text: string | null;
  reply_to_post_id: string | null;
  reply_to_url: string | null;
  like_count: number | null;
  reply_count: number | null;
  repost_count: number | null;
  view_count: number | null;
  /** Which extraction path produced this record. */
  source: 'dom' | 'network';
}

/** Classification produced by a BookmarkClassifier. */
export interface BookmarkClassification {
  postId: string;
  category: string;
  subcategory: string;
  tags: string[];
  contentType: ContentType;
  actionable: boolean;
  /** 0.0 - 1.0 */
  revisitScore: number;
  summary: string;
  whySavedMightBeUseful: string;
}

/** User-owned local metadata. Never written by the classifier. */
export interface BookmarkManualFields {
  favorite: boolean;
  personal_note: string | null;
  manual_tags: string[];
}

/** The full persisted record. */
export interface Bookmark extends BookmarkSource, BookmarkManualFields {
  /** ISO-8601 timestamp of first discovery. */
  collected_at: string;
  /** ISO-8601 timestamp of the most recent metadata update. */
  updated_at: string;
  /** Set false only by an explicit Full Rescan with deletion detection on. */
  is_currently_bookmarked: boolean;

  category: string | null;
  subcategory: string | null;
  tags: string[];
  content_type: ContentType | null;
  actionable: boolean | null;
  revisit_score: number | null;
  summary: string | null;
  why_saved_might_be_useful: string | null;
  classified_at: string | null;
  classifier_version: string | null;
  classification_status: ClassificationStatus;
  classification_error: string | null;

  /** Lowercased token list backing the local search index. */
  search_tokens: string[];
}

export type SyncMode = 'incremental' | 'full';

export type SyncStatus =
  | 'idle'
  | 'running'
  | 'paused'
  | 'completed'
  | 'stopped'
  | 'error';

/** Persisted so a sync survives tab reloads, service-worker restarts and crashes. */
export interface SyncSession {
  sync_id: string;
  started_at: string;
  last_activity_at: string;
  mode: SyncMode;
  new_count: number;
  updated_count: number;
  seen_count: number;
  status: SyncStatus;
  last_seen_post_id: string | null;
  /** Consecutive already-known bookmarks seen, used by the incremental heuristic. */
  consecutive_known_count: number;
  error_message: string | null;
  /** Consecutive scroll rounds that yielded no unseen post ids. */
  empty_rounds: number;
  finished_at: string | null;
  /** Reason the run ended, surfaced in the UI. */
  stop_reason: string | null;
}

export interface DiagnosticEvent {
  id?: number;
  ts: string;
  level: 'info' | 'warn' | 'error';
  scope: string;
  message: string;
  /** Non-sensitive structured context only. */
  detail?: Record<string, unknown>;
}

export interface LibraryStats {
  total: number;
  newThisWeek: number;
  unclassified: number;
  failed: number;
  categories: number;
  topCategories: Array<{ name: string; count: number }>;
  topAuthors: Array<{ name: string; handle: string | null; count: number }>;
  topRevisit: Bookmark[];
  withImages: number;
  withVideo: number;
  withExternalLink: number;
  favorites: number;
}
