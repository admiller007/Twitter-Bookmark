import { describe, expect, it } from 'vitest';
import {
  buildPostUrl,
  extractBookmarkFromArticle,
  extractPostId,
  extractVisibleBookmarks,
  parseCount,
  parseEngagementLabel,
  readTextContent,
  resolveExternalUrl,
} from '../src/x/extractor';
import {
  ALL_FIXTURES,
  EMOJI_LINK_IMAGE,
  LONG_POST,
  PLAIN_TEXT,
  QUOTE_POST,
  REPLY_POST,
  UNSUPPORTED,
  VIDEO_POST,
  timelineHtml,
  type Fixture,
} from './fixtures/x-posts';

function parse(html: string): Document {
  const doc = document.implementation.createHTMLDocument('test');
  doc.body.innerHTML = html;
  return doc;
}

function articleOf(fixture: Fixture): Element {
  const doc = parse(fixture.html);
  const article = doc.querySelector('article');
  if (!article) throw new Error('fixture has no article');
  return article;
}

describe('extractPostId', () => {
  it('extracts the id from canonical status URLs', () => {
    expect(extractPostId('https://x.com/username/status/123456789')).toBe('123456789');
    expect(extractPostId('https://twitter.com/username/status/123456789')).toBe('123456789');
    expect(extractPostId('http://www.x.com/username/status/123456789')).toBe('123456789');
  });

  it('handles paths, query strings, fragments and media suffixes', () => {
    expect(extractPostId('/coreyganim/status/1823456789012345678')).toBe('1823456789012345678');
    expect(extractPostId('https://x.com/a/status/1823456789012345678?s=20&t=abc')).toBe(
      '1823456789012345678',
    );
    expect(extractPostId('https://x.com/a/status/1823456789012345678/photo/1')).toBe(
      '1823456789012345678',
    );
    expect(extractPostId('https://x.com/a/status/1823456789012345678/video/2')).toBe(
      '1823456789012345678',
    );
    expect(extractPostId('/a/statuses/1823456789012345678')).toBe('1823456789012345678');
    expect(extractPostId('https://x.com/a/status/1823456789012345678#anchor')).toBe(
      '1823456789012345678',
    );
  });

  it('returns null rather than guessing', () => {
    expect(extractPostId(null)).toBeNull();
    expect(extractPostId(undefined)).toBeNull();
    expect(extractPostId('')).toBeNull();
    expect(extractPostId('https://x.com/coreyganim')).toBeNull();
    expect(extractPostId('https://x.com/i/bookmarks')).toBeNull();
    expect(extractPostId('https://example.com/user/status/123456789')).toBeNull();
    expect(extractPostId('https://x.com/a/status/123')).toBeNull(); // too short to be a real id
  });

  it('builds canonical post URLs', () => {
    expect(buildPostUrl('simonw', '123456789012')).toBe('https://x.com/simonw/status/123456789012');
    expect(buildPostUrl('@simonw', '123456789012')).toBe('https://x.com/simonw/status/123456789012');
    expect(buildPostUrl(null, '123456789012')).toBe('https://x.com/i/status/123456789012');
  });
});

describe('parseCount', () => {
  it('parses exact and compact forms', () => {
    expect(parseCount('45')).toBe(45);
    expect(parseCount('1,204')).toBe(1204);
    expect(parseCount('9.8K')).toBe(9800);
    expect(parseCount('1.2M')).toBe(1_200_000);
    expect(parseCount('3B')).toBe(3_000_000_000);
  });

  it('distinguishes missing from zero', () => {
    expect(parseCount(null)).toBeNull();
    expect(parseCount('')).toBeNull();
    expect(parseCount('Likes')).toBeNull();
    expect(parseCount('0')).toBe(0);
  });
});

describe('parseEngagementLabel', () => {
  it('reads the accessible action-bar summary', () => {
    expect(
      parseEngagementLabel('12 replies, 3 reposts, 45 likes, 6 bookmarks, 7890 views'),
    ).toEqual({ reply_count: 12, repost_count: 3, like_count: 45, view_count: 7890 });
  });

  it('handles compact numbers and missing metrics', () => {
    const result = parseEngagementLabel('240 replies, 1,102 reposts, 9.8K likes, 1.2M views');
    expect(result.like_count).toBe(9800);
    expect(result.view_count).toBe(1_200_000);
    expect(parseEngagementLabel(null).like_count).toBeNull();
  });
});

describe('readTextContent', () => {
  it('keeps emoji that X renders as images', () => {
    const doc = parse('<div><span>hi </span><img alt="🚀"><span> there</span></div>');
    expect(readTextContent(doc.querySelector('div'))).toBe('hi 🚀 there');
  });

  it('preserves line breaks from block wrappers', () => {
    const doc = parse('<div><div><span>one</span></div><div><span>two</span></div></div>');
    expect(readTextContent(doc.querySelector('div'))).toBe('one\ntwo');
  });
});

describe('resolveExternalUrl', () => {
  it('rebuilds a t.co link from its visible display URL', () => {
    const doc = parse('<a href="https://t.co/AbCdEf1234">github.com/simonw/llm</a>');
    expect(resolveExternalUrl(doc.querySelector('a') as Element)).toBe(
      'https://github.com/simonw/llm',
    );
  });

  it('reduces a truncated display URL to its origin instead of inventing a path', () => {
    const doc = parse('<a href="https://t.co/AbCdEf1234">github.com/simonw/very-long-re…</a>');
    expect(resolveExternalUrl(doc.querySelector('a') as Element)).toBe('https://github.com');
  });

  it('ignores internal X links', () => {
    const doc = parse('<a href="/simonw/status/123456789012">Sep 1</a>');
    expect(resolveExternalUrl(doc.querySelector('a') as Element)).toBeNull();
  });

  it('passes through direct external links unchanged', () => {
    const doc = parse('<a href="https://example.com/page?x=1">example</a>');
    expect(resolveExternalUrl(doc.querySelector('a') as Element)).toBe('https://example.com/page?x=1');
  });
});

