/**
 * X/Twitter DOM adapter.
 *
 * Everything that knows about X's markup lives here. X changes its frontend
 * frequently, so this module deliberately leans on the most durable signals
 * available - status URLs, <time datetime>, data-testid hooks and accessible
 * labels - and never on generated CSS class names.
 *
 * Every function is pure and takes an Element, so the whole adapter is
 * testable against captured HTML fixtures without a browser.
 */

import type { BookmarkSource, MediaType } from '../shared/types';
import type { PageHealth } from './types';

/** Hosts that are X itself rather than an outbound link. */
const X_HOSTS = new Set(['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com']);
const SHORTENER_HOSTS = new Set(['t.co']);

const STATUS_PATH = /\/status(?:es)?\/(\d{6,25})/;

/**
 * Extracts the canonical X post id from any status URL or path.
 *
 * Accepts absolute URLs, protocol-relative URLs and bare paths, tolerates
 * query strings, trailing slashes, and the /photo/1 and /video/1 suffixes.
 * Returns null for anything that is not a status URL - never a guess.
 */
export function extractPostId(url: string | null | undefined): string | null {
  if (!url) return null;
  const trimmed = String(url).trim();
  if (!trimmed) return null;

  // Strip the query and fragment before matching so ?s=20 cannot interfere.
  const withoutQuery = trimmed.split('#')[0]?.split('?')[0] ?? '';
  const match = STATUS_PATH.exec(withoutQuery);
  if (!match || !match[1]) return null;

  // Reject host-less look-alikes such as "/i/status/123" only when the URL
  // carries a host that is not X.
  const host = hostOf(trimmed);
  if (host && !X_HOSTS.has(host)) return null;

  return match[1];
}

/** Builds the canonical post URL used as post_url. */
export function buildPostUrl(handle: string | null, postId: string): string {
  const user = handle?.replace(/^@/, '') || 'i';
  return `https://x.com/${user}/status/${postId}`;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url, 'https://x.com').hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Absolute form of an href that may be site-relative. */
function absolute(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url, 'https://x.com').toString();
  } catch {
    return null;
  }
}

/**
 * Parses engagement counts as X renders them.
 *
 * Handles exact aria-label numbers ("1,234"), compact display forms ("1.2K",
 * "3M") and returns null rather than 0 when the value is absent, so a missing
 * count is never mistaken for a real zero.
 */
export function parseCount(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim();
  if (!text) return null;

  const match = /^([\d., \s]+)\s*([KMB])?$/i.exec(text);
  if (!match || !match[1]) return null;

  const digits = match[1].replace(/[, \s]/g, '');
  if (!digits || !/^\d*\.?\d+$/.test(digits)) return null;

  const value = Number.parseFloat(digits);
  if (Number.isNaN(value)) return null;

  const suffix = match[2]?.toUpperCase();
  const multiplier = suffix === 'K' ? 1e3 : suffix === 'M' ? 1e6 : suffix === 'B' ? 1e9 : 1;
  return Math.round(value * multiplier);
}

/**
 * Reads the action-bar aria-label, which X renders as a single accessible
 * summary, e.g. "12 replies, 3 reposts, 45 likes, 6 bookmarks, 7890 views".
 */
export function parseEngagementLabel(label: string | null | undefined): {
  reply_count: number | null;
  repost_count: number | null;
  like_count: number | null;
  view_count: number | null;
} {
  const result = {
    reply_count: null as number | null,
    repost_count: null as number | null,
    like_count: null as number | null,
    view_count: null as number | null,
  };
  if (!label) return result;

  // The label is scanned as a whole rather than split on commas, because the
  // numbers themselves contain thousands separators ("3,204 likes").
  const pattern =
    /(\d[\d.,\u00a0\s]*[KMB]?)\s+(replies|reply|reposts|repost|retweets|retweet|likes|like|views|view)\b/gi;

  for (const match of String(label).matchAll(pattern)) {
    const value = parseCount(match[1]);
    if (value === null) continue;
    const noun = (match[2] ?? '').toLowerCase();
    if (noun.startsWith('repl')) result.reply_count = value;
    else if (noun.startsWith('repost') || noun.startsWith('retweet')) result.repost_count = value;
    else if (noun.startsWith('like')) result.like_count = value;
    else if (noun.startsWith('view')) result.view_count = value;
  }
  return result;
}

/**
 * Reconstructs post text from X's rich markup.
 *
 * Emoji are rendered as <img alt="\u{1F600}">, so the alt text is used to keep
 * them. Line breaks come from <br> and from X's per-line <div> wrappers.
 */
