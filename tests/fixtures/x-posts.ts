/**
 * Realistic X/Twitter article markup.
 *
 * These mirror the structure X actually renders - accessible labels, status
 * anchors, <time datetime>, data-testid hooks and emoji rendered as <img alt>.
 * They deliberately avoid X's generated CSS class names, exactly as the
 * extractor does.
 */

export interface Fixture {
  name: string;
  postId: string;
  html: string;
}

const AVATAR = 'https://pbs.twimg.com/profile_images/1700000000000000000/abcdef_normal.jpg';

function wrap(inner: string): string {
  return `<div data-testid="primaryColumn"><div aria-label="Timeline: Bookmarks">${inner}</div></div>`;
}

/** Plain text post, no media, no links. */
export const PLAIN_TEXT: Fixture = {
  name: 'plain text',
  postId: '1823456789012345678',
  html: wrap(`
<article role="article" data-testid="tweet" tabindex="0">
  <div data-testid="Tweet-User-Avatar"><img src="${AVATAR}" alt=""></div>
  <div data-testid="User-Name">
    <a href="/coreyganim" role="link"><span>Corey Ganim</span></a>
    <a href="/coreyganim" role="link"><span>@coreyganim</span></a>
    <span>·</span>
    <a href="/coreyganim/status/1823456789012345678" role="link"><time datetime="2026-08-14T15:04:05.000Z">Aug 14</time></a>
  </div>
  <div data-testid="tweetText" lang="en"><span>The best debugging tool is still a second pair of eyes.</span></div>
  <div role="group" aria-label="12 replies, 3 reposts, 45 likes, 6 bookmarks, 7890 views">
    <button data-testid="reply" aria-label="12 Replies"><span>12</span></button>
    <button data-testid="retweet" aria-label="3 reposts"><span>3</span></button>
    <button data-testid="like" aria-label="45 Likes"><span>45</span></button>
  </div>
</article>`),
};

/** Emoji (rendered as <img alt>), an external link and an image. */
export const EMOJI_LINK_IMAGE: Fixture = {
  name: 'emoji, external link and image',
  postId: '1901234567890123456',
  html: wrap(`
<article role="article" data-testid="tweet" tabindex="0">
  <div data-testid="Tweet-User-Avatar"><img src="${AVATAR}" alt=""></div>
  <div data-testid="User-Name">
    <a href="/simonw" role="link"><span>Simon Willison</span></a>
    <a href="/simonw" role="link"><span>@simonw</span></a>
    <a href="/simonw/status/1901234567890123456" role="link"><time datetime="2026-09-01T09:12:00.000Z">Sep 1</time></a>
  </div>
  <div data-testid="tweetText" lang="en"><span>Shipped a tiny CLI for this </span><img alt="🚀" src="https://abs-0.twimg.com/emoji/v2/svg/1f680.svg"><span>, "quotes" and, commas included </span><img alt="😅" src="https://abs-0.twimg.com/emoji/v2/svg/1f605.svg"><span> </span><a href="https://t.co/AbCdEf1234" role="link" dir="ltr">github.com/simonw/llm</a></div>
  <div data-testid="tweetPhoto"><img src="https://pbs.twimg.com/media/GaBcDeFgHiJkLmN?format=jpg&amp;name=small" alt="Screenshot of the CLI"></div>
  <div role="group" aria-label="88 replies, 412 reposts, 3,204 likes, 190 bookmarks, 251,003 views"></div>
</article>`),
};

/** Quote tweet: the quoted post is a nested role="link" container. */
export const QUOTE_POST: Fixture = {
  name: 'quoted post',
  postId: '1911111111111111111',
  html: wrap(`
<article role="article" data-testid="tweet" tabindex="0">
  <div data-testid="User-Name">
    <a href="/karpathy" role="link"><span>Andrej Karpathy</span></a>
    <a href="/karpathy" role="link"><span>@karpathy</span></a>
    <a href="/karpathy/status/1911111111111111111" role="link"><time datetime="2026-07-22T18:30:00.000Z">Jul 22</time></a>
  </div>
  <div data-testid="tweetText" lang="en"><span>This is the right framing.</span></div>
  <div role="link" tabindex="0">
    <div data-testid="User-Name">
      <a href="/ylecun" role="link"><span>Yann LeCun</span></a>
      <a href="/ylecun" role="link"><span>@ylecun</span></a>
      <a href="/ylecun/status/1900000000000000001" role="link"><time datetime="2026-07-22T10:00:00.000Z">Jul 22</time></a>
    </div>
    <div data-testid="tweetText" lang="en"><span>Scaling alone will not get us there.</span></div>
    <div data-testid="tweetPhoto"><img src="https://pbs.twimg.com/media/QUOTEDIMAGE?format=jpg&amp;name=small" alt=""></div>
  </div>
  <div role="group" aria-label="240 replies, 1,102 reposts, 9.8K likes, 2,001 bookmarks, 1.2M views"></div>
</article>`),
};

