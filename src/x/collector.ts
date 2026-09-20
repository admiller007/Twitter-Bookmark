/**
 * Bookmark collector.
 *
 * X renders the bookmarks timeline as a virtualized list: posts are removed
 * from the DOM shortly after they scroll out of view. The collector therefore
 * never treats the DOM as a snapshot it can read at the end - it harvests
 * continuously (on every mutation and before every scroll step), hands each
 * batch straight to the background worker for persistence, and only then
 * scrolls further.
 *
 * Progress is owned by the background worker, which holds the database. The
 * collector asks after each batch whether it should stop, which is how the
 * incremental "enough consecutive known bookmarks" heuristic is applied
 * without the content script needing a copy of the library.
 */

import type { BookmarkSource, SyncMode } from '../shared/types';
import type { CollectorConfig } from '../shared/messages';
import { extractVisibleBookmarks, assessPage } from './extractor';
import { NET_HOOK_MESSAGE } from './net-protocol';

export interface BatchResult {
  stop: boolean;
  reason?: string;
}

export interface CollectorCallbacks {
  /** Persist a batch; resolves with whether the collector should stop. */
  onBatch(bookmarks: BookmarkSource[], roundIndex: number): Promise<BatchResult>;
  onRound(info: { roundIndex: number; seen: number; emptyRounds: number; lastPostId: string | null }): void;
  onError(message: string, fatal: boolean): void;
  onFinished(reason: string): void;
}

export type CollectorState = 'idle' | 'running' | 'paused' | 'stopped' | 'finished';

const HARVEST_DEBOUNCE_MS = 120;
const POLL_INTERVAL_MS = 150;

export class BookmarkCollector {
  private state: CollectorState = 'idle';
  private observer: MutationObserver | null = null;
  private harvestTimer: number | null = null;
  private netListener: ((event: MessageEvent) => void) | null = null;

  /** Post ids already handed to the background during this run. */
  private readonly seenIds = new Set<string>();
  /** Buffer of records waiting to be flushed. */
  private pending = new Map<string, BookmarkSource>();

  private roundIndex = 0;
  private emptyRounds = 0;
  private lastPostId: string | null = null;
  private resumeWaiters: Array<() => void> = [];

  constructor(
    private readonly config: CollectorConfig,
    private readonly callbacks: CollectorCallbacks,
    private readonly doc: Document = document,
    private readonly win: Window = window,
  ) {}

  getState(): CollectorState {
    return this.state;
  }

  getSeenCount(): number {
    return this.seenIds.size;
  }

  /** Runs the whole collection loop. Resolves when it finishes or is stopped. */
  async run(_mode: SyncMode): Promise<void> {
    if (this.state === 'running') return;

    const health = assessPage(this.doc);
    if (!health.onBookmarksPage) {
      this.callbacks.onError(
        'This tab is not on https://x.com/i/bookmarks. Open your bookmarks page and start the sync again.',
        true,
      );
      return;
    }
    if (!health.loggedIn) {
      this.callbacks.onError(
        'You do not appear to be logged in to X in this browser. Log in, reload the bookmarks page, then sync again.',
        true,
      );
      return;
    }

    this.state = 'running';
    this.attachObserver();
    this.attachNetworkListener();

    try {
      await this.loop();
    } catch (error) {
      this.callbacks.onError(
        error instanceof Error ? error.message : String(error),
        true,
      );
    } finally {
      this.teardown();
    }
  }

  pause(): void {
    if (this.state === 'running') this.state = 'paused';
  }

  resume(): void {
    if (this.state !== 'paused') return;
    this.state = 'running';
    const waiters = this.resumeWaiters;
    this.resumeWaiters = [];
    for (const waiter of waiters) waiter();
  }

  stop(): void {
    if (this.state === 'stopped' || this.state === 'finished') return;
    this.state = 'stopped';
    this.resume();
  }

  /* ------------------------------------------------------------- internals */

