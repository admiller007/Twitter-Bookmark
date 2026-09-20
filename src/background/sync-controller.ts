/**
 * Sync orchestration.
 *
 * The background worker owns the database and therefore owns all sync state.
 * The content script is a pure producer: it scrapes and streams batches, and
 * the controller decides what is new, what changed, and when to stop.
 *
 * Every batch is persisted before the collector is told to keep going, so a
 * closed tab, a closed browser, a terminated service worker or a crash can
 * never lose more than the batch currently in flight.
 */

import type { BookmarkSource, SyncMode, SyncSession } from '../shared/types';
import type {
  BackgroundToCollector,
  CollectorConfig,
  CollectorToBackground,
  SyncProgress,
} from '../shared/messages';
import {
  countBookmarks,
  getRecentSyncSessions,
  getResumableSession,
  markMissingAsUnbookmarked,
  saveSyncSession,
  setMeta,
  upsertBookmarks,
} from '../database/db';
import { loadSettings } from '../shared/settings';
import { log } from '../shared/logger';
import { errorMessage, nowIso, randomId } from '../shared/util';
import { advanceKnownStreak, shouldStopIncremental, stopReason } from './incremental';

type Port = chrome.runtime.Port;

const SEEN_PERSIST_EVERY_ROUNDS = 20;

export class SyncController {
  private port: Port | null = null;
  private session: SyncSession | null = null;
  private phase = 'Idle';
  /** Post ids observed during the current run (Full Rescan deletion check). */
  private seenIds = new Set<string>();
  private roundsSincePersist = 0;
  private listeners = new Set<(progress: SyncProgress) => void>();

  /** Restores a session that was interrupted by a restart. */
  async init(): Promise<void> {
    const resumable = await getResumableSession();
    if (!resumable) return;

    // The collector is gone after a restart, so the run is parked as paused
    // until a bookmarks tab reconnects.
    this.session = { ...resumable, status: 'paused' };
    this.phase = 'Paused - reopen https://x.com/i/bookmarks to resume.';
    await this.persistSession();
    log.info('sync', 'Recovered an interrupted sync session', {
      sync_id: resumable.sync_id,
      seen: resumable.seen_count,
    });
  }

