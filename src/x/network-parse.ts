/**
 * Optional enhancement: parse tweet records out of X's own API responses.
 *
 * This is deliberately *shape-based*, not endpoint-based. It walks any JSON
 * body the page already fetched and picks out objects that look like a tweet
 * result (a numeric rest_id next to a legacy block). No GraphQL operation name
 * or query id is hardcoded anywhere, so a routine endpoint rename cannot break
 * it - and if the shape changes entirely, the DOM extractor still carries the
 * whole sync on its own.
 */

import type { BookmarkSource, MediaType } from '../shared/types';
import { buildPostUrl } from './extractor';

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number.parseInt(value, 10);
  return null;
}

function at(root: unknown, path: string): unknown {
  let current: unknown = root;
  for (const key of path.split('.')) {
    if (!isObject(current)) return undefined;
    current = current[key];
  }
  return current;
}

/** First non-null result of the given paths. */
function firstString(root: unknown, paths: string[]): string | null {
  for (const path of paths) {
    const value = str(at(root, path));
    if (value) return value;
  }
  return null;
}

function toIso(twitterDate: unknown): string | null {
  const raw = str(twitterDate);
  if (!raw) return null;
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

/** A tweet-result node: rest_id plus a legacy payload. */
function isTweetNode(value: unknown): value is Json {
  if (!isObject(value)) return false;
  const restId = str(value['rest_id']);
  if (!restId || !/^\d{6,25}$/.test(restId)) return false;
  const legacy = value['legacy'];
  return isObject(legacy) && ('full_text' in legacy || 'created_at' in legacy);
}

function readHandle(node: Json): string | null {
  return firstString(node, [
    'core.user_results.result.core.screen_name',
    'core.user_results.result.legacy.screen_name',
    'author.screen_name',
    'legacy.user.screen_name',
  ]);
}

function readName(node: Json): string | null {
  return firstString(node, [
    'core.user_results.result.core.name',
    'core.user_results.result.legacy.name',
    'legacy.user.name',
  ]);
}

function readText(node: Json): string | null {
  // Long posts carry their full body in note_tweet; legacy.full_text is
  // truncated for those, so the note version wins when present.
  return (
    firstString(node, [
      'note_tweet.note_tweet_results.result.text',
      'legacy.full_text',
      'legacy.text',
    ]) ?? null
  );
}

function readMedia(node: Json): {
  media_type: MediaType;
  image_urls: string[];
  video_available: boolean;
  media_thumbnail_urls: string[];
} {
  const entities =
    (at(node, 'legacy.extended_entities.media') as unknown[] | undefined) ??
    (at(node, 'legacy.entities.media') as unknown[] | undefined) ??
    [];

  const images: string[] = [];
  const thumbs: string[] = [];
  let hasVideo = false;
  let hasGif = false;

  for (const item of entities) {
    if (!isObject(item)) continue;
    const type = str(item['type']);
    const url = str(item['media_url_https']);
    if (type === 'photo') {
      if (url && !images.includes(url)) images.push(url);
      if (url && !thumbs.includes(url)) thumbs.push(url);
    } else if (type === 'video' || type === 'animated_gif') {
      if (type === 'video') hasVideo = true;
      else hasGif = true;
      if (url && !thumbs.includes(url)) thumbs.push(url);
    }
  }

  let mediaType: MediaType = 'none';
  if (hasGif && !hasVideo && images.length === 0) mediaType = 'gif';
  else if (hasVideo && images.length > 0) mediaType = 'mixed';
  else if (hasVideo) mediaType = 'video';
  else if (images.length > 0) mediaType = 'image';

  return {
    media_type: mediaType,
    image_urls: images,
    video_available: hasVideo,
    media_thumbnail_urls: thumbs,
  };
}

function readExternalUrls(node: Json): string[] {
  const out: string[] = [];
  const sources = [
    at(node, 'legacy.entities.urls'),
    at(node, 'note_tweet.note_tweet_results.result.entity_set.urls'),
  ];
  for (const list of sources) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (!isObject(item)) continue;
      const expanded = str(item['expanded_url']) ?? str(item['url']);
      if (!expanded) continue;
      if (/^https?:\/\/(www\.)?(x|twitter)\.com\//i.test(expanded)) continue;
      if (!out.includes(expanded)) out.push(expanded);
    }
  }
  return out;
}

/** Converts one tweet-result node into a BookmarkSource. */
export function tweetNodeToBookmark(node: Json): BookmarkSource | null {
  const postId = str(node['rest_id']);
  if (!postId || !/^\d{6,25}$/.test(postId)) return null;

  const handle = readHandle(node);
  const media = readMedia(node);

  const quoted = at(node, 'quoted_status_result.result');
  const quotedNode = isTweetNode(quoted) ? (quoted as Json) : null;
  const quotedId =
    (quotedNode ? str(quotedNode['rest_id']) : null) ??
    str(at(node, 'legacy.quoted_status_id_str'));
  const quotedHandle = quotedNode ? readHandle(quotedNode) : null;

  const replyId = str(at(node, 'legacy.in_reply_to_status_id_str'));
  const replyHandle = str(at(node, 'legacy.in_reply_to_screen_name'));

  return {
    post_id: postId,
    post_url: buildPostUrl(handle, postId),
    author_name: readName(node),
    author_handle: handle,
    author_profile_url: handle ? `https://x.com/${handle}` : null,
    posted_at: toIso(at(node, 'legacy.created_at')),
    text: readText(node),
    external_urls: readExternalUrls(node),
    media_type: media.media_type,
    image_urls: media.image_urls,
    video_available: media.video_available,
    media_thumbnail_urls: media.media_thumbnail_urls,
    quoted_post_id: quotedId,
    quoted_post_url: quotedId ? buildPostUrl(quotedHandle, quotedId) : null,
    quoted_post_author: quotedHandle,
    quoted_post_text: quotedNode ? readText(quotedNode) : null,
    reply_to_post_id: replyId,
    reply_to_url: replyId ? buildPostUrl(replyHandle, replyId) : null,
    like_count: num(at(node, 'legacy.favorite_count')),
    reply_count: num(at(node, 'legacy.reply_count')),
    repost_count: num(at(node, 'legacy.retweet_count')),
    view_count: num(at(node, 'views.count')) ?? num(at(node, 'legacy.ext_views.count')),
    source: 'network',
  };
}

/**
 * Deep-walks an arbitrary JSON body and returns every tweet it contains.
 * Depth and node budgets keep a hostile or huge payload from stalling the tab.
 */
export function collectTweetsFromJson(root: unknown, maxNodes = 40_000): BookmarkSource[] {
  const found = new Map<string, BookmarkSource>();
  const stack: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
  let visited = 0;

  while (stack.length > 0) {
    const entry = stack.pop();
    if (!entry) break;
    const { value, depth } = entry;
    if (depth > 40) continue;
    if (++visited > maxNodes) break;

    if (Array.isArray(value)) {
      for (const item of value) stack.push({ value: item, depth: depth + 1 });
      continue;
    }
    if (!isObject(value)) continue;

    if (isTweetNode(value)) {
      const bookmark = tweetNodeToBookmark(value);
      if (bookmark && !found.has(bookmark.post_id)) found.set(bookmark.post_id, bookmark);
      // Keep descending: quoted posts and retweets nest further tweet nodes.
    }

    for (const child of Object.values(value)) {
      if (typeof child === 'object' && child !== null) {
        stack.push({ value: child, depth: depth + 1 });
      }
    }
  }

  return [...found.values()];
}
