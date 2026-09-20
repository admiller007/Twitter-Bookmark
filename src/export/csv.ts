/**
 * CSV export.
 *
 * RFC 4180 quoting, UTF-8 throughout. Emoji and other astral-plane characters
 * pass through untouched because nothing here operates on UTF-16 code units in
 * a way that could split a surrogate pair. Rows are produced by a generator so
 * a large library is serialised in chunks instead of being copied whole.
 */

import type { Bookmark } from '../shared/types';

/** Separator for list-valued cells (tags, URLs). */
export const ARRAY_SEPARATOR = '|';

export const CSV_COLUMNS = [
  'post_id',
  'post_url',
  'author_name',
  'author_handle',
  'posted_at',
  'collected_at',
  'text',
  'external_urls',
  'image_urls',
  'media_type',
  'video_available',
  'quoted_post_url',
  'quoted_post_text',
  'like_count',
  'reply_count',
  'repost_count',
  'view_count',
  'category',
  'subcategory',
  'tags',
  'content_type',
  'actionable',
  'revisit_score',
  'summary',
  'why_saved_might_be_useful',
  'classified_at',
  'classification_status',
  'favorite',
  'personal_note',
  'manual_tags',
  'is_currently_bookmarked',
] as const;

export type CsvColumn = (typeof CSV_COLUMNS)[number];

/**
 * Escapes one CSV field.
 *
 * A field is quoted when it contains a comma, a quote, a CR or an LF, or when
 * it has leading/trailing whitespace that a parser might otherwise trim.
 * Embedded quotes are doubled. null and undefined become an empty cell.
 */
export function escapeCsvValue(value: unknown): string {
  if (value === null || value === undefined) return '';

  let text: string;
  if (Array.isArray(value)) text = value.map((item) => String(item)).join(ARRAY_SEPARATOR);
  else if (typeof value === 'boolean') text = value ? 'true' : 'false';
  else text = String(value);

  if (text === '') return '';

  const needsQuotes =
    text.includes(',') ||
    text.includes('"') ||
    text.includes('\n') ||
    text.includes('\r') ||
    text !== text.trim();

  if (!needsQuotes) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

export function csvRow(values: unknown[]): string {
  return values.map(escapeCsvValue).join(',');
}

/** The exported value for one column of one bookmark. */
export function csvCellValue(bookmark: Bookmark, column: CsvColumn): unknown {
  switch (column) {
    case 'external_urls':
      return bookmark.external_urls;
    case 'image_urls':
      return bookmark.image_urls;
    case 'tags':
      return bookmark.tags;
    case 'manual_tags':
      return bookmark.manual_tags;
    case 'revisit_score':
      return bookmark.revisit_score === null ? '' : bookmark.revisit_score.toFixed(2);
    default:
      return (bookmark as unknown as Record<string, unknown>)[column];
  }
}

export function csvHeader(): string {
  return csvRow([...CSV_COLUMNS]);
}

export function bookmarkToCsvRow(bookmark: Bookmark): string {
  return csvRow(CSV_COLUMNS.map((column) => csvCellValue(bookmark, column)));
}

/**
 * Yields the CSV a chunk at a time. Each chunk holds `rowsPerChunk` rows, so
 * the whole file never exists as a single extra string in memory.
 */
export function* csvChunks(bookmarks: Bookmark[], rowsPerChunk = 500): Generator<string> {
  yield `${csvHeader()}\r\n`;

  let buffer: string[] = [];
  for (const bookmark of bookmarks) {
    buffer.push(`${bookmarkToCsvRow(bookmark)}\r\n`);
    if (buffer.length >= rowsPerChunk) {
      yield buffer.join('');
      buffer = [];
    }
  }
  if (buffer.length > 0) yield buffer.join('');
}

/** Convenience for tests and small exports. */
export function toCsv(bookmarks: Bookmark[]): string {
  return [...csvChunks(bookmarks)].join('');
}

/**
 * Builds the downloadable Blob. The UTF-8 BOM is included by default so
 * Excel opens emoji and non-Latin text correctly; the parts array is handed
 * to Blob directly rather than concatenated first.
 */
export function csvBlob(bookmarks: Bookmark[], withBom = true): Blob {
  const parts: BlobPart[] = withBom ? ['﻿'] : [];
  for (const chunk of csvChunks(bookmarks)) parts.push(chunk);
  return new Blob(parts, { type: 'text/csv;charset=utf-8' });
}
