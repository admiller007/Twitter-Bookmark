import { describe, expect, it, vi } from 'vitest';
import { JevClassifier } from '../src/classifier/jev';
import {
  ClassifierMalformedResponseError,
  ClassifierNotConfiguredError,
  type ClassifierContext,
} from '../src/classifier/classifier';
import {
  buildQuestions,
  buildRequestBody,
  buildState,
  PROMPT_VERSION,
  REVISIT_LEVELS,
} from '../src/classifier/prompt';
import { isValidClassification, normalizeScore, validateJevResponse } from '../src/classifier/validate';
import { deriveSummary } from '../src/classifier/taxonomy';
import { makeBookmark } from './helpers';

const context: ClassifierContext = {
  knownCategories: ['AI', 'Developer Tools'],
  knownSubcategories: ['Agents', 'Frontend'],
  seedCategories: ['3D Printing', 'Chicago'],
};

const bookmark = makeBookmark({
  post_id: '123456789012',
  text: 'A Mac assistant that picks the next click for you. Built on an agentic loop.',
  author_handle: 'coreyganim',
  author_name: 'Corey Ganim',
  external_urls: ['https://github.com/example/tool?ref=x'],
  image_urls: ['https://pbs.twimg.com/media/abc'],
});

function fullAnswers(): Record<string, unknown> {
  const { tagKeys } = buildQuestions(bookmark, context);
  const answers: Record<string, unknown> = {
    category: { type: 'choice', choice: 'AI', confidence: 0.91, probabilities: { AI: 0.91 } },
    subcategory: { type: 'choice', choice: 'Agents', confidence: 0.8 },
    content_type: { type: 'choice', choice: 'tool', confidence: 0.77 },
    actionable: { type: 'noul', noul: 0.88 },
    revisit: { type: 'score', score: 3.68, confidence: 0.7 },
    reason: { type: 'choice', choice: 'try_tool', confidence: 0.74 },
  };
  for (const key of tagKeys.keys()) answers[key] = { type: 'noul', noul: 0.9 };
  return answers;
}

describe('prompt construction', () => {
  it('sends only the documented fields', () => {
    const state = buildState(bookmark, context);
    expect(Object.keys(state).sort()).toEqual(
      [
        'author_handle',
        'author_name',
        'engagement',
        'existing_categories_in_library',
        'has_images',
        'has_video',
        'image_count',
        'is_reply',
        'linked_domains',
        'post_text',
      ].sort(),
    );
  });

  it('sends link hostnames rather than full URLs', () => {
    const state = buildState(bookmark, context);
    expect(state['linked_domains']).toEqual(['github.com']);
    expect(JSON.stringify(state)).not.toContain('?ref=x');
  });

  it('never sends personal notes, manual tags or favourites', () => {
    const personal = makeBookmark({
      post_id: '123456789012',
      personal_note: 'SECRET-NOTE',
      manual_tags: ['SECRET-TAG'],
      favorite: true,
    });
    const serialized = JSON.stringify(buildState(personal, context));
    expect(serialized).not.toContain('SECRET-NOTE');
    expect(serialized).not.toContain('SECRET-TAG');
    expect(serialized).not.toContain('favorite');
  });

  it('offers existing library categories before seeds so labels get reused', () => {
    const { categoryOptions } = buildQuestions(bookmark, context);
    expect(categoryOptions.slice(0, 2)).toEqual(['AI', 'Developer Tools']);
    expect(categoryOptions).toContain('3D Printing');
    expect(categoryOptions).toContain('Other');
    expect(categoryOptions.length).toBeLessThanOrEqual(250);
  });

  it('builds only valid JEV primitives', () => {
    const { questions } = buildQuestions(bookmark, context);
    for (const question of Object.values(questions)) {
      expect(['noul', 'choice', 'score']).toContain(question.type);
      expect(typeof question.instructions).toBe('string');
      if (question.type === 'score') {
        expect(Array.isArray(question.criteria)).toBe(true);
        expect((question.criteria as string[]).length).toBeGreaterThanOrEqual(2);
        expect((question.criteria as string[]).length).toBeLessThanOrEqual(10);
      }
      if (question.type === 'choice') {
        expect(Object.keys(question.criteria as object).length).toBeLessThanOrEqual(255);
      }
    }
  });
});

describe('normalizeScore', () => {
  it('maps a rubric position onto 0.0 - 1.0', () => {
    expect(normalizeScore({ score: 0 }, 5)).toBe(0);
    expect(normalizeScore({ score: 4 }, 5)).toBe(1);
    expect(normalizeScore({ score: 2 }, 5)).toBe(0.5);
    expect(normalizeScore({ score: 3.68 }, 5)).toBe(0.92);
  });

  it('rejects missing or non-numeric scores', () => {
    expect(normalizeScore(undefined, 5)).toBeNull();
    expect(normalizeScore({ score: 'high' as unknown as number }, 5)).toBeNull();
  });

  it('clamps out-of-range values instead of storing them', () => {
    expect(normalizeScore({ score: 99 }, 5)).toBe(1);
    expect(normalizeScore({ score: -3 }, 5)).toBe(0);
  });
});

