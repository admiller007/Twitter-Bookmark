/**
 * Local search, filtering and sorting.
 *
 * Search runs entirely in the browser: no query and no bookmark text is ever
 * sent anywhere. Rather than scanning every record on each keystroke, an
 * inverted index is built once from the token lists already stored on each
 * bookmark and then updated incrementally.
 */

import type { Bookmark, ContentType } from '../shared/types';
import { tokenize } from './schema';

export type SortKey =
  | 'newest'
  | 'oldest'
  | 'recently-collected'
  | 'revisit'
  | 'author'
  | 'likes';

export interface LibraryFilters {
  query: string;
  categories: string[];
  subcategories: string[];
  contentTypes: ContentType[];
  tags: string[];
  authors: string[];
  domains: string[];
  actionable: 'any' | 'yes' | 'no';
  minRevisit: number;
  hasImages: boolean;
  hasVideo: boolean;
  hasExternalLink: boolean;
  favoritesOnly: boolean;
  classification: 'any' | 'classified' | 'unclassified' | 'failed';
  includeUnbookmarked: boolean;
}

export const EMPTY_FILTERS: LibraryFilters = {
  query: '',
  categories: [],
  subcategories: [],
  contentTypes: [],
  tags: [],
  authors: [],
  domains: [],
  actionable: 'any',
  minRevisit: 0,
  hasImages: false,
  hasVideo: false,
  hasExternalLink: false,
  favoritesOnly: false,
  classification: 'any',
  includeUnbookmarked: true,
};

/** token -> post ids. */
export type SearchIndex = Map<string, Set<string>>;

export function buildSearchIndex(bookmarks: Bookmark[]): SearchIndex {
  const index: SearchIndex = new Map();
  for (const bookmark of bookmarks) addToIndex(index, bookmark);
  return index;
}

export function addToIndex(index: SearchIndex, bookmark: Bookmark): void {
  for (const token of bookmark.search_tokens) {
    let bucket = index.get(token);
    if (!bucket) {
      bucket = new Set();
      index.set(token, bucket);
    }
    bucket.add(bookmark.post_id);
  }
}

export function removeFromIndex(index: SearchIndex, bookmark: Bookmark): void {
  for (const token of bookmark.search_tokens) {
    const bucket = index.get(token);
    if (!bucket) continue;
    bucket.delete(bookmark.post_id);
    if (bucket.size === 0) index.delete(token);
  }
}

/**
 * Looks up a query.
 *
 * Terms are ANDed. The final term is treated as a prefix so results narrow
 * while the user is still typing. Returns null when the query is empty, which
 * callers read as "no text constraint".
 */
