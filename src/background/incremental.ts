/**
 * Incremental sync heuristic.
 *
 * Kept as pure functions so the stopping rule can be reasoned about and tested
 * on its own, independently of ports, tabs and IndexedDB.
 *
 * The rule: walking the timeline from newest to oldest, count how many
 * bookmarks in a row are already in the library. A single known bookmark
 * proves nothing - bookmarks can be re-saved, and the timeline order can shift
 * - so only a long unbroken run is taken as evidence that we have reached
 * previously synchronised history. Any unknown bookmark resets the count to
 * zero, and a Full Rescan never stops early at all.
 */

import type { MergeOutcome } from '../database/schema';
import type { SyncMode } from '../shared/types';

export const DEFAULT_KNOWN_THRESHOLD = 40;

/** Advances the consecutive-known counter over one batch, in timeline order. */
export function advanceKnownStreak(
  streak: number,
  outcomes: Array<{ outcome: MergeOutcome }>,
): number {
  let next = streak;
  for (const { outcome } of outcomes) {
    // "updated" still means the post was already known; only "new" is unseen.
    if (outcome === 'new') next = 0;
    else next += 1;
  }
  return next;
}

/** Whether the collector should stop after the batch just persisted. */
export function shouldStopIncremental(
  mode: SyncMode,
  streak: number,
  threshold: number,
): boolean {
  if (mode === 'full') return false;
  return streak >= Math.max(1, threshold);
}

export function stopReason(threshold: number): string {
  return `Reached ${threshold} consecutive bookmarks already in your library.`;
}