describe('extractBookmarkFromArticle', () => {
  it('extracts a plain text post', () => {
    const bookmark = extractBookmarkFromArticle(articleOf(PLAIN_TEXT));
    expect(bookmark).not.toBeNull();
    expect(bookmark?.post_id).toBe(PLAIN_TEXT.postId);
    expect(bookmark?.post_url).toBe(`https://x.com/coreyganim/status/${PLAIN_TEXT.postId}`);
    expect(bookmark?.author_name).toBe('Corey Ganim');
    expect(bookmark?.author_handle).toBe('coreyganim');
    expect(bookmark?.author_profile_url).toBe('https://x.com/coreyganim');
    expect(bookmark?.posted_at).toBe('2026-08-14T15:04:05.000Z');
    expect(bookmark?.text).toContain('second pair of eyes');
    expect(bookmark?.media_type).toBe('none');
    expect(bookmark?.like_count).toBe(45);
    expect(bookmark?.reply_count).toBe(12);
    expect(bookmark?.repost_count).toBe(3);
    expect(bookmark?.view_count).toBe(7890);
    expect(bookmark?.quoted_post_id).toBeNull();
  });

  it('extracts emoji, external links and images', () => {
    const bookmark = extractBookmarkFromArticle(articleOf(EMOJI_LINK_IMAGE));
    expect(bookmark?.text).toContain('🚀');
    expect(bookmark?.text).toContain('😅');
    expect(bookmark?.external_urls).toEqual(['https://github.com/simonw/llm']);
    expect(bookmark?.media_type).toBe('image');
    expect(bookmark?.image_urls).toHaveLength(1);
    expect(bookmark?.image_urls[0]).toContain('pbs.twimg.com/media/');
    expect(bookmark?.like_count).toBe(3204);
    expect(bookmark?.view_count).toBe(251003);
  });

  it('never treats the avatar as post media', () => {
    const bookmark = extractBookmarkFromArticle(articleOf(EMOJI_LINK_IMAGE));
    expect(bookmark?.image_urls.some((url) => url.includes('profile_images'))).toBe(false);
  });

  it('extracts a quoted post without mixing it into the main post', () => {
    const bookmark = extractBookmarkFromArticle(articleOf(QUOTE_POST));
    expect(bookmark?.post_id).toBe(QUOTE_POST.postId);
    expect(bookmark?.author_handle).toBe('karpathy');
    expect(bookmark?.text).toBe('This is the right framing.');
    expect(bookmark?.quoted_post_id).toBe('1900000000000000001');
    expect(bookmark?.quoted_post_author).toBe('ylecun');
    expect(bookmark?.quoted_post_text).toBe('Scaling alone will not get us there.');
    expect(bookmark?.quoted_post_url).toBe('https://x.com/ylecun/status/1900000000000000001');
    // The quoted post's image belongs to the quote, not to this bookmark.
    expect(bookmark?.image_urls).toHaveLength(0);
  });

  it('extracts a reply and leaves the unknown parent id null', () => {
    const bookmark = extractBookmarkFromArticle(articleOf(REPLY_POST));
    expect(bookmark?.post_id).toBe(REPLY_POST.postId);
    expect(bookmark?.text).toContain('Boring infrastructure');
    expect(bookmark?.reply_to_post_id).toBeNull();
  });

  it('detects video posts with no caption', () => {
    const bookmark = extractBookmarkFromArticle(articleOf(VIDEO_POST));
    expect(bookmark?.video_available).toBe(true);
    expect(bookmark?.media_type).toBe('video');
    expect(bookmark?.media_thumbnail_urls[0]).toContain('ext_tw_video_thumb');
    expect(bookmark?.text).toBeNull();
  });

  it('keeps the whole body of a long multi-paragraph post', () => {
    const bookmark = extractBookmarkFromArticle(articleOf(LONG_POST));
    expect(bookmark?.text).toContain('Ship before it is ready');
    expect(bookmark?.text).toContain('first 100 customers');
    expect(bookmark?.text?.split('\n').length).toBeGreaterThan(1);
  });

  it('returns null for markup with no usable post id', () => {
    expect(extractBookmarkFromArticle(articleOf(UNSUPPORTED))).toBeNull();
  });
});

describe('extractVisibleBookmarks', () => {
  it('extracts every post in a timeline and skips unusable ones', () => {
    const doc = parse(timelineHtml([...ALL_FIXTURES, UNSUPPORTED]));
    const bookmarks = extractVisibleBookmarks(doc);
    expect(bookmarks).toHaveLength(ALL_FIXTURES.length);
    expect(bookmarks.map((b) => b.post_id).sort()).toEqual(
      ALL_FIXTURES.map((f) => f.postId).sort(),
    );
  });

  it('deduplicates a post that X rendered more than once', () => {
    const doc = parse(timelineHtml([PLAIN_TEXT, PLAIN_TEXT, EMOJI_LINK_IMAGE]));
    const bookmarks = extractVisibleBookmarks(doc);
    expect(bookmarks).toHaveLength(2);
  });
});