export function searchIndexFor(index: SearchIndex, query: string): Set<string> | null {
  const terms = tokenize(query);
  if (terms.length === 0) return null;

  let result: Set<string> | null = null;

  terms.forEach((term, position) => {
    const isLast = position === terms.length - 1;
    const matches = new Set<string>();

    const exact = index.get(term);
    if (exact) for (const id of exact) matches.add(id);

    if (isLast && term.length >= 2) {
      // Prefix expansion for the term still being typed.
      for (const [token, bucket] of index) {
        if (token.length > term.length && token.startsWith(term)) {
          for (const id of bucket) matches.add(id);
        }
      }
    }

    if (result === null) {
      result = matches;
    } else {
      const narrowed = new Set<string>();
      for (const id of result) if (matches.has(id)) narrowed.add(id);
      result = narrowed;
    }
  });

  return result ?? new Set<string>();
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

export function bookmarkDomains(bookmark: Bookmark): string[] {
  const out: string[] = [];
  for (const url of bookmark.external_urls) {
    const host = hostOf(url);
    if (host && !out.includes(host)) out.push(host);
  }
  return out;
}

export function matchesFilters(bookmark: Bookmark, filters: LibraryFilters): boolean {
  if (!filters.includeUnbookmarked && !bookmark.is_currently_bookmarked) return false;
  if (filters.favoritesOnly && !bookmark.favorite) return false;

  if (filters.categories.length > 0) {
    if (!bookmark.category || !filters.categories.includes(bookmark.category)) return false;
  }
  if (filters.subcategories.length > 0) {
    if (!bookmark.subcategory || !filters.subcategories.includes(bookmark.subcategory)) return false;
  }
  if (filters.contentTypes.length > 0) {
    if (!bookmark.content_type || !filters.contentTypes.includes(bookmark.content_type)) return false;
  }
  if (filters.tags.length > 0) {
    const all = [...bookmark.tags, ...bookmark.manual_tags];
    if (!filters.tags.every((tag) => all.includes(tag))) return false;
  }
  if (filters.authors.length > 0) {
    if (!bookmark.author_handle || !filters.authors.includes(bookmark.author_handle)) return false;
  }
  if (filters.domains.length > 0) {
    const domains = bookmarkDomains(bookmark);
    if (!filters.domains.some((domain) => domains.includes(domain))) return false;
  }

  if (filters.actionable === 'yes' && bookmark.actionable !== true) return false;
  if (filters.actionable === 'no' && bookmark.actionable !== false) return false;

  if (filters.minRevisit > 0) {
    if (bookmark.revisit_score === null || bookmark.revisit_score < filters.minRevisit) return false;
  }

  if (filters.hasImages && bookmark.image_urls.length === 0) return false;
  if (filters.hasVideo && !bookmark.video_available) return false;
  if (filters.hasExternalLink && bookmark.external_urls.length === 0) return false;

  if (filters.classification === 'classified' && bookmark.classification_status !== 'classified') {
    return false;
  }
  if (
    filters.classification === 'unclassified' &&
    (bookmark.classification_status === 'classified' || bookmark.classification_status === 'failed')
  ) {
    return false;
  }
  if (filters.classification === 'failed' && bookmark.classification_status !== 'failed') return false;

  return true;
}

export function sortBookmarks(bookmarks: Bookmark[], sort: SortKey): Bookmark[] {
  const sorted = [...bookmarks];
  const time = (value: string | null): number => (value ? Date.parse(value) || 0 : 0);

  switch (sort) {
    case 'newest':
      return sorted.sort((a, b) => time(b.posted_at) - time(a.posted_at));
    case 'oldest':
      return sorted.sort((a, b) => time(a.posted_at) - time(b.posted_at));
    case 'recently-collected':
      return sorted.sort((a, b) => time(b.collected_at) - time(a.collected_at));
    case 'revisit':
      return sorted.sort((a, b) => (b.revisit_score ?? -1) - (a.revisit_score ?? -1));
    case 'likes':
      return sorted.sort((a, b) => (b.like_count ?? -1) - (a.like_count ?? -1));
    case 'author':
      return sorted.sort((a, b) =>
        (a.author_handle ?? '￿').localeCompare(b.author_handle ?? '￿'),
      );
    default:
      return sorted;
  }
}

export interface QueryInput {
  bookmarks: Bookmark[];
  index: SearchIndex;
  filters: LibraryFilters;
  sort: SortKey;
}

/** Full query pipeline: text match, then filters, then sort. */
export function queryLibrary({ bookmarks, index, filters, sort }: QueryInput): Bookmark[] {
  const textMatches = searchIndexFor(index, filters.query);
  const filtered = bookmarks.filter(
    (bookmark) =>
      (textMatches === null || textMatches.has(bookmark.post_id)) &&
      matchesFilters(bookmark, filters),
  );
  return sortBookmarks(filtered, sort);
}

/** Facet counts for the filter sidebar. */
export interface Facets {
  categories: Array<{ value: string; count: number }>;
  subcategories: Array<{ value: string; count: number }>;
  contentTypes: Array<{ value: string; count: number }>;
  tags: Array<{ value: string; count: number }>;
  authors: Array<{ value: string; count: number; name: string | null }>;
  domains: Array<{ value: string; count: number }>;
}

export function computeFacets(bookmarks: Bookmark[]): Facets {
  const categories = new Map<string, number>();
  const subcategories = new Map<string, number>();
  const contentTypes = new Map<string, number>();
  const tags = new Map<string, number>();
  const authors = new Map<string, { count: number; name: string | null }>();
  const domains = new Map<string, number>();

  const bump = (map: Map<string, number>, key: string | null): void => {
    if (!key) return;
    map.set(key, (map.get(key) ?? 0) + 1);
  };

  for (const bookmark of bookmarks) {
    bump(categories, bookmark.category);
    bump(subcategories, bookmark.subcategory);
    bump(contentTypes, bookmark.content_type);
    for (const tag of new Set([...bookmark.tags, ...bookmark.manual_tags])) bump(tags, tag);
    for (const domain of bookmarkDomains(bookmark)) bump(domains, domain);

    if (bookmark.author_handle) {
      const entry = authors.get(bookmark.author_handle) ?? { count: 0, name: bookmark.author_name };
      entry.count += 1;
      entry.name = entry.name ?? bookmark.author_name;
      authors.set(bookmark.author_handle, entry);
    }
  }

  const toSorted = (map: Map<string, number>): Array<{ value: string; count: number }> =>
    [...map.entries()]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));

  return {
    categories: toSorted(categories),
    subcategories: toSorted(subcategories),
    contentTypes: toSorted(contentTypes),
    tags: toSorted(tags).slice(0, 80),
    authors: [...authors.entries()]
      .map(([value, entry]) => ({ value, count: entry.count, name: entry.name }))
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value)),
    domains: toSorted(domains).slice(0, 60),
  };
}
