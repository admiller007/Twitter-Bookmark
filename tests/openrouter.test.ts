import { describe, expect, it, vi } from 'vitest';
import { JevClassifier } from '../src/classifier/jev';
import type { ClassifierContext } from '../src/classifier/classifier';
import {
  DEFAULT_JEV_PROVIDER,
  JEV_PROVIDERS,
  getProvider,
  inferProviderFromUrl,
  providerUrls,
} from '../src/classifier/providers';
import { buildQuestions } from '../src/classifier/prompt';
import { makeBookmark } from './helpers';

const context: ClassifierContext = {
  knownCategories: ['AI'],
  knownSubcategories: ['Agents'],
  seedCategories: ['Coding'],
};

const bookmark = makeBookmark({
  post_id: '123456789012',
  text: 'A Mac assistant that picks the next click for you.',
  author_handle: 'coreyganim',
});

/** An OpenRouter Decisions response, as the API reference documents it. */
function openRouterResponse(): Record<string, unknown> {
  const { tagKeys } = buildQuestions(bookmark, context);
  const answers: Record<string, unknown> = {
    category: { type: 'choice', choice: 'AI', confidence: 0.9, probabilities: { AI: 0.9 } },
    subcategory: { type: 'choice', choice: 'Agents', confidence: 0.8 },
    content_type: { type: 'choice', choice: 'tool', confidence: 0.8 },
    actionable: { type: 'noul', noul: 0.91 },
    revisit: { type: 'score', score: 3.6, confidence: 0.7, legend: {}, probabilities: {} },
    reason: { type: 'choice', choice: 'try_tool', confidence: 0.7 },
  };
  for (const key of tagKeys.keys()) answers[key] = { type: 'noul', noul: 0.8 };

  return {
    id: 'gen-dec-abc123',
    model: 'typesafe/jev-1.13-20260917',
    provider: 'TypeSafe',
    answers,
    usage: { input_tokens: 812, output_tokens: 0, cost: 0.000034 },
  };
}

function ok(): Response {
  return new Response(JSON.stringify(openRouterResponse()), { status: 200 });
}

/** OpenRouter wraps failures as { error: { code, message } }. */
function orError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { code: status, message } }), { status });
}

const base = {
  apiKey: 'sk-or-v1-test',
  baseUrl: JEV_PROVIDERS.openrouter.defaultBaseUrl,
  model: JEV_PROVIDERS.openrouter.defaultModel,
  provider: 'openrouter' as const,
  concurrency: 2,
  maxRetries: 3,
  context,
  sleepImpl: async () => undefined,
};

describe('provider profiles', () => {
  it('defaults to OpenRouter', () => {
    expect(DEFAULT_JEV_PROVIDER).toBe('openrouter');
    expect(getProvider(undefined).id).toBe('openrouter');
  });

  it('uses the documented OpenRouter endpoint and model slug', () => {
    expect(JEV_PROVIDERS.openrouter.defaultBaseUrl).toBe(
      'https://openrouter.ai/api/v1/api/alpha/decisions',
    );
    expect(JEV_PROVIDERS.openrouter.defaultModel).toBe('typesafe/jev-1.13');
    expect(JEV_PROVIDERS.openrouter.modelOptions).toContain('~typesafe/jev-latest');
  });

  it('keeps the direct TypeSafe route available', () => {
    expect(JEV_PROVIDERS.typesafe.defaultBaseUrl).toBe('https://api.typesafe.ai/v1/systemone');
    expect(JEV_PROVIDERS.typesafe.defaultModel).toBe('jev-latest');
    expect(providerUrls(JEV_PROVIDERS.typesafe)).toHaveLength(1);
  });

  it('infers the route from a previously saved endpoint', () => {
    expect(inferProviderFromUrl('https://openrouter.ai/api/v1/api/alpha/decisions')).toBe(
      'openrouter',
    );
    expect(inferProviderFromUrl('https://api.typesafe.ai/v1/systemone')).toBe('typesafe');
    expect(inferProviderFromUrl('https://gateway.internal/decisions')).toBeNull();
    expect(inferProviderFromUrl(undefined)).toBeNull();
  });
});

