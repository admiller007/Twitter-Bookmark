/**
 * Local diagnostics export.
 *
 * There is no telemetry in this extension. This is the replacement: a file the
 * user can generate, read and choose to share. It deliberately contains no
 * cookies, no API key, no auth token and no bookmark text.
 */

import type { DiagnosticEvent, SyncSession } from '../shared/types';
import { DB_NAME, DB_VERSION } from '../database/schema';
import { redactSettings, type Settings } from '../shared/settings';

export interface DiagnosticsReport {
  generated_at: string;
  extension: { name: string; version: string };
  browser: { user_agent: string | null; language: string | null };
  database: { name: string; schema_version: number; bookmark_count: number };
  library: {
    classified: number;
    unclassified: number;
    failed: number;
    categories: number;
    oldest_collected_at: string | null;
    newest_collected_at: string | null;
  };
  last_sync: Pick<
    SyncSession,
    | 'sync_id'
    | 'mode'
    | 'status'
    | 'started_at'
    | 'last_activity_at'
    | 'new_count'
    | 'updated_count'
    | 'seen_count'
    | 'error_message'
    | 'stop_reason'
  > | null;
  settings: Record<string, unknown>;
  recent_events: DiagnosticEvent[];
  note: string;
}

export interface DiagnosticsInput {
  extensionVersion: string;
  bookmarkCount: number;
  classified: number;
  unclassified: number;
  failed: number;
  categories: number;
  oldestCollectedAt: string | null;
  newestCollectedAt: string | null;
  lastSync: SyncSession | null;
  settings: Settings;
  events: DiagnosticEvent[];
  userAgent: string | null;
  language: string | null;
  generatedAt: string;
}

export function buildDiagnostics(input: DiagnosticsInput): DiagnosticsReport {
  return {
    generated_at: input.generatedAt,
    extension: { name: 'X Bookmark Vault', version: input.extensionVersion },
    browser: { user_agent: input.userAgent, language: input.language },
    database: {
      name: DB_NAME,
      schema_version: DB_VERSION,
      bookmark_count: input.bookmarkCount,
    },
    library: {
      classified: input.classified,
      unclassified: input.unclassified,
      failed: input.failed,
      categories: input.categories,
      oldest_collected_at: input.oldestCollectedAt,
      newest_collected_at: input.newestCollectedAt,
    },
    last_sync: input.lastSync
      ? {
          sync_id: input.lastSync.sync_id,
          mode: input.lastSync.mode,
          status: input.lastSync.status,
          started_at: input.lastSync.started_at,
          last_activity_at: input.lastSync.last_activity_at,
          new_count: input.lastSync.new_count,
          updated_count: input.lastSync.updated_count,
          seen_count: input.lastSync.seen_count,
          error_message: input.lastSync.error_message,
          stop_reason: input.lastSync.stop_reason,
        }
      : null,
    settings: redactSettings(input.settings),
    recent_events: input.events,
    note:
      'This report contains no cookies, API keys, auth tokens or bookmark content. ' +
      'Use Export JSON or Export Backup if you intend to share bookmark data.',
  };
}
