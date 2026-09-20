import { beforeEach, describe, expect, it } from 'vitest';
import {
  countBookmarks,
  getAllBookmarks,
  getBookmark,
  getUnclassifiedIds,
  markMissingAsUnbookmarked,
  putBookmarks,
  resetDatabaseHandle,
  saveClassifications,
  updateManualFields,
  upsertBookmarks,
} from '../src/database/db';
import { DB_NAME, mergeBookmark, tokenize } from '../src/database/schema';
import { makeBookmark, makeSource } from './helpers';

async function freshDatabase(): Promise<void> {
  resetDatabaseHandle();
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => resolve();
  });
}

beforeEach(async () => {
  await freshDatabase();
});

describe('mergeBookmark', () => {
  it('creates a new record on first sight', () => {
    const result = mergeBookmark(undefined, makeSource({ post_id: '111111111111' }), '2026-02-01T00:00:00.000Z');
    expect(result.outcome).toBe('new');
    expect(result.record.collected_at).toBe('2026-02-01T00:00:00.000Z');
    expect(result.record.classification_status).toBe('unclassified');
    expect(result.record.is_currently_bookmarked).toBe(true);
    expect(result.record.search_tokens).toContain('hello');
  });

  it('reports "unchanged" when nothing moved', () => {
    const first = mergeBookmark(undefined, makeSource({ post_id: '111111111111' }), 'a');
    const second = mergeBookmark(first.record, makeSource({ post_id: '111111111111' }), 'b');
    expect(second.outcome).toBe('unchanged');
    expect(second.record).toBe(first.record);
  });

  it('updates changed metadata but keeps the original collected_at', () => {
    const first = mergeBookmark(
      undefined,
      makeSource({ post_id: '111111111111', like_count: 1 }),
      '2026-01-01T00:00:00.000Z',
    );
    const second = mergeBookmark(
      first.record,
      makeSource({ post_id: '111111111111', like_count: 99 }),
      '2026-03-01T00:00:00.000Z',
    );
    expect(second.outcome).toBe('updated');
    expect(second.record.like_count).toBe(99);
    expect(second.record.collected_at).toBe('2026-01-01T00:00:00.000Z');
    expect(second.record.updated_at).toBe('2026-03-01T00:00:00.000Z');
    expect(second.changedFields).toContain('like_count');
  });

  it('never lets a degraded extraction erase stored data', () => {
    const first = mergeBookmark(
      undefined,
      makeSource({ post_id: '111111111111', text: 'full text', image_urls: ['https://img/1'] }),
      'a',
    );
    const second = mergeBookmark(
      first.record,
      makeSource({ post_id: '111111111111', text: null, image_urls: [], author_name: null }),
      'b',
    );
    expect(second.record.text).toBe('full text');
    expect(second.record.image_urls).toEqual(['https://img/1']);
    expect(second.record.author_name).toBe('Some One');
  });

  it('leaves classification and user fields untouched', () => {
    const existing = makeBookmark({
      post_id: '111111111111',
      category: 'AI',
      classification_status: 'classified',
      favorite: true,
      personal_note: 'mine',
      manual_tags: ['keep'],
    });
    const merged = mergeBookmark(existing, makeSource({ post_id: '111111111111', like_count: 5 }), 'b');
    expect(merged.record.category).toBe('AI');
    expect(merged.record.classification_status).toBe('classified');
    expect(merged.record.favorite).toBe(true);
    expect(merged.record.personal_note).toBe('mine');
    expect(merged.record.manual_tags).toEqual(['keep']);
  });

  it('restores the bookmarked flag when a post is seen again', () => {
    const existing = makeBookmark({ post_id: '111111111111', is_currently_bookmarked: false });
    const merged = mergeBookmark(existing, makeSource({ post_id: '111111111111' }), 'b');
    expect(merged.record.is_currently_bookmarked).toBe(true);
    expect(merged.outcome).toBe('updated');
  });
});

