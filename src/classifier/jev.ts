/**
 * JEV classifier adapter (TypeSafe System One).
 *
 *   POST {baseUrl}            default https://api.typesafe.ai/v1/systemone
 *   Authorization: Bearer <API_KEY>
 *   { model, state, questions }  ->  { model, answers, usage }
 *
 * The API evaluates one state per request, so "batching" here means a bounded
 * number of bookmarks in flight at once rather than many states per call.
 * Adding more questions to a single call is nearly free, which is why the tag
 * votes ride along with the main classification questions.
 *
 * Documented failure codes: 401 invalid key, 422 validation, 429 rate limit,
 * 529 overloaded. 429/529/5xx are retried with exponential backoff and jitter.
 */

import type { Bookmark, BookmarkClassification } from '../shared/types';
import { errorMessage, mapWithConcurrency, sleep } from '../shared/util';
import {
  ClassifierMalformedResponseError,
  ClassifierNotConfiguredError,
  ClassifierRateLimitError,
  type ClassifierContext,
  type ClassifyOutcome,
  type ResilientClassifier,
} from './classifier';
import { PROMPT_VERSION, buildRepairBody, buildRequestBody, type JevRequestBody } from './prompt';
import { validateJevResponse } from './validate';

export interface JevClassifierOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  concurrency: number;
  maxRetries: number;
  context: ClassifierContext;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests. */
  sleepImpl?: (ms: number) => Promise<void>;
  /** Cooperative cancellation. */
  shouldStop?: () => boolean;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 529]);

export class JevClassifier implements ResilientClassifier {
  readonly version: string;

  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number) => Promise<void>;

  constructor(private readonly options: JevClassifierOptions) {
    this.version = `${options.model}/${PROMPT_VERSION}`;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.sleepImpl = options.sleepImpl ?? sleep;
  }

  /** Minimal live check used by the "Test connection" button in Settings. */
  async testConnection(): Promise<{ model: string }> {
    this.assertConfigured();
    const body: JevRequestBody = {
      model: this.options.model,
      state: { probe: 'X Bookmark Vault connection test' },
      questions: {
        ok: {
          type: 'noul',
          instructions: 'Is this a connection test?',
          criteria: { true: 'It is a connection test.', false: 'It is not.' },
        },
      },
    };
    const response = await this.post(body);
    return { model: typeof response.model === 'string' ? response.model : this.options.model };
  }

  async classify(bookmarks: Bookmark[]): Promise<BookmarkClassification[]> {
    const outcomes = await this.classifyDetailed(bookmarks);
    return outcomes
      .filter((o): o is ClassifyOutcome & { classification: BookmarkClassification } =>
        Boolean(o.ok && o.classification),
      )
      .map((o) => o.classification);
  }

  /**
   * Classifies with bounded concurrency. One bookmark failing never stops the
   * others: its outcome is returned with ok: false and an error message.
   */
  async classifyDetailed(
    bookmarks: Bookmark[],
    onProgress?: (done: number, total: number) => void,
  ): Promise<ClassifyOutcome[]> {
    this.assertConfigured();

    let done = 0;
    const total = bookmarks.length;

    return mapWithConcurrency(bookmarks, this.options.concurrency, async (bookmark) => {
      if (this.options.shouldStop?.()) {
        return { postId: bookmark.post_id, ok: false, error: 'Classification stopped.' };
      }

      let outcome: ClassifyOutcome;
      try {
        const classification = await this.classifyOne(bookmark);
        outcome = { postId: bookmark.post_id, ok: true, classification };
      } catch (error) {
        outcome = { postId: bookmark.post_id, ok: false, error: errorMessage(error) };
      }

      done += 1;
      onProgress?.(done, total);
      return outcome;
    });
  }

  private assertConfigured(): void {
    if (!this.options.apiKey) throw new ClassifierNotConfiguredError();
  }

  private async classifyOne(bookmark: Bookmark): Promise<BookmarkClassification> {
    const { body, built } = buildRequestBody(bookmark, this.options.context, this.options.model);
    const response = await this.post(body);

    try {
      return validateJevResponse({ bookmark, built, response });
    } catch (error) {
      if (!(error instanceof ClassifierMalformedResponseError)) throw error;

      // One repair pass: re-ask only the questions that could not be read,
      // then merge the repaired answers over the originals.
      const repairBody = buildRepairBody(body, error.failedKeys);
      if (Object.keys(repairBody.questions).length === 0) throw error;

      const repaired = await this.post(repairBody);
      const merged = {
        ...response,
        answers: { ...(response.answers ?? {}), ...(repaired.answers ?? {}) },
      };
      return validateJevResponse({ bookmark, built, response: merged });
    }
  }

  private async post(body: JevRequestBody): Promise<{
    model?: string;
    answers?: Record<string, unknown>;
  }> {
    const maxAttempts = Math.max(1, this.options.maxRetries);
    let lastError: unknown = null;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (attempt > 0) {
        // Exponential backoff with jitter: 500ms, 1s, 2s, 4s ... capped.
        const base = Math.min(500 * 2 ** (attempt - 1), 15_000);
        await this.sleepImpl(base + Math.random() * 250);
      }
      if (this.options.shouldStop?.()) throw new Error('Classification stopped.');

      let response: Response;
      try {
        response = await this.fetchImpl(this.options.baseUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.options.apiKey}`,
          },
          body: JSON.stringify(body),
        });
      } catch (error) {
        // Network-level failure: worth another attempt.
        lastError = new Error(`Could not reach the JEV API: ${errorMessage(error)}`);
        continue;
      }

      if (response.ok) {
        try {
          return (await response.json()) as { model?: string; answers?: Record<string, unknown> };
        } catch (error) {
          lastError = new ClassifierMalformedResponseError(
            `JEV returned a body that is not valid JSON: ${errorMessage(error)}`,
          );
          continue;
        }
      }

      const detail = await safeText(response);

      if (response.status === 401 || response.status === 403) {
        // Never retried: the key is wrong, and the key itself is never logged.
        throw new Error(
          'JEV rejected the API key (HTTP ' + response.status + '). Check the key in Settings.',
        );
      }
      if (response.status === 422) {
        throw new ClassifierMalformedResponseError(
          `JEV rejected the request as invalid (422): ${detail}`,
        );
      }
      if (response.status === 429) {
        const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
        lastError = new ClassifierRateLimitError(
          'JEV rate limit reached. The extension is backing off and will retry.',
          retryAfter,
        );
        if (retryAfter) await this.sleepImpl(retryAfter);
        continue;
      }
      if (RETRYABLE_STATUS.has(response.status)) {
        lastError = new Error(`JEV returned HTTP ${response.status}: ${detail}`);
        continue;
      }

      throw new Error(`JEV returned HTTP ${response.status}: ${detail}`);
    }

    throw lastError instanceof Error
      ? lastError
      : new Error('JEV request failed after all retries.');
  }
}

function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number.parseFloat(header);
  if (Number.isFinite(seconds)) return Math.min(Math.max(seconds, 0), 60) * 1000;
  const date = Date.parse(header);
  if (Number.isNaN(date)) return null;
  return Math.min(Math.max(date - Date.now(), 0), 60_000);
}

async function safeText(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.slice(0, 400);
  } catch {
    return '(no response body)';
  }
}
