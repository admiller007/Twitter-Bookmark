/**
 * Export / import actions wired to the UI.
 *
 * Large exports are assembled in chunks with a yield between them so the page
 * keeps repainting while a big library is serialised.
 */

import type { Bookmark } from '../../shared/types';
import { csvChunks } from '../../export/csv';
import { buildJsonExport, jsonBlob } from '../../export/json';
import { buildBackup, mergeBackup, parseBackup } from '../../export/backup';
import { putBookmarks } from '../../database/db';
import { nowIso, yieldToEventLoop } from '../../shared/util';
import { downloadBlob, readTextFile } from './download';
import { timestampSlug } from './format';

export function extensionVersion(): string {
  try {
    return chrome.runtime.getManifest().version;
  } catch {
    return '0.0.0';
  }
}

/** Builds the CSV Blob without blocking the UI thread for long stretches. */
export async function buildCsvBlobAsync(bookmarks: Bookmark[]): Promise<Blob> {
  const parts: BlobPart[] = ['﻿'];
  let sinceYield = 0;

  for (const chunk of csvChunks(bookmarks)) {
    parts.push(chunk);
    sinceYield += 1;
    if (sinceYield >= 4) {
      sinceYield = 0;
      await yieldToEventLoop();
    }
  }
  return new Blob(parts, { type: 'text/csv;charset=utf-8' });
}

export async function exportCsv(bookmarks: Bookmark[], label = 'bookmarks'): Promise<number> {
  const blob = await buildCsvBlobAsync(bookmarks);
  downloadBlob(blob, `x-bookmark-vault-${label}-${timestampSlug()}.csv`);
  return bookmarks.length;
}

export async function exportJson(bookmarks: Bookmark[], label = 'bookmarks'): Promise<number> {
  const blob = jsonBlob(buildJsonExport(bookmarks, nowIso()));
  downloadBlob(blob, `x-bookmark-vault-${label}-${timestampSlug()}.json`);
  return bookmarks.length;
}

export async function exportBackup(bookmarks: Bookmark[]): Promise<number> {
  const blob = jsonBlob(buildBackup(bookmarks, extensionVersion(), nowIso()));
  downloadBlob(blob, `x-bookmark-vault-backup-${timestampSlug()}.json`);
  return bookmarks.length;
}

export interface ImportResult {
  inserted: number;
  merged: number;
  unchanged: number;
}

/** Reads a backup file and merges it into the library by post_id. */
export async function importBackupFile(file: File, existing: Bookmark[]): Promise<ImportResult> {
  const text = await readTextFile(file);
  const imported = parseBackup(text);
  const summary = mergeBackup(existing, imported);

  if (summary.records.length > 0) await putBookmarks(summary.records);

  return {
    inserted: summary.inserted,
    merged: summary.merged,
    unchanged: summary.unchanged,
  };
}