describe('validateJevResponse', () => {
  const built = buildQuestions(bookmark, context);

  it('accepts a well-formed response', () => {
    const classification = validateJevResponse({
      bookmark,
      built,
      response: { answers: fullAnswers() },
    });

    expect(classification.postId).toBe('123456789012');
    expect(classification.category).toBe('AI');
    expect(classification.subcategory).toBe('Agents');
    expect(classification.contentType).toBe('tool');
    expect(classification.actionable).toBe(true);
    expect(classification.revisitScore).toBeGreaterThan(0.9);
    expect(classification.revisitScore).toBeLessThanOrEqual(1);
    expect(classification.tags.length).toBeGreaterThan(0);
    expect(classification.whySavedMightBeUseful).toContain('github.com');
    expect(isValidClassification(classification)).toBe(true);
  });

  it('summarises from the post itself rather than inventing text', () => {
    const classification = validateJevResponse({
      bookmark,
      built,
      response: { answers: fullAnswers() },
    });
    expect(bookmark.text).toContain(classification.summary.replace(/…$/, '').trim());
  });

  it('rejects a category that was never offered', () => {
    const answers = { ...fullAnswers(), category: { choice: 'Underwater Basket Weaving' } };
    expect(() => validateJevResponse({ bookmark, built, response: { answers } })).toThrow(
      ClassifierMalformedResponseError,
    );
  });

  it('lists the unreadable question keys so a repair pass can re-ask them', () => {
    const answers = { ...fullAnswers() };
    delete answers['actionable'];
    delete answers['revisit'];

    try {
      validateJevResponse({ bookmark, built, response: { answers } });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ClassifierMalformedResponseError);
      expect((error as ClassifierMalformedResponseError).failedKeys.sort()).toEqual([
        'actionable',
        'revisit',
      ]);
    }
  });

  it('rejects a response with no answers object at all', () => {
    expect(() => validateJevResponse({ bookmark, built, response: { nope: true } })).toThrow(
      ClassifierMalformedResponseError,
    );
    expect(() => validateJevResponse({ bookmark, built, response: null })).toThrow(
      ClassifierMalformedResponseError,
    );
  });

  it('drops candidate tags that JEV votes against', () => {
    const answers = fullAnswers();
    for (const key of built.tagKeys.keys()) answers[key] = { noul: 0.1 };

    const classification = validateJevResponse({ bookmark, built, response: { answers } });
    // Only the author's own hashtags survive, and this post has none.
    expect(classification.tags).toEqual([]);
  });

  it('treats a missing tag answer as "not tagged" rather than a failure', () => {
    const answers = fullAnswers();
    for (const key of built.tagKeys.keys()) delete answers[key];
    expect(() => validateJevResponse({ bookmark, built, response: { answers } })).not.toThrow();
  });
});

describe('isValidClassification', () => {
  const valid = {
    postId: '123456789012',
    category: 'AI',
    subcategory: 'Agents',
    tags: ['a'],
    contentType: 'tool',
    actionable: true,
    revisitScore: 0.5,
    summary: 's',
    whySavedMightBeUseful: 'w',
  };

  it('accepts a complete classification', () => {
    expect(isValidClassification(valid)).toBe(true);
  });

  it('rejects malformed shapes', () => {
    expect(isValidClassification(null)).toBe(false);
    expect(isValidClassification({ ...valid, postId: 'abc' })).toBe(false);
    expect(isValidClassification({ ...valid, contentType: 'gizmo' })).toBe(false);
    expect(isValidClassification({ ...valid, revisitScore: 1.4 })).toBe(false);
    expect(isValidClassification({ ...valid, revisitScore: -0.1 })).toBe(false);
    expect(isValidClassification({ ...valid, revisitScore: Number.NaN })).toBe(false);
    expect(isValidClassification({ ...valid, actionable: 'yes' })).toBe(false);
    expect(isValidClassification({ ...valid, tags: [1, 2] })).toBe(false);
    expect(isValidClassification({ ...valid, category: '' })).toBe(false);
  });
});

describe('deriveSummary', () => {
  it('states only known facts for a post with no text', () => {
    const media = makeBookmark({
      post_id: '123456789012',
      text: null,
      video_available: true,
      author_handle: 'bambulab',
    });
    expect(deriveSummary(media)).toBe('Video post by @bambulab with no caption text.');
  });

  it('strips URLs and stays within the limit', () => {
    const long = makeBookmark({
      post_id: '123456789012',
      text: `${'word '.repeat(200)}https://example.com/x`,
    });
    const summary = deriveSummary(long);
    expect(summary.length).toBeLessThanOrEqual(240);
    expect(summary).not.toContain('https://');
  });
});

