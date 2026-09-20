/** JSON export of the full library. */

import type { Bookmark } from '../shared/types';

export interface JsonExport {
  format: 'x-bookmark-vault/bookmarks';
  version: 1;
  exported_at: string;
  count: number;
  bookmarks: Bookmark[];
}

export function buildJsonExport(bookmarks: Bookmark[], exportedAt: string): JsonExport {
  return {
    format: 'x-bookmark-vault/bookmarks',
    version: 1,
    exported_at: exportedAt,
    count: bookmarks.length,
    bookmarks,
  };
}

export function jsonBlob(payload: unknown): Blob {
  return new Blob([JSON.stringify(payload, null, 2)], {
    type: 'application/json;charset=utf-8',
  });
}
