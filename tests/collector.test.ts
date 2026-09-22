import { describe, expect, it } from 'vitest';
import { BookmarkCollector, type BatchResult } from '../src/x/collector';
import type { BookmarkSource } from '../src/shared/types';
import type { CollectorConfig } from '../src/shared/messages';
import { ALL_FIXTURES, type Fixture } from './fixtures/x-posts';

const CONFIG: CollectorConfig = {
  incrementalKnownThreshold: 40,
  emptyRoundLimit: 2,
  scrollDelayMs: 20,
  scrollStepRatio: 0.8,
  enableNetworkEnhancement: false,
};

/**
 * A stand-in for the browser window. Scrolling swaps the rendered articles,
 * which is how X's virtualized timeline actually behaves: older posts appear
 * and newer ones are removed from the DOM entirely.
 */
class FakeWindow {
  scrollY = 0;
  innerHeight = 800;
  onScroll: (() => void) | null = null;

  setTimeout(handler: () => void, ms?: number): number {
    return globalThis.setTimeout(handler, Math.min(ms ?? 0, 5)) as unknown as number;
  }

  clearTimeout(id: number): void {
    globalThis.clearTimeout(id);
  }

  clearInterval(id: number): void {
    globalThis.clearInterval(id);
  }

  scrollTo(options: { top: number }): void {
    this.scrollY = Math.max(0, options.top);
    this.onScroll?.();
  }

  addEventListener(): void {
    /* the network enhancement is disabled in these tests */
  }

  removeEventListener(): void {
    /* no-op */
  }
}

function articleHtml(fixture: Fixture): string {
  const match = /<article[\s\S]*<\/article>/.exec(fixture.html);
  return match ? match[0] : '';
}

interface Harness {
  doc: Document;
  win: FakeWindow;
  render: (fixtures: Fixture[]) => void;
}

function createHarness(): Harness {
  const doc = document.implementation.createHTMLDocument('bookmarks');
  Object.defineProperty(doc, 'location', {
    value: { pathname: '/i/bookmarks', href: 'https://x.com/i/bookmarks' },
    configurable: true,
  });

  doc.body.innerHTML =
    '<div data-testid="primaryColumn"><div aria-label="Timeline: Bookmarks" id="timeline"></div></div>';

  const render = (fixtures: Fixture[]): void => {
    const timeline = doc.getElementById('timeline');
    if (timeline) timeline.innerHTML = fixtures.map(articleHtml).join('\n');
  };

  return { doc, win: new FakeWindow(), render };
}

interface RunResult {
  batches: BookmarkSource[][];
  finished: string | null;
  reachedEnd: boolean | null;
  errors: Array<{ message: string; fatal: boolean }>;
  collector: BookmarkCollector;
}

async function run(
  harness: Harness,
  onBatch?: (
    bookmarks: BookmarkSource[],
    all: BookmarkSource[][],
    collector: BookmarkCollector,
  ) => BatchResult,
): Promise<RunResult> {
  const batches: BookmarkSource[][] = [];
  const errors: Array<{ message: string; fatal: boolean }> = [];
  let finished: string | null = null;
  let reachedEnd: boolean | null = null;

  const collector: BookmarkCollector = new BookmarkCollector(
    CONFIG,
    {
      onBatch: async (bookmarks): Promise<BatchResult> => {
        batches.push(bookmarks);
        return onBatch ? onBatch(bookmarks, batches, collector) : { stop: false };
      },
      onRound: () => undefined,
      onError: (message, fatal) => errors.push({ message, fatal }),
      onFinished: (reason, end) => {
        finished = reason;
        reachedEnd = end;
      },
    },
    harness.doc,
    harness.win as unknown as Window,
  );

  await collector.run('incremental');
  return { batches, finished, reachedEnd, errors, collector };
}

