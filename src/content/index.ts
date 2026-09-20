/**
 * Content script (ISOLATED world).
 *
 * Runs on X, mounts the control panel on the bookmarks page, and drives the
 * collector. It never writes to IndexedDB - the database belongs to the
 * extension's origin, so every record is streamed to the background worker,
 * which persists it before the collector is allowed to scroll on.
 */

import {
  PORT_NAME,
  type BackgroundToCollector,
  type CollectorConfig,
  type CollectorToBackground,
} from '../shared/messages';
import type { BookmarkSource, SyncMode } from '../shared/types';
import { BookmarkCollector, type BatchResult } from '../x/collector';
import { assessPage } from '../x/extractor';
import { ControlPanel } from './panel';

const BOOKMARKS_PATH = /^\/i\/bookmarks/;
const KEEPALIVE_MS = 20_000;

let port: chrome.runtime.Port | null = null;
let collector: BookmarkCollector | null = null;
let keepaliveTimer: number | null = null;
let currentPath = '';

const panel = new ControlPanel({
  onSync: (mode) => void command({ type: 'sync/start', mode }),
  onPause: () => void command({ type: 'sync/pause' }),
  onResume: () => void command({ type: 'sync/resume' }),
  onStop: () => void command({ type: 'sync/stop' }),
  onOpenLibrary: () => void command({ type: 'ui/open-library' }),
});