describe('upsertBookmarks', () => {
  it('deduplicates by post_id across syncs', async () => {
    const source = makeSource({ post_id: '123456789012' });

    const first = await upsertBookmarks([source]);
    expect(first.newCount).toBe(1);

    const second = await upsertBookmarks([source]);
    expect(second.newCount).toBe(0);
    expect(second.unchangedCount).toBe(1);

    expect(await countBookmarks()).toBe(1);
  });

  it('collapses duplicates inside a single batch', async () => {
    const summary = await upsertBookmarks([
      makeSource({ post_id: '123456789012' }),
      makeSource({ post_id: '123456789012' }),
      makeSource({ post_id: '999999999999' }),
    ]);
    expect(summary.newCount).toBe(2);
    expect(await countBookmarks()).toBe(2);
  });

  it('records per-post outcomes in order, for the incremental heuristic', async () => {
    await upsertBookmarks([makeSource({ post_id: '111111111111' })]);
    const summary = await upsertBookmarks([
      makeSource({ post_id: '111111111111' }),
      makeSource({ post_id: '222222222222' }),
    ]);
    expect(summary.outcomes.map((o) => o.outcome)).toEqual(['unchanged', 'new']);
  });

  it('ignores records with an unusable post id', async () => {
    const summary = await upsertBookmarks([
      makeSource({ post_id: 'not-an-id' }),
      makeSource({ post_id: '123456789012' }),
    ]);
    expect(summary.newCount).toBe(1);
    expect(await countBookmarks()).toBe(1);
  });

  it('merges new metadata into an existing record', async () => {
    await upsertBookmarks([makeSource({ post_id: '123456789012', like_count: 3, text: 'v1' })]);
    const summary = await upsertBookmarks([
      makeSource({ post_id: '123456789012', like_count: 40, text: 'v2' }),
    ]);

    expect(summary.updatedCount).toBe(1);
    const stored = await getBookmark('123456789012');
    expect(stored?.like_count).toBe(40);
    expect(stored?.text).toBe('v2');
    expect(stored?.search_tokens).toContain('v2');
  });
});

describe('classification and manual fields', () => {
  it('stores a classification without touching user metadata', async () => {
    await upsertBookmarks([makeSource({ post_id: '123456789012' })]);
    await updateManualFields('123456789012', {
      favorite: true,
      personal_note: 'read later',
      manual_tags: ['mine'],
    });

    const saved = await saveClassifications(
      [
        {
          postId: '123456789012',
          category: 'AI',
          subcategory: 'Agents',
          tags: ['agentic-ai'],
          contentType: 'tool',
          actionable: true,
          revisitScore: 0.92,
          summary: 'A Mac assistant.',
          whySavedMightBeUseful: 'A tool or product to try out.',
        },
      ],
      'jev-latest/jev-questions-v1',
    );
    expect(saved).toBe(1);

    const stored = await getBookmark('123456789012');
    expect(stored?.category).toBe('AI');
    expect(stored?.revisit_score).toBe(0.92);
    expect(stored?.classification_status).toBe('classified');
    expect(stored?.classifier_version).toBe('jev-latest/jev-questions-v1');
    // User-owned fields survive classification.
    expect(stored?.favorite).toBe(true);
    expect(stored?.personal_note).toBe('read later');
    expect(stored?.manual_tags).toEqual(['mine']);
    // The category is searchable straight away.
    expect(stored?.search_tokens).toContain('agents');
  });

  it('lists unclassified and failed ids for the classification queue', async () => {
    await putBookmarks([
      makeBookmark({ post_id: '111111111111', classification_status: 'unclassified' }),
      makeBookmark({ post_id: '222222222222', classification_status: 'classified' }),
      makeBookmark({ post_id: '333333333333', classification_status: 'failed' }),
    ]);

    const withFailed = await getUnclassifiedIds(true);
    expect(withFailed.sort()).toEqual(['111111111111', '333333333333']);

    const withoutFailed = await getUnclassifiedIds(false);
    expect(withoutFailed).toEqual(['111111111111']);
  });
});

describe('markMissingAsUnbookmarked', () => {
  it('flags absent bookmarks instead of deleting them', async () => {
    await putBookmarks([
      makeBookmark({ post_id: '111111111111' }),
      makeBookmark({ post_id: '222222222222' }),
    ]);

    const marked = await markMissingAsUnbookmarked(new Set(['111111111111']));
    expect(marked).toBe(1);

    const all = await getAllBookmarks();
    expect(all).toHaveLength(2);
    expect(all.find((b) => b.post_id === '222222222222')?.is_currently_bookmarked).toBe(false);
    expect(all.find((b) => b.post_id === '111111111111')?.is_currently_bookmarked).toBe(true);
  });
});

describe('tokenize', () => {
  it('is unicode aware and drops noise', () => {
    expect(tokenize('Hello, WORLD! a 42')).toEqual(['hello', 'world', '42']);
    expect(tokenize('#AI agents')).toEqual(['ai', 'agents']);
    expect(tokenize(null)).toEqual([]);
  });
});
