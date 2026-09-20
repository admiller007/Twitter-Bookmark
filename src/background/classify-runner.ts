/**
 * Classification queue.
 *
 * Runs JEV over a set of bookmarks with bounded concurrency, checkpointing
 * after every chunk so an interrupted run keeps whatever it finished. One
 * bookmark failing marks only that bookmark as failed - the queue continues.
 */

import type { Bookmark } from '../shared/types';
import type { ClassifyProgress } from '../shared/messages';
import {
  getAllBookmarks,
  getKnownCategories,
  getKnownSubcategories,
  getUnclassifiedIds,
  saveClassifications,
  setClassificationStatus,
} from '../database/db';
import { JevClassifier } from '../classifier/jev';
import {
  ClassifierNotConfiguredError,
  type ClassifierContext,
  type ResilientClassifier,
} from '../classifier/classifier';
import { loadSettings } from '../shared/settings';
import { log } from '../shared/logger';
import { chunk, errorMessage } from '../shared/util';

const CHECKPOINT_CHUNK_SIZE = 20;

export async function buildClassifierContext(): Promise<ClassifierContext> {
  const settings = await loadSettings();
  const categories = await getKnownCategories();
  const subcategoryMap = await getKnownSubcategories();
  const subcategories = [...new Set([...subcategoryMap.values()].flat())];

  return {
    knownCategories: categories.map((c) => c.name),
    knownSubcategories: subcategories,
    seedCategories: settings.seedCategories,
  };
}

/** Builds a configured JEV classifier, or throws if no key is set. */
export async function createClassifier(
  shouldStop: () => boolean = () => false,
): Promise<ResilientClassifier> {
  const settings = await loadSettings();
  if (!settings.jevApiKey) throw new ClassifierNotConfiguredError();

  return new JevClassifier({
    apiKey: settings.jevApiKey,
    baseUrl: settings.jevBaseUrl,
    model: settings.jevModel,
    concurrency: Math.max(1, Math.min(settings.jevConcurrency, 12)),
    maxRetries: Math.max(1, Math.min(settings.jevMaxRetries, 8)),
    context: await buildClassifierContext(),
    shouldStop,
  });
}

export class ClassifyRunner {
  private running = false;
  private stopRequested = false;
  private progress: ClassifyProgress = {
    running: false,
    processed: 0,
    total: 0,
    succeeded: 0,
    failed: 0,
    phase: 'Idle',
    error: null,
  };
  private listeners = new Set<(progress: ClassifyProgress) => void>();

  onProgress(listener: (progress: ClassifyProgress) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getProgress(): ClassifyProgress {
    return { ...this.progress };
  }

  stop(): void {
    this.stopRequested = true;
    this.progress.phase = 'Stopping...';
    this.emit();
  }

  /** Verifies the configured key and endpoint without classifying anything. */
  async test(): Promise<{ model: string }> {
    const classifier = await createClassifier();
    if (!(classifier instanceof JevClassifier)) {
      throw new Error('Configured classifier does not support connection tests.');
    }
    return classifier.testConnection();
  }

  async start(scope: 'unprocessed' | 'selected', postIds?: string[]): Promise<ClassifyProgress> {
    if (this.running) return this.getProgress();

    this.running = true;
    this.stopRequested = false;
    this.progress = {
      running: true,
      processed: 0,
      total: 0,
      succeeded: 0,
      failed: 0,
      phase: 'Preparing...',
      error: null,
    };
    this.emit();

    // Run detached: the caller gets an immediate acknowledgement and follows
    // progress through broadcasts.
    void this.run(scope, postIds).catch((error) => {
      this.progress.error = errorMessage(error);
      this.progress.phase = 'Failed.';
      this.progress.running = false;
      this.running = false;
      log.error('classify', this.progress.error);
      this.emit();
    });

    return this.getProgress();
  }

  private async run(scope: 'unprocessed' | 'selected', postIds?: string[]): Promise<void> {
    try {
      const classifier = await createClassifier(() => this.stopRequested);

      const targetIds =
        scope === 'selected'
          ? (postIds ?? [])
          : await getUnclassifiedIds(true);

      if (targetIds.length === 0) {
        this.progress = {
          ...this.progress,
          running: false,
          phase: 'Nothing to classify - every bookmark already has a classification.',
        };
        this.running = false;
        this.emit();
        return;
      }

      const wanted = new Set(targetIds);
      const all = await getAllBookmarks();
      const targets = all.filter((bookmark) => wanted.has(bookmark.post_id));

      this.progress.total = targets.length;
      this.progress.phase = `Classifying ${targets.length} bookmark(s) with JEV...`;
      this.emit();

      for (const batch of chunk(targets, CHECKPOINT_CHUNK_SIZE)) {
        if (this.stopRequested) break;

        await setClassificationStatus(
          batch.map((b) => b.post_id),
          'pending',
        );

        const outcomes = await classifier.classifyDetailed(batch, () => {
          this.progress.processed += 1;
          this.emit();
        });

        const succeeded = outcomes
          .filter((o) => o.ok && o.classification)
          .map((o) => o.classification!);

        // Checkpoint: persist this chunk before starting the next one.
        if (succeeded.length > 0) {
          await saveClassifications(succeeded, classifier.version);
          this.progress.succeeded += succeeded.length;
        }

        const failures = outcomes.filter((o) => !o.ok);
        for (const failure of failures) {
          await setClassificationStatus(
            [failure.postId],
            'failed',
            failure.error ?? 'Unknown classification error',
          );
          log.warn('classify', `Classification failed for ${failure.postId}`, {
            reason: failure.error ?? 'unknown',
          });
        }
        this.progress.failed += failures.length;

        this.emit();
      }

      // Anything left "pending" after a stop goes back to unclassified.
      if (this.stopRequested) {
        const stillPending = await getUnclassifiedIds(false);
        if (stillPending.length > 0) await setClassificationStatus(stillPending, 'unclassified');
      }

      this.progress.running = false;
      this.progress.phase = this.stopRequested
        ? `Stopped. ${this.progress.succeeded} classified, ${this.progress.failed} failed.`
        : `Done. ${this.progress.succeeded} classified, ${this.progress.failed} failed.`;
      this.running = false;
      this.emit();

      log.info('classify', this.progress.phase);
    } finally {
      this.running = false;
      this.progress.running = false;
      this.emit();
    }
  }

  private emit(): void {
    const snapshot = this.getProgress();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        /* ignore broken listeners */
      }
    }
  }
}

/** Convenience used by the UI for a one-off classification of a Bookmark[]. */
export async function classifyBookmarksNow(bookmarks: Bookmark[]): Promise<number> {
  const classifier = await createClassifier();
  const outcomes = await classifier.classifyDetailed(bookmarks);
  const ok = outcomes.filter((o) => o.ok && o.classification).map((o) => o.classification!);
  if (ok.length > 0) await saveClassifications(ok, classifier.version);
  return ok.length;
}