describe('JevClassifier over OpenRouter', () => {
  it('posts the Decisions payload to the OpenRouter endpoint with a bearer key', async () => {
    const fetchImpl = vi.fn(async () => ok());
    const classifier = new JevClassifier({ ...base, fetchImpl });

    const [classification] = await classifier.classify([bookmark]);
    expect(classification?.category).toBe('AI');

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://openrouter.ai/api/v1/api/alpha/decisions');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer sk-or-v1-test');

    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body['model']).toBe('typesafe/jev-1.13');
    expect(body).toHaveProperty('state');
    expect(body).toHaveProperty('questions');
  });

  it('parses an OpenRouter response, which carries extra envelope fields', async () => {
    const classifier = new JevClassifier({ ...base, fetchImpl: vi.fn(async () => ok()) });
    const [classification] = await classifier.classify([bookmark]);

    expect(classification?.subcategory).toBe('Agents');
    expect(classification?.contentType).toBe('tool');
    expect(classification?.actionable).toBe(true);
    expect(classification?.revisitScore).toBeCloseTo(0.9, 2);
  });

  it('sends no attribution or identifying headers', async () => {
    const fetchImpl = vi.fn(async () => ok());
    await new JevClassifier({ ...base, fetchImpl }).classify([bookmark]);

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(Object.keys(init.headers as Record<string, string>).sort()).toEqual([
      'Authorization',
      'Content-Type',
    ]);
  });

  it('falls back to the alternate alpha path when the documented one 404s', async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url === JEV_PROVIDERS.openrouter.defaultBaseUrl
        ? new Response('not found', { status: 404 })
        : ok(),
    );

    const classifier = new JevClassifier({
      ...base,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const [classification] = await classifier.classify([bookmark]);

    expect(classification?.category).toBe('AI');
    expect(fetchImpl.mock.calls.map((call) => call[0])).toEqual([
      'https://openrouter.ai/api/v1/api/alpha/decisions',
      'https://openrouter.ai/api/alpha/decisions',
    ]);
    expect(classifier.endpoint).toBe('https://openrouter.ai/api/alpha/decisions');
  });

  it('remembers the working endpoint instead of probing on every request', async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url === JEV_PROVIDERS.openrouter.defaultBaseUrl
        ? new Response('not found', { status: 404 })
        : ok(),
    );

    const classifier = new JevClassifier({
      ...base,
      concurrency: 1,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await classifier.classifyDetailed([
      makeBookmark({ post_id: '111111111111' }),
      makeBookmark({ post_id: '222222222222' }),
      makeBookmark({ post_id: '333333333333' }),
    ]);

    // One probe, then three successful calls on the resolved path.
    const probes = fetchImpl.mock.calls.filter(
      (call) => call[0] === JEV_PROVIDERS.openrouter.defaultBaseUrl,
    );
    expect(probes).toHaveLength(1);
  });

  it('never redirects a custom endpoint the user typed themselves', async () => {
    const fetchImpl = vi.fn(async () => new Response('not found', { status: 404 }));
    const classifier = new JevClassifier({
      ...base,
      baseUrl: 'https://gateway.internal/decisions',
      fetchImpl,
    });

    const [outcome] = await classifier.classifyDetailed([bookmark]);
    expect(outcome?.ok).toBe(false);
    const requestedUrls = fetchImpl.mock.calls.map(
      (call) => (call as unknown as [string])[0],
    );
    expect(new Set(requestedUrls)).toEqual(new Set(['https://gateway.internal/decisions']));
    expect(outcome?.error).toContain('404');
  });

  it('reports exhausted credits immediately rather than retrying', async () => {
    const fetchImpl = vi.fn(async () => orError(402, 'Insufficient credits'));
    const classifier = new JevClassifier({ ...base, fetchImpl });

    const [outcome] = await classifier.classifyDetailed([bookmark]);
    expect(outcome?.ok).toBe(false);
    expect(outcome?.error).toContain('insufficient credits');
    expect(outcome?.error).toContain('OpenRouter');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('surfaces the message OpenRouter put inside its error envelope', async () => {
    const classifier = new JevClassifier({
      ...base,
      fetchImpl: vi.fn(async () => orError(400, 'questions must not be empty')),
    });

    const [outcome] = await classifier.classifyDetailed([bookmark]);
    expect(outcome?.error).toContain('questions must not be empty');
  });

  it('explains an oversized payload instead of retrying it', async () => {
    const fetchImpl = vi.fn(async () => orError(413, 'Payload too large'));
    const classifier = new JevClassifier({ ...base, fetchImpl });

    const [outcome] = await classifier.classifyDetailed([bookmark]);
    expect(outcome?.error).toContain('too large');
    expect(outcome?.error).toContain('seed categories');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('never echoes the OpenRouter key in an error', async () => {
    const classifier = new JevClassifier({
      ...base,
      fetchImpl: vi.fn(async () => orError(401, 'No auth credentials found')),
    });

    const [outcome] = await classifier.classifyDetailed([bookmark]);
    expect(outcome?.error).not.toContain('sk-or-v1-test');
    expect(outcome?.error).toContain('Check the key in Settings');
  });

  it('retries the upstream-failure codes OpenRouter documents', async () => {
    for (const status of [502, 503, 524, 529]) {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(orError(status, 'upstream unhappy'))
        .mockResolvedValueOnce(ok());

      const classifier = new JevClassifier({
        ...base,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      const results = await classifier.classify([bookmark]);

      expect(results, `status ${status} should be retried`).toHaveLength(1);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    }
  });

  it('reports the route and endpoint from a connection test', async () => {
    const classifier = new JevClassifier({ ...base, fetchImpl: vi.fn(async () => ok()) });
    const result = await classifier.testConnection();

    expect(result.provider).toBe('openrouter');
    expect(result.endpoint).toBe('https://openrouter.ai/api/v1/api/alpha/decisions');
    expect(result.model).toBe('typesafe/jev-1.13-20260917');
  });

  it('labels errors with the direct route when that provider is selected', async () => {
    const classifier = new JevClassifier({
      ...base,
      provider: 'typesafe',
      baseUrl: JEV_PROVIDERS.typesafe.defaultBaseUrl,
      model: JEV_PROVIDERS.typesafe.defaultModel,
      fetchImpl: vi.fn(async () => new Response('nope', { status: 401 })),
    });

    const [outcome] = await classifier.classifyDetailed([bookmark]);
    expect(outcome?.error).toContain('TypeSafe');
    expect(outcome?.error).not.toContain('OpenRouter');
  });
});
