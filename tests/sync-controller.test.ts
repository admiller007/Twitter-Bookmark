import { beforeEach, describe, expect, it } from 'vitest';
import { SyncController } from '../src/background/sync-controller';
import {
  getAllBookmarks,
  resetDatabaseHandle,
  upsertBookmarks,
} from '../src/database/db';
import { DB_NAME } from '../src/database/schema';
import { saveSettings } from '../src/shared/settings';
import type {
  BackgroundToCollector,
  CollectorToBackground,
} from '../src/shared/messages';
import { makeSource } from './helpers';

const IDS = ['111111111111', '222222222222', '333333333333'];

/** Stands in for the port the content script connects over. */
class FakePort {
  readonly sent: BackgroundToCollector[] = [];
  private messageListeners: Array<(message: CollectorToBackground) => void> = [];
  private disconnectListeners: Array<() => void> = [];

  readonly onMessage = {
    addListener: (listener: (message: CollectorToBackground) => void): void => {
      this.messageListeners.push(listener);
    },
  };

  readonly onDisconnect = {
    addListener: (listener: () => void): void => {
      this.disconnectListeners.push(listener);
    },
  };

  postMessage(message: BackgroundToCollector): void {
    this.sent.push(message);
  }

  /** Delivers a collector message the way the runtime would. */
  deliver(message: CollectorToBackground): void {
    for (const listener of this.messageListeners) listener(message);
  }
}

async function freshDatabase(): Promise<void> {
  resetDatabaseHandle();
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => resolve();
  });
}

/** Waits for the controller's asynchronous message handling to settle. */
async function waitFor(predicate: () => Promise<boolean> | boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error('Timed out waiting for the controller');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function bookmarkedFlags(): Promise<Record<string, boolean>> {
  const all = await getAllBookmarks();
  return Object.fromEntries(all.map((b) => [b.post_id, b.is_currently_bookmarked]));
}

/** A full rescan that saw only the first of the three stored bookmarks. */
async function runPartialFullRescan(): Promise<{
  controller: SyncController;
  port: FakePort;
}> {
  const controller = new SyncController();
  const port = new FakePort();
  await controller.attach(port as unknown as chrome.runtime.Port);
  await controller.start('full');

  port.deliver({
    type: 'collector/batch',
    bookmarks: [makeSource({ post_id: IDS[0] as string })],
    roundIndex: 0,
  });
  await waitFor(() => port.sent.some((message) => message.type === 'collector/ack'));

  return { controller, port };
}

beforeEach(async () => {
  await freshDatabase();
  await chrome.storage.local.clear();
  await upsertBookmarks(IDS.map((post_id) => makeSource({ post_id })));
  // Deletion detection is opt-in; every case here has the user opting in.
  await saveSettings({ detectUnbookmarkedOnFullRescan: true });
});

describe('SyncController deletion detection', () => {
  it('flags bookmarks it did not see when the rescan reached the end', async () => {
    const { controller, port } = await runPartialFullRescan();

    port.deliver({
      type: 'collector/finished',
      reason: 'Reached the end of your bookmarks.',
      reachedEnd: true,
    });
    await waitFor(async () => (await controller.snapshot()).session?.status === 'completed');

    expect(await bookmarkedFlags()).toEqual({
      [IDS[0] as string]: true,
      [IDS[1] as string]: false,
      [IDS[2] as string]: false,
    });
  });

  it('flags nothing when the rescan gave up before the end of the timeline', async () => {
    const { controller, port } = await runPartialFullRescan();

    port.deliver({
      type: 'collector/finished',
      reason: 'No new bookmarks appeared after several attempts.',
      reachedEnd: false,
    });
    await waitFor(async () => (await controller.snapshot()).session?.finished_at !== null);

    // The unseen bookmarks were simply never reached, which is not evidence
    // that they were removed on X.
    expect(await bookmarkedFlags()).toEqual({
      [IDS[0] as string]: true,
      [IDS[1] as string]: true,
      [IDS[2] as string]: true,
    });
    expect((await controller.snapshot()).phase).toContain('nothing was marked');
  });

  it('flags nothing when the user stops the rescan, and records it as stopped', async () => {
    const { controller, port } = await runPartialFullRescan();

    await controller.stop();
    port.deliver({ type: 'collector/finished', reason: 'Sync stopped.', reachedEnd: false });
    await waitFor(async () => (await controller.snapshot()).session?.finished_at !== null);

    expect(await bookmarkedFlags()).toEqual({
      [IDS[0] as string]: true,
      [IDS[1] as string]: true,
      [IDS[2] as string]: true,
    });
    // A stopped run is not a completed one.
    expect((await controller.snapshot()).session?.status).toBe('stopped');
  });

  it('never sweeps after an incremental sync, however it ended', async () => {
    const controller = new SyncController();
    const port = new FakePort();
    await controller.attach(port as unknown as chrome.runtime.Port);
    await controller.start('incremental');

    port.deliver({
      type: 'collector/finished',
      reason: 'Reached the end of your bookmarks.',
      reachedEnd: true,
    });
    await waitFor(async () => (await controller.snapshot()).session?.status === 'completed');

    expect(await bookmarkedFlags()).toEqual({
      [IDS[0] as string]: true,
      [IDS[1] as string]: true,
      [IDS[2] as string]: true,
    });
  });
});