  private async loop(): Promise<void> {
    // Capture whatever is already on screen before touching the scroll
    // position, so nothing visible is lost to virtualization.
    this.harvest();
    let flush = await this.flush();
    if (flush.stop) return this.finish(flush.reason ?? 'stop-requested');

    while (this.state === 'running' || this.state === 'paused') {
      await this.waitWhilePaused();
      if (this.state !== 'running') break;

      this.roundIndex += 1;
      const before = this.seenIds.size;

      this.recoverFromErrorState();
      const scroller = this.getScroller();
      const atBottomBefore = this.isAtBottom(scroller);

      this.scrollStep(scroller, this.emptyRounds);
      await this.waitForContent();

      this.harvest();
      flush = await this.flush();
      if (flush.stop) return this.finish(flush.reason ?? 'stop-requested');

      const discovered = this.seenIds.size - before;
      if (discovered > 0) {
        this.emptyRounds = 0;
      } else {
        this.emptyRounds += 1;
      }

      this.callbacks.onRound({
        roundIndex: this.roundIndex,
        seen: this.seenIds.size,
        emptyRounds: this.emptyRounds,
        lastPostId: this.lastPostId,
      });

      if (this.emptyRounds >= this.config.emptyRoundLimit) {
        const atBottomAfter = this.isAtBottom(this.getScroller());
        return this.finish(
          atBottomBefore && atBottomAfter
            ? 'Reached the end of your bookmarks.'
            : 'No new bookmarks appeared after several attempts.',
        );
      }
    }

    if (this.state === 'stopped') this.finish('Sync stopped.');
  }

  private finish(reason: string): void {
    if (this.state === 'finished') return;
    this.state = 'finished';
    this.callbacks.onFinished(reason);
  }

  private waitWhilePaused(): Promise<void> {
    if (this.state !== 'paused') return Promise.resolve();
    return new Promise((resolve) => this.resumeWaiters.push(resolve));
  }

  /** Reads every rendered article into the pending buffer. */
  private harvest(): void {
    let bookmarks: BookmarkSource[] = [];
    try {
      bookmarks = extractVisibleBookmarks(this.doc);
    } catch (error) {
      this.callbacks.onError(
        `Extraction failed for one batch: ${error instanceof Error ? error.message : String(error)}`,
        false,
      );
      return;
    }

    for (const bookmark of bookmarks) {
      // A DOM record never overwrites a richer network record in the buffer.
      const existing = this.pending.get(bookmark.post_id);
      if (existing && existing.source === 'network' && bookmark.source === 'dom') continue;
      this.pending.set(bookmark.post_id, bookmark);
    }
  }

  /** Sends the buffer to the background worker and clears it. */
  private async flush(): Promise<BatchResult> {
    if (this.pending.size === 0) return { stop: false };

    const batch = [...this.pending.values()];
    this.pending.clear();

    for (const bookmark of batch) {
      this.seenIds.add(bookmark.post_id);
      this.lastPostId = bookmark.post_id;
    }

    try {
      return await this.callbacks.onBatch(batch, this.roundIndex);
    } catch (error) {
      // Persisting failed: put the batch back so the next round retries it.
      for (const bookmark of batch) {
        this.pending.set(bookmark.post_id, bookmark);
        this.seenIds.delete(bookmark.post_id);
      }
      this.callbacks.onError(
        `Could not save a batch: ${error instanceof Error ? error.message : String(error)}`,
        false,
      );
      return { stop: false };
    }
  }

  private attachObserver(): void {
    const target = this.doc.querySelector('[data-testid="primaryColumn"]') ?? this.doc.body;
    if (!target) return;

    this.observer = new MutationObserver(() => {
      if (this.state !== 'running') return;
      if (this.harvestTimer !== null) return;
      this.harvestTimer = this.win.setTimeout(() => {
        this.harvestTimer = null;
        // Harvest on mutation so posts are captured the moment they render,
        // long before the virtualized list can recycle them away.
        this.harvest();
      }, HARVEST_DEBOUNCE_MS);
    });

    this.observer.observe(target, { childList: true, subtree: true });
  }

  /** Accepts records from the optional MAIN-world network observer. */
  private attachNetworkListener(): void {
    if (!this.config.enableNetworkEnhancement) return;

    this.netListener = (event: MessageEvent) => {
      if (event.source !== this.win) return;
      const data = event.data as { __xbv?: string; bookmarks?: BookmarkSource[] } | null;
      if (!data || data.__xbv !== NET_HOOK_MESSAGE || !Array.isArray(data.bookmarks)) return;

      for (const bookmark of data.bookmarks) {
        if (!bookmark || typeof bookmark.post_id !== 'string') continue;
        if (!/^\d{6,25}$/.test(bookmark.post_id)) continue;
        this.pending.set(bookmark.post_id, { ...bookmark, source: 'network' });
      }
    };

    this.win.addEventListener('message', this.netListener);
  }

  private teardown(): void {
    this.observer?.disconnect();
    this.observer = null;
    if (this.harvestTimer !== null) {
      this.win.clearTimeout(this.harvestTimer);
      this.harvestTimer = null;
    }
    if (this.netListener) {
      this.win.removeEventListener('message', this.netListener);
      this.netListener = null;
    }
  }

