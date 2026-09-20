/**
 * MV3 background service worker.
 *
 * Owns the IndexedDB database (which lives in the extension's origin, not
 * x.com's), the sync controller and the classification queue. Everything the
 * content script and the UI need goes through the message router below.
 */

import {
  PORT_NAME,
  type BackgroundRequest,
  type BackgroundResponse,
  type BroadcastEvent,
} from '../shared/messages';
import { appendDiagnostic, getAllPostIds, getDiagnostics, openDatabase } from '../database/db';
import { log, setDiagnosticSink } from '../shared/logger';
import { errorMessage } from '../shared/util';
import { SyncController } from './sync-controller';
import { ClassifyRunner } from './classify-runner';

const sync = new SyncController();
const classifier = new ClassifyRunner();

// Diagnostics are written locally to IndexedDB and never leave the browser.
setDiagnosticSink((event) => {
  void appendDiagnostic(event).catch(() => undefined);
});

/** Broadcasts to any open extension page. Absent listeners are not an error. */
function broadcast(event: BroadcastEvent): void {
  chrome.runtime.sendMessage(event).catch(() => undefined);
}

/**
 * Progress is cheap to broadcast, but "the library changed" makes every open
 * page reload and re-index its copy of the library. During a sync that fires
 * once per batch, so it is throttled - except when the run ends, which always
 * produces a final refresh.
 */
const LIBRARY_CHANGE_THROTTLE_MS = 8000;
let lastLibraryBroadcast = 0;

function broadcastLibraryChanged(force: boolean): void {
  const now = Date.now();
  if (!force && now - lastLibraryBroadcast < LIBRARY_CHANGE_THROTTLE_MS) return;
  lastLibraryBroadcast = now;
  broadcast({ type: 'event/bookmarks-changed' });
}

sync.onProgress((progress) => {
  broadcast({ type: 'event/sync-progress', progress });
  broadcastLibraryChanged(progress.session?.status !== 'running');
});

classifier.onProgress((progress) => {
  broadcast({ type: 'event/classify-progress', progress });
  broadcastLibraryChanged(!progress.running);
});

/* ----------------------------------------------------------- port from tab */

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PORT_NAME) return;
  log.info('background', 'Bookmarks collector connected');
  void sync.attach(port);
});

/* ------------------------------------------------------------ message router */

async function handle(request: BackgroundRequest): Promise<unknown> {
  switch (request.type) {
    case 'sync/start':
      return sync.start(request.mode);
    case 'sync/pause':
      return sync.pause();
    case 'sync/resume':
      return sync.resume();
    case 'sync/stop':
      return sync.stop();
    case 'sync/progress':
      return sync.snapshot();

    case 'classify/start':
      return classifier.start(request.scope, request.postIds);
    case 'classify/stop':
      classifier.stop();
      return classifier.getProgress();
    case 'classify/progress':
      return classifier.getProgress();
    case 'classify/test':
      return classifier.test();

    case 'db/known-ids':
      return getAllPostIds();

    case 'ui/open-library': {
      // Content scripts cannot navigate to an extension page themselves
      // without making it web-accessible, so the worker opens the tab.
      const url = chrome.runtime.getURL(`options.html${request.hash ?? '#/library'}`);
      await chrome.tabs.create({ url });
      return true;
    }

    case 'diagnostics/list':
      return getDiagnostics(request.limit ?? 200);
    case 'diagnostics/log':
      await appendDiagnostic(request.event);
      return true;

    default: {
      const exhaustive: never = request;
      throw new Error(`Unknown request: ${JSON.stringify(exhaustive)}`);
    }
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // Broadcast events echo back to the worker; ignore them here.
  if (!message || typeof message !== 'object' || typeof message.type !== 'string') return false;
  if (message.type.startsWith('event/')) return false;

  handle(message as BackgroundRequest)
    .then((data) => sendResponse({ ok: true, data } satisfies BackgroundResponse))
    .catch((error) => {
      const text = errorMessage(error);
      log.error('background', text);
      sendResponse({ ok: false, error: text } satisfies BackgroundResponse);
    });

  // Keeps the message channel open for the async response.
  return true;
});

/* -------------------------------------------------------------- lifecycle */

chrome.runtime.onInstalled.addListener((details) => {
  void (async () => {
    try {
      await openDatabase();
      log.info('background', `Installed / updated (${details.reason})`);
      if (details.reason === 'install') {
        await chrome.tabs.create({ url: chrome.runtime.getURL('options.html#/setup') });
      }
    } catch (error) {
      log.error('background', `Startup failed: ${errorMessage(error)}`);
    }
  })();
});

chrome.runtime.onStartup.addListener(() => {
  void sync.init();
});

// A service worker can be started for any reason; recover state every time.
void (async () => {
  try {
    await openDatabase();
    await sync.init();
  } catch (error) {
    log.error('background', `Could not initialise: ${errorMessage(error)}`);
  }
})();
