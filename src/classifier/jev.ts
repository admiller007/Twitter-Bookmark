/**
 * JEV classifier adapter (TypeSafe System One).
 *
 * JEV is reachable by two routes, selected in Settings:
 *
 *   OpenRouter   POST https://openrouter.ai/api/v1/api/alpha/decisions
 *                model "typesafe/jev-1.13", billed to OpenRouter credits
 *   TypeSafe     POST https://api.typesafe.ai/v1/systemone
 *                model "jev-latest", billed to a TypeSafe account
 *
 * Both speak the same Decisions API - `{ model, state, questions }` in, typed
 * `answers` out - so only the endpoint, the model slug and the error envelope
 * differ. The question template, validation and repair logic are shared.
 *
 * The API evaluates one state per request, so "batching" here means a bounded
 * number of bookmarks in flight at once rather than many states per call.
 * Adding more questions to a single call is nearly free, which is why the tag
 * votes ride along with the main classification questions.
 *
 * Retryable failures (429, 5xx, 529, network) back off exponentially with
 * jitter. A bad key, exhausted credits or an oversized payload are reported
 * straight away, because retrying them cannot help.
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
import {
  DEFAULT_JEV_PROVIDER,
  getProvider,
  providerUrls,
  type JevProviderId,
} from './providers';

export interface JevClassifierOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  /** Which route to JEV. Defaults to OpenRouter. */
  provider?: JevProviderId;
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

// Transient failures worth another attempt. 524 and 529 are the timeout and
// provider-overloaded codes OpenRouter documents for the Decisions API.
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 524, 529]);

export class JevClassifier implements ResilientClassifier {
  readonly version: string;

  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private readonly providerId: JevProviderId;
  /** Endpoints to try, in order. More than one only for an alpha endpoint. */
  private readonly candidateUrls: string[];
  /** The endpoint that last answered with something other than 404. */
  private resolvedUrl: string | null = null;

  constructor(private readonly options: JevClassifierOptions) {
    this.version = `${options.model}/${PROMPT_VERSION}`;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.sleepImpl = options.sleepImpl ?? sleep;
    this.providerId = options.provider ?? DEFAULT_JEV_PROVIDER;

    const profile = getProvider(this.providerId);
    const known = providerUrls(profile);
    // A URL the user typed themselves is used exactly as given; only a
    // recognised provider URL may fall back to that provider's other paths.
    this.candidateUrls = known.includes(options.baseUrl)
      ? [options.baseUrl, ...known.filter((url) => url !== options.baseUrl)]
      : [options.baseUrl];
  }

  /** The endpoint actually in use, once one has answered. */
  get endpoint(): string {
    return this.resolvedUrl ?? this.candidateUrls[0] ?? this.options.baseUrl;
  }

  /** Minimal live check used by the "Test connection" button in Settings. */
  async testConnection(): Promise<{ model: string; endpoint: string; provider: JevProviderId }> {
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
    return {
      model: typeof response.model === 'string' ? response.model : this.options.model,
      endpoint: this.endpoint,
      provider: this.providerId,
    };
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

      const outcome = await this.attempt(body);
      if (outcome.kind === 'ok') return outcome.data;
      if (outcome.kind === 'fatal') throw outcome.error;
      lastError = outcome.error;
    }

