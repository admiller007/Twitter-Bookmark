import type { Bookmark, BookmarkClassification } from '../shared/types';

/**
 * The only contract the rest of the extension knows about. JEV sits behind it,
 * so swapping in another classifier later means writing one new file.
 */
export interface BookmarkClassifier {
  classify(bookmarks: Bookmark[]): Promise<BookmarkClassification[]>;
}

/** Library context handed to the classifier so it reuses existing labels. */
export interface ClassifierContext {
  /** Categories already used in the library, most common first. */
  knownCategories: string[];
  /** Subcategories already used, across all categories. */
  knownSubcategories: string[];
  /** Extra categories the user seeded in Settings. */
  seedCategories: string[];
}

export interface ClassifyOutcome {
  postId: string;
  ok: boolean;
  classification?: BookmarkClassification;
  error?: string;
}

/** A classifier that can report per-item failures instead of throwing. */
export interface ResilientClassifier extends BookmarkClassifier {
  classifyDetailed(
    bookmarks: Bookmark[],
    onProgress?: (done: number, total: number) => void,
  ): Promise<ClassifyOutcome[]>;
  readonly version: string;
}

export class ClassifierNotConfiguredError extends Error {
  constructor() {
    super('No JEV API key is configured. Add one in Settings to classify bookmarks.');
    this.name = 'ClassifierNotConfiguredError';
  }
}

export class ClassifierRateLimitError extends Error {
  constructor(
    message: string,
    public readonly retryAfterMs: number | null,
  ) {
    super(message);
    this.name = 'ClassifierRateLimitError';
  }
}

export class ClassifierMalformedResponseError extends Error {
  constructor(
    message: string,
    /** Question keys that could not be read, used to build a repair retry. */
    public readonly failedKeys: string[] = [],
  ) {
    super(message);
    this.name = 'ClassifierMalformedResponseError';
  }
}