export function readTextContent(node: Element | null): string | null {
  if (!node) return null;

  const parts: string[] = [];
  const walk = (current: Node): void => {
    if (current.nodeType === 3 /* text */) {
      parts.push(current.nodeValue ?? '');
      return;
    }
    if (current.nodeType !== 1 /* element */) return;

    const element = current as Element;
    const tag = element.tagName.toLowerCase();

    if (tag === 'img') {
      parts.push(element.getAttribute('alt') ?? '');
      return;
    }
    if (tag === 'br') {
      parts.push('\n');
      return;
    }

    for (const child of Array.from(element.childNodes)) walk(child);

    // X wraps each visual line in its own block element.
    if (tag === 'div' || tag === 'p') parts.push('\n');
  };

  walk(node);

  const text = parts
    .join('')
    .replace(/ /g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return text.length > 0 ? text : null;
}

/**
 * Resolves an outbound link.
 *
 * X routes external links through t.co, whose target is opaque in the DOM. When
 * that happens the anchor's visible text carries the display URL, so we rebuild
 * from it. Truncated display text ("github.com/some/very-lon…") is reduced to
 * its origin rather than guessing the rest of the path.
 */
export function resolveExternalUrl(anchor: Element): string | null {
  const href = absolute(anchor.getAttribute('href'));
  if (!href) return null;

  const host = hostOf(href);
  if (!host) return null;
  if (X_HOSTS.has(host)) return null;

  if (!SHORTENER_HOSTS.has(host)) return href;

  const display = (anchor.textContent ?? '').trim().replace(/^https?:\/\//i, '');
  if (!display) return href;

  const truncated = /[…]/.test(display);
  const cleaned = display.replace(/[…]+/g, '');
  const candidateHost = cleaned.split('/')[0] ?? '';
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(candidateHost)) return href;

  // A complete display URL can be used as-is; a truncated one only down to its
  // origin, so we never invent a path that was never shown.
  return truncated ? `https://${candidateHost}` : `https://${cleaned}`;
}

/** The article element for a bookmark, or null when the node is not one. */
export function findArticles(root: ParentNode): HTMLElement[] {
  const primary = root.querySelector?.('[data-testid="primaryColumn"]') ?? null;
  const scope: ParentNode = primary ?? root;
  const articles = scope.querySelectorAll('article');
  return Array.from(articles) as HTMLElement[];
}

/** The nested quote-tweet container, if the post quotes another post. */
function findQuoteContainer(article: Element): Element | null {
  const candidates = Array.from(article.querySelectorAll('div[role="link"]'));
  for (const candidate of candidates) {
    // Link cards for external URLs also use role="link"; a quote always embeds
    // another user name block or its own timestamp.
    const isCard = candidate.closest('[data-testid="card.wrapper"]') !== null;
    if (isCard) continue;
    if (candidate.querySelector('[data-testid="User-Name"], time')) return candidate;
  }
  return null;
}

/** True when the node sits inside the quoted post rather than the main post. */
function insideQuote(node: Element, quote: Element | null): boolean {
  return quote !== null && quote.contains(node);
}

function readHandle(scope: Element | null): string | null {
  if (!scope) return null;
  const spans = Array.from(scope.querySelectorAll('span'));
  for (const span of spans) {
    const text = (span.textContent ?? '').trim();
    if (/^@[A-Za-z0-9_]{1,15}$/.test(text)) return text.slice(1);
  }
  return null;
}

function readDisplayName(scope: Element | null): string | null {
  if (!scope) return null;
  const anchor = scope.querySelector('a[role="link"]') ?? scope.querySelector('a');
  const text = readTextContent(anchor);
  if (!text) return null;
  // The name block can concatenate "Name@handle·time"; keep the leading name.
  const name = text.split('\n')[0]?.split('@')[0]?.replace(/·.*$/, '').trim() ?? '';
  return name.length > 0 ? name : null;
}

/** Status anchors belonging to the main post (not the quote, not the avatar). */
function findStatusAnchors(article: Element, quote: Element | null): HTMLAnchorElement[] {
  const anchors = Array.from(article.querySelectorAll('a[href*="/status/"]')) as HTMLAnchorElement[];
  return anchors.filter((a) => !insideQuote(a, quote));
}

function detectMediaType(images: string[], hasVideo: boolean, hasGif: boolean): MediaType {
  if (hasGif && images.length === 0 && !hasVideo) return 'gif';
  if (hasVideo && images.length > 0) return 'mixed';
  if (hasVideo) return 'video';
  if (images.length > 0) return 'image';
  return 'none';
}

/**
 * Extracts one bookmark from an <article> element.
 *
 * Returns null when no post id can be established - a record without its
 * primary key is useless and is never fabricated. Every other field degrades
 * to null / [] independently, so a single markup change cannot take down the
 * whole extraction.
 */
export function extractBookmarkFromArticle(article: Element): BookmarkSource | null {
  const quote = findQuoteContainer(article);

  // --- identity -----------------------------------------------------------
  const timeEl = Array.from(article.querySelectorAll('time')).find(
    (t) => !insideQuote(t, quote),
  );
  const timeAnchor = timeEl?.closest('a[href*="/status/"]') ?? null;

  const statusAnchors = findStatusAnchors(article, quote);
  let postId = extractPostId(timeAnchor?.getAttribute('href') ?? null);
  let postHref = timeAnchor?.getAttribute('href') ?? null;

  if (!postId) {
    for (const anchor of statusAnchors) {
      const id = extractPostId(anchor.getAttribute('href'));
      if (id) {
        postId = id;
        postHref = anchor.getAttribute('href');
        break;
      }
    }
  }
  if (!postId) return null;

  // The status path is the most reliable source of the author handle.
  const pathHandle = postHref ? /^\/?([A-Za-z0-9_]{1,15})\/status/.exec(postHref.replace(/^https?:\/\/[^/]+/, ''))?.[1] ?? null : null;

  const nameBlock =
    (Array.from(article.querySelectorAll('[data-testid="User-Name"]')).find(
      (n) => !insideQuote(n, quote),
    ) as Element | undefined) ?? null;

  const handle = readHandle(nameBlock) ?? pathHandle;
  const authorName = readDisplayName(nameBlock);

  // --- body ---------------------------------------------------------------
  const textEl =
    (Array.from(article.querySelectorAll('[data-testid="tweetText"]')).find(
      (n) => !insideQuote(n, quote),
    ) as Element | undefined) ?? null;
  const text = readTextContent(textEl);

  const externalUrls = new Set<string>();
  const linkScopes: Element[] = [];
  if (textEl) linkScopes.push(textEl);
  const card = article.querySelector('[data-testid="card.wrapper"]');
  if (card && !insideQuote(card, quote)) linkScopes.push(card);

  for (const scope of linkScopes) {
    for (const anchor of Array.from(scope.querySelectorAll('a[href]'))) {
      if (insideQuote(anchor, quote)) continue;
      const url = resolveExternalUrl(anchor);
      if (url) externalUrls.add(url);
    }
  }

  // --- media --------------------------------------------------------------
  const imageUrls: string[] = [];
  const thumbnails: string[] = [];

  const photoNodes = Array.from(article.querySelectorAll('[data-testid="tweetPhoto"] img, img[src*="/media/"]'));
  for (const img of photoNodes) {
    if (insideQuote(img, quote)) continue;
    const src = img.getAttribute('src');
    if (!src) continue;
    if (src.includes('profile_images') || src.includes('profile_banners')) continue;
    if (!imageUrls.includes(src)) imageUrls.push(src);
  }

  const videoNodes = Array.from(
    article.querySelectorAll(
      '[data-testid="videoPlayer"], [data-testid="videoComponent"], [data-testid="previewInterstitial"], video',
    ),
  ).filter((n) => !insideQuote(n, quote));

  const hasVideo = videoNodes.length > 0;
  for (const node of videoNodes) {
    const poster = node.getAttribute('poster');
    if (poster && !thumbnails.includes(poster)) thumbnails.push(poster);
    const posterImg = node.querySelector?.('img[src]')?.getAttribute('src');
    if (posterImg && !posterImg.includes('profile_images') && !thumbnails.includes(posterImg)) {
      thumbnails.push(posterImg);
    }
  }

  const hasGif = Array.from(article.querySelectorAll('[data-testid="placementTracking"], [aria-label]'))
    .filter((n) => !insideQuote(n, quote))
    .some((n) => /\bgif\b/i.test(n.getAttribute('aria-label') ?? ''));

  // Images double as thumbnails when nothing more specific exists.
  for (const src of imageUrls) if (!thumbnails.includes(src)) thumbnails.push(src);

  // --- quoted post --------------------------------------------------------
  let quotedId: string | null = null;
  let quotedUrl: string | null = null;
  let quotedAuthor: string | null = null;
  let quotedText: string | null = null;

  if (quote) {
    const quotedAnchor = quote.querySelector('a[href*="/status/"]');
    quotedId = extractPostId(quotedAnchor?.getAttribute('href') ?? null);
    quotedAuthor = readHandle(quote);
    quotedText = readTextContent(quote.querySelector('[data-testid="tweetText"]'));
    if (quotedId) quotedUrl = buildPostUrl(quotedAuthor, quotedId);
    else if (quotedAnchor) quotedUrl = absolute(quotedAnchor.getAttribute('href'));
  }

  // --- reply --------------------------------------------------------------
  // The bookmarks timeline renders "Replying to @handle" without linking the
  // parent status, so the parent id is usually unavailable from the DOM. It is
  // left null unless an actual status link is present.
  let replyToPostId: string | null = null;
  let replyToUrl: string | null = null;
  const replyBanner = Array.from(article.querySelectorAll('div, span')).find((n) =>
    /^replying to/i.test((n.textContent ?? '').trim()),
  );
  if (replyBanner) {
    const anchor = replyBanner.querySelector('a[href*="/status/"]');
    replyToPostId = extractPostId(anchor?.getAttribute('href') ?? null);
    if (replyToPostId) replyToUrl = absolute(anchor?.getAttribute('href') ?? null);
  }

  // --- engagement ---------------------------------------------------------
  const group = Array.from(article.querySelectorAll('[role="group"][aria-label]')).find(
    (n) => !insideQuote(n, quote),
  );
  const counts = parseEngagementLabel(group?.getAttribute('aria-label') ?? null);

  // Per-button labels are a fallback when the group summary is missing.
  if (counts.like_count === null) {
    const like = article.querySelector('[data-testid="like"], [data-testid="unlike"]');
    counts.like_count = parseCount(/^([\d.,]+[KMB]?)/.exec(like?.textContent?.trim() ?? '')?.[1]);
  }
  if (counts.reply_count === null) {
    const reply = article.querySelector('[data-testid="reply"]');
    counts.reply_count = parseCount(/^([\d.,]+[KMB]?)/.exec(reply?.textContent?.trim() ?? '')?.[1]);
  }
  if (counts.repost_count === null) {
    const repost = article.querySelector('[data-testid="retweet"], [data-testid="unretweet"]');
    counts.repost_count = parseCount(/^([\d.,]+[KMB]?)/.exec(repost?.textContent?.trim() ?? '')?.[1]);
  }

  const postedAt = timeEl?.getAttribute('datetime') ?? null;

  return {
    post_id: postId,
    post_url: buildPostUrl(handle, postId),
    author_name: authorName,
    author_handle: handle,
    author_profile_url: handle ? `https://x.com/${handle}` : null,
    posted_at: postedAt && !Number.isNaN(Date.parse(postedAt)) ? new Date(postedAt).toISOString() : null,
    text,
    external_urls: [...externalUrls],
    media_type: detectMediaType(imageUrls, hasVideo, hasGif),
    image_urls: imageUrls,
    video_available: hasVideo,
    media_thumbnail_urls: thumbnails,
    quoted_post_id: quotedId,
    quoted_post_url: quotedUrl,
    quoted_post_author: quotedAuthor,
    quoted_post_text: quotedText,
    reply_to_post_id: replyToPostId,
    reply_to_url: replyToUrl,
    like_count: counts.like_count,
    reply_count: counts.reply_count,
    repost_count: counts.repost_count,
    view_count: counts.view_count,
    source: 'dom',
  };
}

/** Extracts every bookmark currently rendered in the timeline. */
export function extractVisibleBookmarks(root: ParentNode): BookmarkSource[] {
  const out: BookmarkSource[] = [];
  const seen = new Set<string>();
  for (const article of findArticles(root)) {
    let bookmark: BookmarkSource | null = null;
    try {
      bookmark = extractBookmarkFromArticle(article);
    } catch {
      // One malformed article must never stop the pass.
      bookmark = null;
    }
    if (bookmark && !seen.has(bookmark.post_id)) {
      seen.add(bookmark.post_id);
      out.push(bookmark);
    }
  }
  return out;
}

/** Cheap page-level signals used for friendly error messages. */
export function assessPage(doc: Document): PageHealth {
  const path = doc.location?.pathname ?? '';
  const onBookmarksPage = /^\/i\/bookmarks/.test(path);

  // The logged-out timeline renders a login prompt and no primary column.
  const loggedIn =
    doc.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]') !== null ||
    doc.querySelector('[data-testid="AppTabBar_Profile_Link"]') !== null ||
    doc.querySelector('[data-testid="primaryColumn"]') !== null;

  const articles = findArticles(doc);
  const extracted = articles.filter((a) => extractBookmarkFromArticle(a) !== null);

  const bodyText = doc.body?.textContent ?? '';
  const emptyState =
    articles.length === 0 &&
    /save posts for later|haven't added any bookmarks|no bookmarks yet/i.test(bodyText);

  return {
    onBookmarksPage,
    loggedIn,
    articleCount: articles.length,
    unsupportedDom: articles.length > 0 && extracted.length === 0,
    emptyState,
  };
}
