/** Types local to the X adapter layer. */

export interface ExtractionContext {
  /** Where the record came from, for provenance. */
  source: 'dom' | 'network';
  /** ISO timestamp used as collected_at for everything in this pass. */
  collectedAt: string;
}

export interface ExtractionIssue {
  reason: string;
  detail?: string;
}

/** Signals used to tell "X changed its DOM" apart from "no bookmarks yet". */
export interface PageHealth {
  onBookmarksPage: boolean;
  loggedIn: boolean;
  articleCount: number;
  /** Articles present but none produced a post id -> selectors are stale. */
  unsupportedDom: boolean;
  emptyState: boolean;
}