describe('JevClassifier', () => {
  const options = {
    apiKey: 'test-key',
    baseUrl: 'https://api.typesafe.ai/v1/systemone',
    model: 'jev-latest',
    concurrency: 2,
    maxRetries: 3,
    context,
    sleepImpl: async () => undefined,
  };

  it('refuses to run without an API key', async () => {
    const classifier = new JevClassifier({ ...options, apiKey: '', fetchImpl: vi.fn() });
    await expect(classifier.classify([bookmark])).rejects.toBeInstanceOf(
      ClassifierNotConfiguredError,
    );
  });

  it('sends the documented request shape with bearer auth', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ model: 'jev-1.13.0', answers: fullAnswers() }), { status: 200 }),
    );
    const classifier = new JevClassifier({ ...options, fetchImpl });

    const [classification] = await classifier.classify([bookmark]);
    expect(classification?.category).toBe('AI');

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer test-key');

    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body['model']).toBe('jev-latest');
    expect(body).toHaveProperty('state');
    expect(body).toHaveProperty('questions');
  });

  it('reports a version that pins the model and the prompt template', () => {
    const classifier = new JevClassifier({ ...options, fetchImpl: vi.fn() });
    expect(classifier.version).toBe(`jev-latest/${PROMPT_VERSION}`);
  });

  it('retries once with a repair pass when an answer is unreadable', async () => {
    const broken = fullAnswers();
    delete broken['category'];

    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ answers: broken }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ answers: { category: { choice: 'AI' } } }), { status: 200 }),
      );

    const classifier = new JevClassifier({ ...options, fetchImpl: fetchImpl as unknown as typeof fetch });
    const [classification] = await classifier.classify([bookmark]);

    expect(classification?.category).toBe('AI');
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    // The repair call re-asks only the failed question.
    const repairCall = fetchImpl.mock.calls[1] as unknown as [string, RequestInit];
    const repairBody = JSON.parse(repairCall[1].body as string) as { questions: Record<string, unknown> };
    expect(Object.keys(repairBody.questions)).toEqual(['category']);
  });

  it('backs off and retries on a rate limit', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('slow down', { status: 429 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ answers: fullAnswers() }), { status: 200 }));

    const classifier = new JevClassifier({ ...options, fetchImpl: fetchImpl as unknown as typeof fetch });
    const results = await classifier.classify([bookmark]);

    expect(results).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('never retries an authentication failure and never echoes the key', async () => {
    const fetchImpl = vi.fn(async () => new Response('bad key', { status: 401 }));
    const classifier = new JevClassifier({ ...options, fetchImpl });

    const [outcome] = await classifier.classifyDetailed([bookmark]);
    expect(outcome?.ok).toBe(false);
    expect(outcome?.error).toContain('401');
    expect(outcome?.error).not.toContain('test-key');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('keeps processing the queue when one bookmark fails', async () => {
    const good = makeBookmark({ post_id: '111111111111', text: 'good one' });
    const bad = makeBookmark({ post_id: '222222222222', text: 'bad one' });

    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { state: { post_text: string } };
      if (body.state.post_text === 'bad one') return new Response('boom', { status: 400 });
      return new Response(JSON.stringify({ answers: fullAnswers() }), { status: 200 });
    });

    const classifier = new JevClassifier({
      ...options,
      concurrency: 1,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const outcomes = await classifier.classifyDetailed([good, bad]);

    expect(outcomes).toHaveLength(2);
    expect(outcomes[0]?.ok).toBe(true);
    expect(outcomes[1]?.ok).toBe(false);
    expect(outcomes[1]?.postId).toBe('222222222222');
  });

  it('reports progress as each bookmark completes', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ answers: fullAnswers() }), { status: 200 }),
    );
    const classifier = new JevClassifier({ ...options, fetchImpl });
    const seen: number[] = [];

    await classifier.classifyDetailed(
      [makeBookmark({ post_id: '111111111111' }), makeBookmark({ post_id: '222222222222' })],
      (done) => seen.push(done),
    );
    expect(seen).toEqual([1, 2]);
  });

  it('uses the rubric length the prompt declares', () => {
    expect(REVISIT_LEVELS.length).toBeGreaterThanOrEqual(2);
    expect(REVISIT_LEVELS.length).toBeLessThanOrEqual(10);
    expect(buildRequestBody(bookmark, context, 'jev-latest').body.questions['revisit']?.criteria).toHaveLength(
      REVISIT_LEVELS.length,
    );
  });
});