  /* ------------------------------------------------------------- scrolling */

  /**
   * X usually scrolls the document, but some layouts nest the timeline in an
   * overflow container. Whichever actually has room to scroll wins.
   */
  private getScroller(): Element | Window {
    const doc = this.doc.scrollingElement ?? this.doc.documentElement;
    if (doc && doc.scrollHeight > doc.clientHeight + 40) return this.win;

    const timeline = this.doc.querySelector('[data-testid="primaryColumn"]');
    let node: Element | null = timeline;
    while (node) {
      if (node.scrollHeight > node.clientHeight + 40) return node;
      node = node.parentElement;
    }
    return this.win;
  }

  private scrollTop(scroller: Element | Window): number {
    if (scroller === this.win) return this.win.scrollY;
    return (scroller as Element).scrollTop;
  }

  private viewportHeight(scroller: Element | Window): number {
    if (scroller === this.win) return this.win.innerHeight;
    return (scroller as Element).clientHeight;
  }

  private isAtBottom(scroller: Element | Window): boolean {
    if (scroller === this.win) {
      const el = this.doc.scrollingElement ?? this.doc.documentElement;
      if (!el) return false;
      return el.scrollHeight - (this.win.scrollY + this.win.innerHeight) < 200;
    }
    const el = scroller as Element;
    return el.scrollHeight - (el.scrollTop + el.clientHeight) < 200;
  }

  /**
   * Scrolls by less than one viewport so no post can pass through without
   * being rendered. After repeated empty rounds the step escalates: a nudge
   * back up (which forces X to re-run its windowing logic), then a jump to the
   * bottom to prod the loader.
   */
  private scrollStep(scroller: Element | Window, emptyRounds: number): void {
    const viewport = this.viewportHeight(scroller);
    const ratio = Math.min(0.95, Math.max(0.2, this.config.scrollStepRatio));
    const current = this.scrollTop(scroller);

    let target = current + viewport * ratio;
    if (emptyRounds === 2) target = Math.max(0, current - viewport * 0.5);
    else if (emptyRounds >= 3) target = current + viewport * 2;

    if (scroller === this.win) this.win.scrollTo({ top: target, behavior: 'auto' });
    else (scroller as Element).scrollTop = target;
  }

  /**
   * Waits for X to render something new. Resolves as soon as the article count
   * or the newest post id changes, rather than burning the full delay, and
   * gives up after a bounded timeout so a stalled feed cannot hang the loop.
   */
  private async waitForContent(): Promise<void> {
    const base = Math.max(200, this.config.scrollDelayMs);
    // Back off as empty rounds accumulate: a rate-limited feed needs longer.
    const timeout = base * (1 + Math.min(this.emptyRounds, 4));
    const deadline = Date.now() + timeout;

    const signature = () => {
      const articles = this.doc.querySelectorAll('article');
      const first = articles[0]?.querySelector('time')?.getAttribute('datetime') ?? '';
      const last = articles[articles.length - 1]?.querySelector('time')?.getAttribute('datetime') ?? '';
      return `${articles.length}:${first}:${last}`;
    };

    const before = signature();
    // Always give the browser at least one paint before sampling.
    await this.delay(Math.min(200, base));

    while (Date.now() < deadline) {
      if (this.state !== 'running') return;
      if (signature() !== before) {
        // Let the newly inserted subtree settle before harvesting.
        await this.delay(Math.min(250, base));
        return;
      }
      if (this.isLoading()) {
        await this.delay(POLL_INTERVAL_MS);
        continue;
      }
      await this.delay(POLL_INTERVAL_MS);
    }
  }

  private isLoading(): boolean {
    return this.doc.querySelector('[role="progressbar"]') !== null;
  }

  /**
   * X shows "Something went wrong. Try reloading." when its own request fails.
   * Clicking its retry button is far cheaper than aborting the sync.
   */
  private recoverFromErrorState(): void {
    try {
      const primary = this.doc.querySelector('[data-testid="primaryColumn"]');
      if (!primary) return;
      const text = primary.textContent ?? '';
      if (!/something went wrong|try again/i.test(text)) return;

      const retry = Array.from(primary.querySelectorAll('[role="button"], button')).find((node) =>
        /retry|try again|reload/i.test(node.textContent ?? ''),
      ) as HTMLElement | undefined;

      if (retry) {
        retry.click();
        this.callbacks.onError('X reported an error; clicked its retry button.', false);
      }
    } catch {
      /* recovery is best-effort */
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => this.win.setTimeout(resolve, ms));
  }
}
