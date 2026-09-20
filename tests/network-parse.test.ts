import { describe, expect, it } from 'vitest';
import { collectTweetsFromJson, tweetNodeToBookmark } from '../src/x/network-parse';

/** A response shaped like X's timeline payloads, with no operation name. */
const GRAPHQL_RESPONSE = {
  data: {
    bookmark_timeline_v2: {
      timeline: {
        instructions: [
          {
            type: 'TimelineAddEntries',
            entries: [
              {
                entryId: 'tweet-1955555555555555555',
                content: {
                  itemContent: {
                    tweet_results: {
                      result: {
                        __typename: 'Tweet',
                        rest_id: '1955555555555555555',
                        core: {
                          user_results: {
                            result: { core: { screen_name: 'simonw', name: 'Simon Willison' } },
                          },
                        },
                        legacy: {
                          created_at: 'Tue Sep 01 09:12:00 +0000 2026',
                          full_text: 'Shipped a tiny CLI https://t.co/AbCdEf1234',
                          favorite_count: 3204,
                          reply_count: 88,
                          retweet_count: 412,
                          in_reply_to_status_id_str: '1900000000000000009',
                          in_reply_to_screen_name: 'someone',
                          entities: {
                            urls: [
                              {
                                url: 'https://t.co/AbCdEf1234',
                                expanded_url: 'https://github.com/simonw/llm/releases/tag/0.20',
                              },
                            ],
                          },
                          extended_entities: {
                            media: [
                              {
                                type: 'photo',
                                media_url_https: 'https://pbs.twimg.com/media/PHOTO.jpg',
                              },
                            ],
                          },
                        },
                        views: { count: '251003' },
                        quoted_status_result: {
                          result: {
                            rest_id: '1900000000000000001',
                            core: { user_results: { result: { core: { screen_name: 'ylecun' } } } },
                            legacy: {
                              created_at: 'Tue Jul 22 10:00:00 +0000 2026',
                              full_text: 'Scaling alone will not get us there.',
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            ],
          },
        ],
      },
    },
  },
};

describe('collectTweetsFromJson', () => {
  it('finds tweets by shape, with no endpoint or operation name hardcoded', () => {
    const bookmarks = collectTweetsFromJson(GRAPHQL_RESPONSE);
    const ids = bookmarks.map((b) => b.post_id).sort();
    expect(ids).toEqual(['1900000000000000001', '1955555555555555555']);
  });

  it('extracts the full expanded URL that the DOM only shows shortened', () => {
    const [bookmark] = collectTweetsFromJson(GRAPHQL_RESPONSE).filter(
      (b) => b.post_id === '1955555555555555555',
    );
    expect(bookmark?.external_urls).toEqual([
      'https://github.com/simonw/llm/releases/tag/0.20',
    ]);
  });

  it('recovers the reply parent id, which the bookmarks DOM does not expose', () => {
    const [bookmark] = collectTweetsFromJson(GRAPHQL_RESPONSE).filter(
      (b) => b.post_id === '1955555555555555555',
    );
    expect(bookmark?.reply_to_post_id).toBe('1900000000000000009');
    expect(bookmark?.reply_to_url).toBe('https://x.com/someone/status/1900000000000000009');
  });

  it('reads author, dates, media, counts and the quoted post', () => {
    const [bookmark] = collectTweetsFromJson(GRAPHQL_RESPONSE).filter(
      (b) => b.post_id === '1955555555555555555',
    );
    expect(bookmark?.author_handle).toBe('simonw');
    expect(bookmark?.author_name).toBe('Simon Willison');
    expect(bookmark?.posted_at).toBe('2026-09-01T09:12:00.000Z');
    expect(bookmark?.media_type).toBe('image');
    expect(bookmark?.like_count).toBe(3204);
    expect(bookmark?.view_count).toBe(251003);
    expect(bookmark?.quoted_post_id).toBe('1900000000000000001');
    expect(bookmark?.quoted_post_author).toBe('ylecun');
    expect(bookmark?.quoted_post_text).toBe('Scaling alone will not get us there.');
    expect(bookmark?.source).toBe('network');
  });

  it('prefers the note_tweet body for long posts', () => {
    const bookmarks = collectTweetsFromJson({
      rest_id: '1966666666666666666',
      legacy: { full_text: 'truncated…', created_at: 'Tue Sep 01 09:12:00 +0000 2026' },
      note_tweet: { note_tweet_results: { result: { text: 'the complete long body' } } },
    });
    expect(bookmarks[0]?.text).toBe('the complete long body');
  });

  it('returns nothing for unrelated JSON instead of throwing', () => {
    expect(collectTweetsFromJson({ hello: 'world' })).toEqual([]);
    expect(collectTweetsFromJson(null)).toEqual([]);
    expect(collectTweetsFromJson([1, 2, 3])).toEqual([]);
  });

  it('ignores nodes whose rest_id is not a post id', () => {
    expect(
      collectTweetsFromJson({ rest_id: 'abc', legacy: { full_text: 'x', created_at: 'y' } }),
    ).toEqual([]);
  });

  it('survives deeply nested and cyclic-looking structures', () => {
    let nested: Record<string, unknown> = { rest_id: '1977777777777777777', legacy: { full_text: 'deep', created_at: 'Tue Sep 01 09:12:00 +0000 2026' } };
    for (let i = 0; i < 60; i += 1) nested = { level: nested };
    // Beyond the depth budget nothing is returned, and nothing hangs.
    expect(() => collectTweetsFromJson(nested)).not.toThrow();
  });
});

describe('tweetNodeToBookmark', () => {
  it('marks video posts and keeps the thumbnail', () => {
    const bookmark = tweetNodeToBookmark({
      rest_id: '1988888888888888888',
      legacy: {
        created_at: 'Tue May 19 08:00:00 +0000 2026',
        full_text: '',
        extended_entities: {
          media: [
            { type: 'video', media_url_https: 'https://pbs.twimg.com/ext_tw_video_thumb/T.jpg' },
          ],
        },
      },
    });
    expect(bookmark?.video_available).toBe(true);
    expect(bookmark?.media_type).toBe('video');
    expect(bookmark?.media_thumbnail_urls).toEqual([
      'https://pbs.twimg.com/ext_tw_video_thumb/T.jpg',
    ]);
  });

  it('does not treat an X permalink as an external link', () => {
    const bookmark = tweetNodeToBookmark({
      rest_id: '1999999999999999999',
      legacy: {
        created_at: 'Tue May 19 08:00:00 +0000 2026',
        full_text: 'see this',
        entities: { urls: [{ expanded_url: 'https://x.com/a/status/123' }] },
      },
    });
    expect(bookmark?.external_urls).toEqual([]);
  });
});
