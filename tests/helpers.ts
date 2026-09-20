import type { Bookmark, BookmarkSource } from '../src/shared/types';
import { createEmptyBookmark } from '../src/database/schema';

export function makeSource(overrides: Partial<BookmarkSource> & { post_id: string }): BookmarkSource {
  return {
    post_url: `https://x.com/someone/status/${overrides.post_id}`,
    author_name: 'Some One',
    author_handle: 'someone',
    author_profile_url: 'https://x.com/someone',
    posted_at: '2026-01-01T00:00:00.000Z',
    text: 'hello world',
    external_urls: [],
    media_type: 'none',
    image_urls: [],
    video_available: false,
    media_thumbnail_urls: [],
    quoted_post_id: null,
    quoted_post_url: null,
    quoted_post_author: null,
    quoted_post_text: null,
    reply_to_post_id: null,
    reply_to_url: null,
    like_count: 1,
    reply_count: 0,
    repost_count: 0,
    view_count: 10,
    source: 'dom',
    ...overrides,
  };
}

export function makeBookmark(
  overrides: Partial<Bookmark> & { post_id: string },
  collectedAt = '2026-01-02T00:00:00.000Z',
): Bookmark {
  const { post_id, ...rest } = overrides;
  const base = createEmptyBookmark(makeSource({ post_id }), collectedAt);
  return { ...base, ...rest, post_id };
}