/** A reply: X renders a "Replying to @handle" banner above the text. */
export const REPLY_POST: Fixture = {
  name: 'reply',
  postId: '1922222222222222222',
  html: wrap(`
<article role="article" data-testid="tweet" tabindex="0">
  <div data-testid="User-Name">
    <a href="/dhh" role="link"><span>DHH</span></a>
    <a href="/dhh" role="link"><span>@dhh</span></a>
    <a href="/dhh/status/1922222222222222222" role="link"><time datetime="2026-06-05T11:00:00.000Z">Jun 5</time></a>
  </div>
  <div><span>Replying to </span><a href="/getvercel" role="link">@getvercel</a></div>
  <div data-testid="tweetText" lang="en"><span>Boring infrastructure is a feature, not a bug.</span></div>
  <div role="group" aria-label="31 replies, 12 reposts, 401 likes, 9 bookmarks, 21,400 views"></div>
</article>`),
};

/** Video post with no caption text. */
export const VIDEO_POST: Fixture = {
  name: 'video',
  postId: '1933333333333333333',
  html: wrap(`
<article role="article" data-testid="tweet" tabindex="0">
  <div data-testid="User-Name">
    <a href="/bambulab" role="link"><span>Bambu Lab</span></a>
    <a href="/bambulab" role="link"><span>@bambulab</span></a>
    <a href="/bambulab/status/1933333333333333333" role="link"><time datetime="2026-05-19T08:00:00.000Z">May 19</time></a>
  </div>
  <div data-testid="videoPlayer">
    <video poster="https://pbs.twimg.com/ext_tw_video_thumb/1933/pu/img/THUMB.jpg"></video>
  </div>
  <div role="group" aria-label="55 replies, 210 reposts, 2,400 likes, 88 bookmarks, 410,000 views"></div>
</article>`),
};

/** A long post, the kind X renders with "Show more". */
export const LONG_POST: Fixture = {
  name: 'long post',
  postId: '1944444444444444444',
  html: wrap(`
<article role="article" data-testid="tweet" tabindex="0">
  <div data-testid="User-Name">
    <a href="/levelsio" role="link"><span>levelsio</span></a>
    <a href="/levelsio" role="link"><span>@levelsio</span></a>
    <a href="/levelsio/status/1944444444444444444" role="link"><time datetime="2026-04-02T07:45:00.000Z">Apr 2</time></a>
  </div>
  <div data-testid="tweetText" lang="en"><div><span>Here is everything I learned shipping 12 products in 12 months:</span></div><div><span>1. Ship before it is ready. 2. Charge from day one. 3. Talk to users every single day, even when it hurts.</span></div><div><span>4. Most "growth hacks" are noise; distribution is a habit, not a trick. 5. Your first 100 customers come from places that do not scale, and that is fine.</span></div></div>
  <div role="group" aria-label="1,204 replies, 4,800 reposts, 41,002 likes, 12,900 bookmarks, 4.1M views"></div>
</article>`),
};

/** Article with no recognisable status link - the extractor must skip it. */
export const UNSUPPORTED: Fixture = {
  name: 'unsupported markup',
  postId: '',
  html: wrap(`
<article role="article" tabindex="0">
  <div class="css-1dbjc4n"><span>Who to follow</span></div>
</article>`),
};

export const ALL_FIXTURES: Fixture[] = [
  PLAIN_TEXT,
  EMOJI_LINK_IMAGE,
  QUOTE_POST,
  REPLY_POST,
  VIDEO_POST,
  LONG_POST,
];

/** Builds a document containing several fixtures, as a real timeline would. */
export function timelineHtml(fixtures: Fixture[]): string {
  const inner = fixtures
    .map((fixture) => fixture.html.replace(/^[\s\S]*?aria-label="Timeline: Bookmarks">/, '').replace(/<\/div><\/div>$/, ''))
    .join('\n');
  return `<div data-testid="primaryColumn"><div aria-label="Timeline: Bookmarks">${inner}</div></div>`;
}