describe('BookmarkCollector', () => {
  it('collects every post across a virtualized feed without duplicates', async () => {
    const harness = createHarness();
    const pages = [ALL_FIXTURES.slice(0, 2), ALL_FIXTURES.slice(2, 4), ALL_FIXTURES.slice(4, 6)];
    let page = 0;

    harness.render(pages[0] as Fixture[]);
    harness.win.onScroll = () => {
      page += 1;
      // Older posts replace newer ones; the newer ones leave the DOM for good.
      if (page < pages.length) harness.render(pages[page] as Fixture[]);
      else harness.render([]);
    };

    const result = await run(harness);

    const ids = result.batches.flat().map((bookmark) => bookmark.post_id);
    expect(new Set(ids).size).toBe(ALL_FIXTURES.length);
    expect(ids).toHaveLength(new Set(ids).size); // nothing sent twice
    expect(result.finished).not.toBeNull();
    expect(result.errors.filter((error) => error.fatal)).toHaveLength(0);
  });

  it('saves the first screen before scrolling anywhere', async () => {
    const harness = createHarness();
    harness.render(ALL_FIXTURES.slice(0, 2));
    harness.win.onScroll = () => harness.render([]);

    const result = await run(harness);
    expect(result.batches[0]?.map((b) => b.post_id)).toEqual([
      ALL_FIXTURES[0]?.postId,
      ALL_FIXTURES[1]?.postId,
    ]);
    expect(harness.win.scrollY).toBeGreaterThan(0); // it did scroll, but only after saving
  });

  it('stops immediately when the background worker says so', async () => {
    const harness = createHarness();
    harness.render(ALL_FIXTURES.slice(0, 2));
    harness.win.onScroll = () => harness.render(ALL_FIXTURES.slice(2, 4));

    const result = await run(harness, () => ({ stop: true, reason: 'Reached known history.' }));

    expect(result.batches).toHaveLength(1);
    expect(result.finished).toBe('Reached known history.');
    // Only the newest slice was walked, so nothing may be concluded from the
    // bookmarks that were never reached.
    expect(result.reachedEnd).toBe(false);
  });

  it('does not claim it reached the end when it is stopped mid-run', async () => {
    const harness = createHarness();
    harness.render(ALL_FIXTURES.slice(0, 2));

    const result = await run(harness, (_bookmarks, all, collector) => {
      if (all.length === 1) collector.stop();
      return { stop: false };
    });

    expect(result.finished).toBe('Sync stopped.');
    expect(result.reachedEnd).toBe(false);
  });

  it('reports reaching the end once the feed stops producing anything new', async () => {
    const harness = createHarness();
    harness.render(ALL_FIXTURES.slice(0, 1));
    harness.win.onScroll = () => harness.render([]);

    const result = await run(harness);
    expect(result.finished).toBe('Reached the end of your bookmarks.');
    expect(result.reachedEnd).toBe(true);
  });

  it('finishes after the configured number of empty rounds', async () => {
    const harness = createHarness();
    harness.render(ALL_FIXTURES.slice(0, 1));
    // Nothing new ever loads.
    harness.win.onScroll = () => undefined;

    const result = await run(harness);
    expect(result.finished).toContain('bookmark');
    expect(result.collector.getSeenCount()).toBe(1);
  });

  it('refuses to run when the tab is not on the bookmarks page', async () => {
    const harness = createHarness();
    Object.defineProperty(harness.doc, 'location', {
      value: { pathname: '/home' },
      configurable: true,
    });
    harness.render(ALL_FIXTURES.slice(0, 1));

    const result = await run(harness);
    expect(result.batches).toHaveLength(0);
    expect(result.errors[0]?.fatal).toBe(true);
    expect(result.errors[0]?.message).toContain('x.com/i/bookmarks');
  });

  it('reports a friendly error when the user is not logged in', async () => {
    const harness = createHarness();
    harness.doc.body.innerHTML = '<div><a href="/login">Log in</a></div>';

    const result = await run(harness);
    expect(result.errors[0]?.fatal).toBe(true);
    expect(result.errors[0]?.message).toContain('logged in');
  });

  it('retries a batch that could not be saved instead of losing it', async () => {
    const harness = createHarness();
    harness.render(ALL_FIXTURES.slice(0, 2));
    harness.win.onScroll = () => harness.render([]);

    let attempt = 0;
    const seen: string[][] = [];
    const collector = new BookmarkCollector(
      CONFIG,
      {
        onBatch: async (bookmarks) => {
          attempt += 1;
          seen.push(bookmarks.map((b) => b.post_id));
          if (attempt === 1) throw new Error('database unavailable');
          return { stop: false };
        },
        onRound: () => undefined,
        onError: () => undefined,
        onFinished: () => undefined,
      },
      harness.doc,
      harness.win as unknown as Window,
    );

    await collector.run('incremental');

    expect(attempt).toBeGreaterThan(1);
    // The failed batch is presented again rather than being dropped.
    expect(seen[1]).toEqual(seen[0]);
  });
});