  onProgress(listener: (progress: SyncProgress) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /* ------------------------------------------------------------ port wiring */

  async attach(port: Port): Promise<void> {
    this.port = port;
    port.onDisconnect.addListener(() => {
      if (this.port === port) this.port = null;
      if (this.session?.status === 'running') {
        // The tab went away mid-run: park the session so it can resume.
        void this.updateSession({
          status: 'paused',
          error_message: null,
          stop_reason: 'The bookmarks tab was closed. Reopen it to resume.',
        });
        this.phase = 'Paused - the bookmarks tab was closed.';
        this.broadcast();
      }
    });

    port.onMessage.addListener((message: CollectorToBackground) => {
      void this.handleCollectorMessage(message);
    });

    // A session parked by a restart resumes as soon as a tab is available.
    if (this.session && (this.session.status === 'running' || this.session.status === 'paused')) {
      log.info('sync', 'Bookmarks tab reconnected; resuming sync', {
        sync_id: this.session.sync_id,
      });
      await this.sendStart(this.session.mode);
    }
    this.broadcast();
  }

  isAttached(): boolean {
    return this.port !== null;
  }

  /* -------------------------------------------------------------- commands */

  async start(mode: SyncMode): Promise<SyncProgress> {
    if (!this.port) {
      throw new Error(
        'No X bookmarks tab is connected. Open https://x.com/i/bookmarks in a tab, wait for it to load, then start the sync.',
      );
    }
    if (this.session?.status === 'running') return this.snapshot();

    this.seenIds = new Set();
    this.roundsSincePersist = 0;
    this.session = {
      sync_id: randomId('sync'),
      started_at: nowIso(),
      last_activity_at: nowIso(),
      mode,
      new_count: 0,
      updated_count: 0,
      seen_count: 0,
      status: 'running',
      last_seen_post_id: null,
      consecutive_known_count: 0,
      error_message: null,
      empty_rounds: 0,
      finished_at: null,
      stop_reason: null,
    };
    this.phase = mode === 'full' ? 'Full rescan starting...' : 'Looking for new bookmarks...';

    await this.persistSession();
    await this.sendStart(mode);
    log.info('sync', `Started ${mode} sync`, { sync_id: this.session.sync_id });
    return this.snapshot();
  }

  async pause(): Promise<SyncProgress> {
    this.post({ type: 'collector/pause' });
    await this.updateSession({ status: 'paused' });
    this.phase = 'Paused.';
    return this.snapshot();
  }

  async resume(): Promise<SyncProgress> {
    if (!this.session) throw new Error('There is no sync to resume.');
    if (!this.port) {
      throw new Error(
        'No X bookmarks tab is connected. Open https://x.com/i/bookmarks to resume this sync.',
      );
    }

    if (this.session.status === 'paused' && this.isCollectorAlive) {
      this.post({ type: 'collector/resume' });
    } else {
      // The collector is gone (tab closed, worker restarted): start a fresh
      // pass in the same mode. Already-stored bookmarks are recognised, so an
      // incremental resume stops again quickly.
      await this.sendStart(this.session.mode);
    }

    await this.updateSession({ status: 'running' });
    this.phase = 'Resuming...';
    return this.snapshot();
  }

  async stop(): Promise<SyncProgress> {
    this.post({ type: 'collector/stop' });
    await this.updateSession({
      status: 'stopped',
      finished_at: nowIso(),
      stop_reason: 'Stopped by you.',
    });
    this.phase = 'Stopped.';
    return this.snapshot();
  }

  async snapshot(): Promise<SyncProgress> {
    return {
      session: this.session,
      total: await countBookmarks(),
      phase: this.phase,
      attached: this.port !== null,
    };
  }

  /* --------------------------------------------------------------- handlers */

  private isCollectorAlive = false;

  private async handleCollectorMessage(message: CollectorToBackground): Promise<void> {
    try {
      switch (message.type) {
        case 'collector/hello':
          this.isCollectorAlive = true;
          return;

        case 'collector/keepalive':
          // Receiving a message resets the service worker's idle timer, which
          // is what keeps a long sync alive under MV3.
          return;

        case 'collector/batch':
          await this.handleBatch(message.bookmarks);
          return;

        case 'collector/round':
          await this.updateSession({
            empty_rounds: message.emptyRounds,
            last_seen_post_id: message.lastPostId,
            last_activity_at: nowIso(),
          });
          this.phase =
            message.emptyRounds > 0
              ? `Waiting for X to load more (attempt ${message.emptyRounds})...`
              : 'Scanning older bookmarks...';
          this.roundsSincePersist += 1;
          if (this.roundsSincePersist >= SEEN_PERSIST_EVERY_ROUNDS) {
            this.roundsSincePersist = 0;
            await this.persistSeenIds();
          }
          this.broadcast();
          return;

        case 'collector/finished':
          this.isCollectorAlive = false;
          await this.finish(message.reason);
          return;

        case 'collector/error':
          log[message.fatal ? 'error' : 'warn']('collector', message.message);
          if (message.fatal) {
            this.isCollectorAlive = false;
            await this.updateSession({
              status: 'error',
              error_message: message.message,
              finished_at: nowIso(),
            });
            this.phase = message.message;
          }
          this.broadcast();
          return;

        default:
          return;
      }
    } catch (error) {
      const text = errorMessage(error);
      log.error('sync', `Failed to handle a collector message: ${text}`);
      await this.updateSession({ status: 'error', error_message: text });
      this.broadcast();
    }
  }

  /**
   * Persists one batch and applies the incremental stop heuristic.
   *
   * The heuristic counts *consecutive* already-known bookmarks in timeline
   * order. A single known bookmark proves nothing (a post can be re-saved, or
   * the order can shift), so the streak has to reach the configured threshold
   * - 40 by default - before the sync concludes it has reached previously
   * synchronised history. Any unknown bookmark resets the streak to zero.
   * Full Rescan bypasses the heuristic entirely.
   */
  private async handleBatch(bookmarks: BookmarkSource[]): Promise<void> {
    if (!this.session) return;

    const summary = await upsertBookmarks(bookmarks, nowIso());
    for (const bookmark of bookmarks) this.seenIds.add(bookmark.post_id);

    const streak = advanceKnownStreak(this.session.consecutive_known_count, summary.outcomes);

    const settings = await loadSettings();
    const threshold = Math.max(1, settings.incrementalKnownThreshold);
    const shouldStop = shouldStopIncremental(this.session.mode, streak, threshold);

    await this.updateSession({
      new_count: this.session.new_count + summary.newCount,
      updated_count: this.session.updated_count + summary.updatedCount,
      seen_count: this.seenIds.size,
      consecutive_known_count: streak,
      last_activity_at: nowIso(),
    });

    this.post({
      type: 'collector/ack',
      newCount: this.session.new_count,
      updatedCount: this.session.updated_count,
      total: await countBookmarks(),
      stop: shouldStop,
      reason: shouldStop ? stopReason(threshold) : undefined,
    });

    this.phase = 'Scanning older bookmarks...';
    this.broadcast();
  }

  private async finish(reason: string): Promise<void> {
    if (!this.session) return;

    const settings = await loadSettings();
    let extra = '';

    if (this.session.mode === 'full' && settings.detectUnbookmarkedOnFullRescan) {
      // Only a full rescan inspects the whole history, so only a full rescan
      // may conclude that an absent bookmark was removed - and even then it is
      // flagged, never deleted.
      const marked = await markMissingAsUnbookmarked(this.seenIds);
      if (marked > 0) extra = ` ${marked} bookmark(s) marked as no longer bookmarked.`;
      log.info('sync', `Full rescan flagged ${marked} missing bookmark(s)`);
    }

    await this.updateSession({
      status: 'completed',
      finished_at: nowIso(),
      stop_reason: `${reason}${extra}`,
    });
    this.phase = `${reason}${extra}`;
    await this.persistSeenIds();

    log.info('sync', 'Sync finished', {
      sync_id: this.session.sync_id,
      new: this.session.new_count,
      updated: this.session.updated_count,
      seen: this.session.seen_count,
    });
    this.broadcast();
  }

  /* --------------------------------------------------------------- helpers */

  private async sendStart(mode: SyncMode): Promise<void> {
    const settings = await loadSettings();
    const config: CollectorConfig = {
      incrementalKnownThreshold: settings.incrementalKnownThreshold,
      emptyRoundLimit: settings.emptyRoundLimit,
      scrollDelayMs: settings.scrollDelayMs,
      scrollStepRatio: settings.scrollStepRatio,
      enableNetworkEnhancement: settings.enableNetworkEnhancement,
    };
    this.isCollectorAlive = true;
    this.post({ type: 'collector/start', mode, config });
  }

  private post(message: BackgroundToCollector): void {
    try {
      this.port?.postMessage(message);
    } catch (error) {
      log.warn('sync', `Could not reach the collector: ${errorMessage(error)}`);
      this.port = null;
    }
  }

  private async updateSession(patch: Partial<SyncSession>): Promise<void> {
    if (!this.session) return;
    this.session = { ...this.session, ...patch, last_activity_at: patch.last_activity_at ?? nowIso() };
    await this.persistSession();
  }

  private async persistSession(): Promise<void> {
    if (!this.session) return;
    try {
      await saveSyncSession(this.session);
    } catch (error) {
      log.error('sync', `Could not persist sync state: ${errorMessage(error)}`);
    }
  }

  private async persistSeenIds(): Promise<void> {
    if (!this.session || this.session.mode !== 'full') return;
    try {
      await setMeta(`full_rescan_seen:${this.session.sync_id}`, [...this.seenIds]);
    } catch (error) {
      log.warn('sync', `Could not checkpoint scanned ids: ${errorMessage(error)}`);
    }
  }

  private broadcast(): void {
    void this.snapshot().then((progress) => {
      for (const listener of this.listeners) {
        try {
          listener(progress);
        } catch {
          /* a broken listener must not break the sync */
        }
      }
    });
  }

  async history(): Promise<SyncSession[]> {
    return getRecentSyncSessions(10);
  }
}