async function command(request: { type: string; mode?: SyncMode }): Promise<void> {
  try {
    const response = (await chrome.runtime.sendMessage(request)) as
      | { ok: boolean; error?: string }
      | undefined;
    if (response && response.ok === false) {
      panel.update({ status: 'error', error: response.error ?? 'Unknown error' });
    } else {
      panel.update({ error: null });
    }
  } catch (error) {
    panel.update({
      status: 'error',
      error: `Could not reach the extension: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

/* ------------------------------------------------------------------- port */

function connect(): void {
  if (port) return;
  try {
    port = chrome.runtime.connect({ name: PORT_NAME });
  } catch {
    // The extension was reloaded or disabled; the panel stays usable but idle.
    port = null;
    return;
  }

  port.onDisconnect.addListener(() => {
    port = null;
    stopKeepalive();
    collector?.stop();
    collector = null;
  });

  port.onMessage.addListener((message: BackgroundToCollector) => {
    void handleBackgroundMessage(message);
  });

  send({ type: 'collector/hello', url: location.href });
  void seedPanelFromBackground();
}

/** Shows the real library size in the panel before any sync has run. */
async function seedPanelFromBackground(): Promise<void> {
  try {
    const response = (await chrome.runtime.sendMessage({ type: 'sync/progress' })) as
      | { ok: true; data: { total: number; phase: string; session: { status: string } | null } }
      | { ok: false }
      | undefined;
    if (!response || response.ok !== true) return;

    const { total, phase, session } = response.data;
    panel.update({
      total,
      phase: session?.status === 'running' ? phase : 'Ready to sync.',
      status: session?.status === 'running' ? 'running' : session?.status === 'paused' ? 'paused' : 'idle',
    });
  } catch {
    // The panel is still usable without a seeded count.
  }
}

function send(message: CollectorToBackground): void {
  try {
    port?.postMessage(message);
  } catch {
    port = null;
  }
}

function startKeepalive(): void {
  if (keepaliveTimer !== null) return;
  // Regular traffic on the port keeps the MV3 service worker from being torn
  // down in the middle of a long sync.
  keepaliveTimer = window.setInterval(() => send({ type: 'collector/keepalive' }), KEEPALIVE_MS);
}

function stopKeepalive(): void {
  if (keepaliveTimer === null) return;
  window.clearInterval(keepaliveTimer);
  keepaliveTimer = null;
}

/* --------------------------------------------------------------- collector */

async function handleBackgroundMessage(message: BackgroundToCollector): Promise<void> {
  switch (message.type) {
    case 'collector/start':
      await startCollection(message.mode, message.config);
      return;
    case 'collector/pause':
      collector?.pause();
      panel.update({ status: 'paused', phase: 'Paused.' });
      return;
    case 'collector/resume':
      collector?.resume();
      panel.update({ status: 'running', phase: 'Resuming...' });
      return;
    case 'collector/stop':
      collector?.stop();
      panel.update({ status: 'idle', phase: 'Stopped.' });
      return;
    case 'collector/ack':
      panel.update({
        newCount: message.newCount,
        updatedCount: message.updatedCount,
        total: message.total,
      });
      return;
    default:
      return;
  }
}

async function startCollection(mode: SyncMode, config: CollectorConfig): Promise<void> {
  if (collector && collector.getState() === 'running') return;

  panel.mount();
  panel.update({
    status: 'running',
    error: null,
    newCount: 0,
    updatedCount: 0,
    phase: mode === 'full' ? 'Full rescan: scanning from the top...' : 'Scanning for new bookmarks...',
  });
  startKeepalive();

  let pendingAck: ((result: BatchResult) => void) | null = null;

  const ackListener = (message: BackgroundToCollector): void => {
    if (message.type !== 'collector/ack' || !pendingAck) return;
    const resolve = pendingAck;
    pendingAck = null;
    resolve({ stop: message.stop, reason: message.reason });
  };
  port?.onMessage.addListener(ackListener);

  collector = new BookmarkCollector(config, {
    onBatch: (bookmarks: BookmarkSource[], roundIndex: number) =>
      new Promise<BatchResult>((resolve, reject) => {
        if (!port) {
          reject(new Error('Lost the connection to the extension.'));
          return;
        }

        // The next scroll only happens once the background worker has
        // acknowledged that this batch is in the database. A timeout keeps a
        // dropped acknowledgement from stalling the whole sync.
        const timeout = window.setTimeout(() => {
          if (pendingAck !== settle) return; // already acknowledged
          pendingAck = null;
          resolve({ stop: false });
        }, 15_000);

        const settle = (result: BatchResult): void => {
          window.clearTimeout(timeout);
          resolve(result);
        };

        pendingAck = settle;
        send({ type: 'collector/batch', bookmarks, roundIndex });
      }),

    onRound: (info) => {
      send({
        type: 'collector/round',
        seen: info.seen,
        roundIndex: info.roundIndex,
        emptyRounds: info.emptyRounds,
        lastPostId: info.lastPostId,
      });
      panel.update({
        seenCount: info.seen,
        phase:
          info.emptyRounds > 0
            ? `Waiting for X to load more (attempt ${info.emptyRounds})...`
            : 'Scanning older bookmarks...',
      });
    },

    onError: (message, fatal) => {
      send({ type: 'collector/error', message, fatal });
      panel.update(fatal ? { error: message, status: 'error' } : { error: message });
    },

    onFinished: (reason) => {
      send({ type: 'collector/finished', reason });
      stopKeepalive();
      port?.onMessage.removeListener(ackListener);
      panel.update({ status: 'done', phase: reason });
      collector = null;
    },
  });

  await collector.run(mode);
}

/* -------------------------------------------------------- page lifecycle */

function syncPanelWithLocation(): void {
  const path = location.pathname;
  if (path === currentPath) return;
  currentPath = path;

  if (BOOKMARKS_PATH.test(path)) {
    connect();
    panel.mount();

    // X hydrates asynchronously, so a check run the instant the content script
    // loads would report "not logged in" for a page that is merely still
    // rendering. Give it a moment before saying anything alarming.
    window.setTimeout(() => {
      if (!BOOKMARKS_PATH.test(location.pathname)) return;
      const health = assessPage(document);
      if (!health.loggedIn) {
        panel.update({
          status: 'error',
          error: 'You do not appear to be logged in to X. Log in and reload this page.',
        });
      } else if (health.emptyState) {
        panel.update({ phase: 'X reports no bookmarks on this account yet.' });
      }
    }, 2500);
  } else {
    collector?.stop();
    panel.unmount();
  }
}

// X is a single-page app, so navigation never reloads the content script.
// Polling the path is cheaper and more robust than patching history APIs.
window.setInterval(syncPanelWithLocation, 1000);
syncPanelWithLocation();

// Re-attach if the extension is reloaded during development.
window.addEventListener('focus', () => {
  if (BOOKMARKS_PATH.test(location.pathname)) connect();
});
