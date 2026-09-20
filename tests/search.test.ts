import { describe, expect, it } from 'vitest';
import {
  EMPTY_FILTERS,
  buildSearchIndex,
  computeFacets,
  matchesFilters,
  queryLibrary,
  searchIndexFor,
  sortBookmarks,
} from '../src/database/search';
import { buildSearchTokens } from '../src/database/schema';
import { makeBookmark } from './helpers';

const library = [
  makeBookmark({
    post_id: '111111111111',
    text: 'An agentic Mac assistant that picks the next click',
    author_handle: 'coreyganim',
    author_name: 'Corey Ganim',
    category: 'AI',
    subcategory: 'AI Agents',
    tags: ['agentic-ai', 'mac'],
    content_type: 'tool',
    actionable: true,
    revisit_score: 0.92,
    summary: 'A Mac assistant',
    classification_status: 'classified',
    image_urls: ['https://pbs.twimg.com/media/a'],
    external_urls: ['https://github.com/example/tool'],
    posted_at: '2026-08-01T00:00:00.000Z',
  }),
  makeBookmark({
    post_id: '222222222222',
    text: 'Deep dish pizza in Chicago, ranked',
    author_handle: 'foodie',
    category: 'Chicago',
    subcategory: 'Restaurants',
    tags: ['food'],
    content_type: 'article',
    actionable: false,
    revisit_score: 0.4,
    classification_status: 'classified',
    video_available: true,
    posted_at: '2026-01-01T00:00:00.000Z',
  }),
  makeBookmark({
    post_id: '333333333333',
    text: 'Nothing classified here yet',
    author_handle: 'random',
    classification_status: 'unclassified',
    posted_at: '2026-04-01T00:00:00.000Z',
  }),
].map((bookmark) => ({ ...bookmark, search_tokens: buildSearchTokens(bookmark) }));

const index = buildSearchIndex(library);

describe('searchIndexFor', () => {
  it('returns null for an empty query so no text constraint applies', () => {
    expect(searchIndexFor(index, '')).toBeNull();
    expect(searchIndexFor(index, '   ')).toBeNull();
  });

  it('finds exact word matches', () => {
    expect([...(searchIndexFor(index, 'pizza') ?? [])]).toEqual(['222222222222']);
  });

  it('treats the final term as a prefix so results narrow while typing', () => {
    expect([...(searchIndexFor(index, 'assis') ?? [])]).toEqual(['111111111111']);
  });

  it('ANDs multiple terms', () => {
    expect([...(searchIndexFor(index, 'mac assistant') ?? [])]).toEqual(['111111111111']);
    expect([...(searchIndexFor(index, 'pizza assistant') ?? [])]).toEqual([]);
  });

  it('searches author, category, tags and summary as well as post text', () => {
    expect([...(searchIndexFor(index, 'coreyganim') ?? [])]).toEqual(['111111111111']);
    expect([...(searchIndexFor(index, 'restaurants') ?? [])]).toEqual(['222222222222']);
    expect([...(searchIndexFor(index, 'agentic-ai') ?? [])]).toContain('111111111111');
    expect([...(searchIndexFor(index, 'github') ?? [])]).toEqual(['111111111111']);
  });

  it('is case insensitive', () => {
    expect([...(searchIndexFor(index, 'CHICAGO') ?? [])]).toEqual(['222222222222']);
  });
});

