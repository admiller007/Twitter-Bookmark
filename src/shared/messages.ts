import type {
  Bookmark,
  BookmarkSource,
  DiagnosticEvent,
  SyncMode,
  SyncSession,
} from './types';

/**
 * Message protocol.
 *
 * Content script -> background: extracted bookmarks and collector lifecycle.
 * UI -> background: commands and queries.
 * Background -> content script: start / pause / resume / stop.
 *
 * The content script never touches IndexedDB directly: it runs in x.com's
 * origin, while the database lives in the extension's own origin. Everything
 * is funnelled through the background service worker.
 */

export const PORT_NAME = 'xbv-collector';

/** Progress snapshot broadcast to any open UI. */
export interface SyncProgress {
  session: SyncSession | null;
  /** Total bookmarks in the database. */
  total: number;
  /** Human-readable phase line, e.g. "Scanning older bookmarks...". */
  phase: string;
  /** True when a collector is attached and running in a tab. */
  attached: boolean;
}

export interface ClassifyProgress {
  running: boolean;
  processed: number;
  total: number;
  succeeded: number;
  failed: number;
  phase: string;
  error: string | null;
}

/* ---------------------------------------------------------------- commands */

export type BackgroundRequest =
  | { type: 'sync/start'; mode: SyncMode }
  | { type: 'sync/pause' }
  | { type: 'sync/resume' }
  | { type: 'sync/stop' }
  | { type: 'sync/progress' }
  | { type: 'classify/start'; scope: 'unprocessed' | 'selected'; postIds?: string[] }
  | { type: 'classify/stop' }
  | { type: 'classify/progress' }
  | { type: 'classify/test' }
  | { type: 'db/known-ids' }
  | { type: 'ui/open-library'; hash?: string }
  | { type: 'diagnostics/list'; limit?: number }
  | { type: 'diagnostics/log'; event: Omit<DiagnosticEvent, 'id'> };

export type BackgroundResponse<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; error: string };

/* ------------------------------------------------- collector port messages */

export type CollectorToBackground =
  | { type: 'collector/hello'; url: string }
  | { type: 'collector/batch'; bookmarks: BookmarkSource[]; roundIndex: number }
  | {
      type: 'collector/round';
      seen: number;
      roundIndex: number;
      emptyRounds: number;
      lastPostId: string | null;
    }
  | { type: 'collector/finished'; reason: string }
  | { type: 'collector/error'; message: string; fatal: boolean }
  | { type: 'collector/keepalive' };

export type BackgroundToCollector =
  | { type: 'collector/start'; mode: SyncMode; config: CollectorConfig }
  | { type: 'collector/pause' }
  | { type: 'collector/resume' }
  | { type: 'collector/stop' }
  | {
      type: 'collector/ack';
      newCount: number;
      updatedCount: number;
      /** Total bookmarks in the database, for the in-page counter. */
      total: number;
      stop: boolean;
      reason?: string;
    };

export interface CollectorConfig {
  incrementalKnownThreshold: number;
  emptyRoundLimit: number;
  scrollDelayMs: number;
  scrollStepRatio: number;
  enableNetworkEnhancement: boolean;
}

/* -------------------------------------------------------------- broadcasts */

export type BroadcastEvent =
  | { type: 'event/sync-progress'; progress: SyncProgress }
  | { type: 'event/classify-progress'; progress: ClassifyProgress }
  | { type: 'event/bookmarks-changed' };

/** Typed wrapper around chrome.runtime.sendMessage for UI callers. */
export async function sendToBackground<T>(request: BackgroundRequest): Promise<T> {
  const response = (await chrome.runtime.sendMessage(request)) as
    | BackgroundResponse<T>
    | undefined;
  if (!response) throw new Error('No response from the extension background worker.');
  if (!response.ok) throw new Error(response.error);
  return response.data;
}

export type BookmarkListener = (bookmarks: Bookmark[]) => void;