    throw lastError instanceof Error
      ? lastError
      : new Error('JEV request failed after all retries.');
  }

  /**
   * One pass over the candidate endpoints.
   *
   * A 404 from a recognised provider URL means the path moved rather than the
   * request being wrong, so the next known path is tried immediately and the
   * one that answers is remembered for the rest of the run.
   */
  private async attempt(body: JevRequestBody): Promise<
    | { kind: 'ok'; data: { model?: string; answers?: Record<string, unknown> } }
    | { kind: 'retry'; error: unknown }
    | { kind: 'fatal'; error: Error }
  > {
    const urls = this.resolvedUrl ? [this.resolvedUrl] : this.candidateUrls;
    let lastRetryable: unknown = null;

    for (const url of urls) {
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.options.apiKey}`,
          },
          body: JSON.stringify(body),
        });
      } catch (error) {
        // Network-level failure: worth another attempt.
        lastRetryable = new Error(`Could not reach the JEV API: ${errorMessage(error)}`);
        continue;
      }

      if (response.status === 404 && urls.length > 1) {
        lastRetryable = new Error(`JEV endpoint ${url} returned 404.`);
        continue;
      }

      // This path exists; stop probing the alternatives.
      this.resolvedUrl = url;

      if (response.ok) {
        try {
          return {
            kind: 'ok',
            data: (await response.json()) as {
              model?: string;
              answers?: Record<string, unknown>;
            },
          };
        } catch (error) {
          return {
            kind: 'retry',
            error: new ClassifierMalformedResponseError(
              `JEV returned a body that is not valid JSON: ${errorMessage(error)}`,
            ),
          };
        }
      }

      const detail = await readErrorDetail(response);
      const classified = classifyHttpFailure(response.status, detail, this.providerId);

      if (classified.kind === 'fatal') return classified;
      if (classified.kind === 'rate-limit') {
        const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
        if (retryAfter) await this.sleepImpl(retryAfter);
        return {
          kind: 'retry',
          error: new ClassifierRateLimitError(classified.message, retryAfter),
        };
      }
      return { kind: 'retry', error: new Error(classified.message) };
    }

    return {
      kind: 'retry',
      error:
        lastRetryable ??
        new Error(
          `None of the configured JEV endpoints responded: ${this.candidateUrls.join(', ')}`,
        ),
    };
  }
}

/**
 * Maps an HTTP failure onto "give up" or "try again".
 *
 * Retrying a rejected key, an empty balance or an oversized payload cannot
 * help, so those surface immediately with something the user can act on. The
 * API key is never included in any message.
 */
function classifyHttpFailure(
  status: number,
  detail: string,
  provider: JevProviderId,
):
  | { kind: 'fatal'; error: Error }
  | { kind: 'rate-limit'; message: string }
  | { kind: 'retry'; message: string } {
  const via = provider === 'openrouter' ? 'OpenRouter' : 'TypeSafe';

  if (status === 401 || status === 403) {
    return {
      kind: 'fatal',
      error: new Error(
        `${via} rejected the API key (HTTP ${status}). Check the key in Settings.`,
      ),
    };
  }
  if (status === 402) {
    return {
      kind: 'fatal',
      error: new Error(
        `${via} reports insufficient credits (HTTP 402). Top up your account, then run the classification again.`,
      ),
    };
  }
  if (status === 400 || status === 422) {
    return {
      kind: 'fatal',
      error: new ClassifierMalformedResponseError(
        `${via} rejected the request as invalid (HTTP ${status}): ${detail}`,
      ),
    };
  }
  if (status === 413) {
    return {
      kind: 'fatal',
      error: new Error(
        `${via} rejected the request as too large (HTTP 413). Reduce the number of seed categories in Settings, which shortens the payload.`,
      ),
    };
  }
  if (status === 404) {
    return {
      kind: 'fatal',
      error: new Error(
        `${via} returned 404 for the configured endpoint. Check the API endpoint in Settings.`,
      ),
    };
  }
  if (status === 429) {
    return {
      kind: 'rate-limit',
      message: `${via} rate limit reached. The extension is backing off and will retry.`,
    };
  }
  if (RETRYABLE_STATUS.has(status)) {
    return { kind: 'retry', message: `${via} returned HTTP ${status}: ${detail}` };
  }

  return {
    kind: 'fatal',
    error: new Error(`${via} returned HTTP ${status}: ${detail}`),
  };
}

/**
 * Pulls a human-readable reason out of an error body. OpenRouter wraps errors
 * as { error: { code, message } }; TypeSafe returns a plain body.
 */
async function readErrorDetail(response: Response): Promise<string> {
  const text = await safeText(response);
  if (!text) return '(no response body)';

  try {
    const parsed = JSON.parse(text) as { error?: { message?: unknown }; message?: unknown };
    const message = parsed?.error?.message ?? parsed?.message;
    if (typeof message === 'string' && message.length > 0) return message.slice(0, 400);
  } catch {
    // Not JSON; fall through to the raw text.
  }
  return text;
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