describe('matchesFilters', () => {
  const first = library[0]!;

  it('filters by category and content type', () => {
    expect(matchesFilters(first, { ...EMPTY_FILTERS, categories: ['AI'] })).toBe(true);
    expect(matchesFilters(first, { ...EMPTY_FILTERS, categories: ['Chicago'] })).toBe(false);
    expect(matchesFilters(first, { ...EMPTY_FILTERS, contentTypes: ['tool'] })).toBe(true);
  });

  it('requires every selected tag', () => {
    expect(matchesFilters(first, { ...EMPTY_FILTERS, tags: ['mac'] })).toBe(true);
    expect(matchesFilters(first, { ...EMPTY_FILTERS, tags: ['mac', 'food'] })).toBe(false);
  });

  it('filters by media, links and actionability', () => {
    expect(matchesFilters(first, { ...EMPTY_FILTERS, hasImages: true })).toBe(true);
    expect(matchesFilters(first, { ...EMPTY_FILTERS, hasVideo: true })).toBe(false);
    expect(matchesFilters(first, { ...EMPTY_FILTERS, hasExternalLink: true })).toBe(true);
    expect(matchesFilters(first, { ...EMPTY_FILTERS, actionable: 'yes' })).toBe(true);
    expect(matchesFilters(first, { ...EMPTY_FILTERS, actionable: 'no' })).toBe(false);
  });

  it('filters by minimum revisit score', () => {
    expect(matchesFilters(first, { ...EMPTY_FILTERS, minRevisit: 0.9 })).toBe(true);
    expect(matchesFilters(library[1]!, { ...EMPTY_FILTERS, minRevisit: 0.9 })).toBe(false);
    // An unscored bookmark is excluded once a threshold is set.
    expect(matchesFilters(library[2]!, { ...EMPTY_FILTERS, minRevisit: 0.1 })).toBe(false);
  });

  it('filters by classification state', () => {
    expect(matchesFilters(first, { ...EMPTY_FILTERS, classification: 'classified' })).toBe(true);
    expect(matchesFilters(library[2]!, { ...EMPTY_FILTERS, classification: 'unclassified' })).toBe(true);
    expect(matchesFilters(first, { ...EMPTY_FILTERS, classification: 'unclassified' })).toBe(false);
  });

  it('filters by link domain', () => {
    expect(matchesFilters(first, { ...EMPTY_FILTERS, domains: ['github.com'] })).toBe(true);
    expect(matchesFilters(first, { ...EMPTY_FILTERS, domains: ['example.org'] })).toBe(false);
  });

  it('can hide bookmarks no longer on X', () => {
    const removed = makeBookmark({ post_id: '444444444444', is_currently_bookmarked: false });
    expect(matchesFilters(removed, { ...EMPTY_FILTERS, includeUnbookmarked: false })).toBe(false);
    expect(matchesFilters(removed, { ...EMPTY_FILTERS, includeUnbookmarked: true })).toBe(true);
  });
});

describe('sortBookmarks', () => {
  it('sorts by post date in both directions', () => {
    expect(sortBookmarks(library, 'newest').map((b) => b.post_id)).toEqual([
      '111111111111',
      '333333333333',
      '222222222222',
    ]);
    expect(sortBookmarks(library, 'oldest')[0]?.post_id).toBe('222222222222');
  });

  it('sorts by revisit score, putting unscored last', () => {
    expect(sortBookmarks(library, 'revisit').map((b) => b.post_id)).toEqual([
      '111111111111',
      '222222222222',
      '333333333333',
    ]);
  });

  it('sorts by author handle', () => {
    expect(sortBookmarks(library, 'author')[0]?.author_handle).toBe('coreyganim');
  });
});

describe('queryLibrary', () => {
  it('combines search, filters and sorting', () => {
    const results = queryLibrary({
      bookmarks: library,
      index,
      filters: { ...EMPTY_FILTERS, query: 'a', categories: ['AI'] },
      sort: 'newest',
    });
    expect(results.map((b) => b.post_id)).toEqual(['111111111111']);
  });

  it('returns everything when nothing is constrained', () => {
    expect(
      queryLibrary({ bookmarks: library, index, filters: EMPTY_FILTERS, sort: 'newest' }),
    ).toHaveLength(3);
  });
});

describe('computeFacets', () => {
  it('counts categories, tags, authors and domains', () => {
    const facets = computeFacets(library);
    expect(facets.categories).toEqual([
      { value: 'AI', count: 1 },
      { value: 'Chicago', count: 1 },
    ]);
    expect(facets.authors.map((a) => a.value).sort()).toEqual(['coreyganim', 'foodie', 'random']);
    expect(facets.domains).toEqual([{ value: 'github.com', count: 1 }]);
    expect(facets.tags.map((t) => t.value).sort()).toEqual(['agentic-ai', 'food', 'mac']);
  });
});
