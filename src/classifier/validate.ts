/**
 * Strict validation of JEV responses.
 *
 * Nothing reaches IndexedDB unless it validates: an unknown category, an
 * out-of-range score or a missing answer is a malformed response, which the
 * caller turns into one repair retry and then a `failed` status on that single
 * bookmark. The rest of the queue is unaffected.
 */

import type { Bookmark, BookmarkClassification, ContentType } from '../shared/types';
import { CONTENT_TYPES } from '../shared/types';
import { clamp, safeHostname, uniq } from '../shared/util';
import { ClassifierMalformedResponseError } from './classifier';
import {
  REASON_OPTIONS,
  REVISIT_LEVELS,
  TAG_ACCEPT_PROBABILITY,
  type BuiltQuestions,
} from './prompt';
import { deriveSummary, extractHashtags } from './taxonomy';

export interface JevAnswer {
  type?: string;
  choice?: unknown;
  noul?: unknown;
  score?: unknown;
  confidence?: unknown;
  probabilities?: unknown;
  distribution?: unknown;
  per_level_probabilities?: unknown;
  legend?: unknown;
}

export interface JevResponse {
  model?: string;
  answers?: Record<string, JevAnswer>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export function isJevResponse(value: unknown): value is JevResponse {
  return typeof value === 'object' && value !== null && 'answers' in (value as object);
}

function readChoice(answer: JevAnswer | undefined, options: string[]): string | null {
  if (!answer) return null;
  const choice = answer.choice;
  if (typeof choice !== 'string') return null;
  // Match case-insensitively but persist the library's own casing.
  const match = options.find((option) => option.toLowerCase() === choice.toLowerCase());
  return match ?? null;
}

function readNoul(answer: JevAnswer | undefined): number | null {
  if (!answer) return null;
  const value = answer.noul;
  if (typeof value === 'number' && Number.isFinite(value)) return clamp(value, 0, 1);
  // Some deployments answer a noul as a boolean choice.
  if (typeof answer.choice === 'string') {
    if (/^true$/i.test(answer.choice)) return 1;
    if (/^false$/i.test(answer.choice)) return 0;
  }
  return null;
}

/**
 * A JEV score is a position along the rubric, 0 .. levels-1, and may land
 * between levels. It is normalised here to the 0.0-1.0 range the
 * BookmarkClassification contract asks for.
 */
export function normalizeScore(answer: JevAnswer | undefined, levelCount: number): number | null {
  if (!answer || levelCount < 2) return null;
  const raw = answer.score;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;

  // JEV reports a score as a position along the rubric: 0 for the first level,
  // levelCount - 1 for the last, and fractional values in between.
  const normalized = raw / (levelCount - 1);
  return clamp(Number(normalized.toFixed(4)), 0, 1);
}

export interface ValidateOptions {
  bookmark: Bookmark;
  built: BuiltQuestions;
  response: unknown;
}

/**
 * Turns a raw JEV response into a validated BookmarkClassification.
 * Throws ClassifierMalformedResponseError listing the unreadable question keys.
 */
export function validateJevResponse({
  bookmark,
  built,
  response,
}: ValidateOptions): BookmarkClassification {
  if (!isJevResponse(response) || typeof response.answers !== 'object' || response.answers === null) {
    throw new ClassifierMalformedResponseError(
      'JEV response did not contain an "answers" object.',
      ['category', 'subcategory', 'content_type', 'actionable', 'revisit', 'reason'],
    );
  }

  const answers = response.answers;
  const failed: string[] = [];

  const category = readChoice(answers['category'], built.categoryOptions);
  if (!category) failed.push('category');

  const subcategory = readChoice(answers['subcategory'], built.subcategoryOptions);
  if (!subcategory) failed.push('subcategory');

  const contentTypeRaw = readChoice(answers['content_type'], [...CONTENT_TYPES]);
  if (!contentTypeRaw) failed.push('content_type');

  const actionableProbability = readNoul(answers['actionable']);
  if (actionableProbability === null) failed.push('actionable');

  const revisitScore = normalizeScore(answers['revisit'], REVISIT_LEVELS.length);
  if (revisitScore === null) failed.push('revisit');

  const reasonKey = readChoice(answers['reason'], Object.keys(REASON_OPTIONS));
  if (!reasonKey) failed.push('reason');

  if (failed.length > 0) {
    throw new ClassifierMalformedResponseError(
      `JEV response was missing or unreadable for: ${failed.join(', ')}.`,
      failed,
    );
  }

  // Tag questions are optional: a missing tag answer just means "not tagged".
  const tags: string[] = [];
  for (const [key, tag] of built.tagKeys.entries()) {
    const probability = readNoul(answers[key]);
    if (probability !== null && probability >= TAG_ACCEPT_PROBABILITY) tags.push(tag);
  }

  // The author's own hashtags are facts about the post, not inferences.
  const finalTags = uniq([...extractHashtags(bookmark), ...tags]).slice(0, 10);

  const reason = REASON_OPTIONS[reasonKey as keyof typeof REASON_OPTIONS];
  const domains = uniq(
    bookmark.external_urls.map((url) => safeHostname(url)).filter((d): d is string => d !== null),
  );
  const whySaved =
    domains.length > 0
      ? `${reason?.sentence ?? ''} Links to ${domains.slice(0, 3).join(', ')}.`.trim()
      : (reason?.sentence ?? '');

  return {
    postId: bookmark.post_id,
    category: category as string,
    subcategory: subcategory as string,
    tags: finalTags,
    contentType: contentTypeRaw as ContentType,
    actionable: (actionableProbability as number) >= 0.5,
    revisitScore: revisitScore as number,
    summary: deriveSummary(bookmark),
    whySavedMightBeUseful: whySaved,
  };
}

/** Shape check used when importing classifications from a backup file. */
export function isValidClassification(value: unknown): value is BookmarkClassification {
  if (typeof value !== 'object' || value === null) return false;
  const c = value as Record<string, unknown>;

  if (typeof c['postId'] !== 'string' || !/^\d{6,25}$/.test(c['postId'])) return false;
  if (typeof c['category'] !== 'string' || c['category'].length === 0) return false;
  if (typeof c['subcategory'] !== 'string') return false;
  if (!Array.isArray(c['tags']) || c['tags'].some((t) => typeof t !== 'string')) return false;
  if (typeof c['contentType'] !== 'string' || !CONTENT_TYPES.includes(c['contentType'] as ContentType)) {
    return false;
  }
  if (typeof c['actionable'] !== 'boolean') return false;
  const score = c['revisitScore'];
  if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 1) return false;
  if (typeof c['summary'] !== 'string') return false;
  if (typeof c['whySavedMightBeUseful'] !== 'string') return false;

  return true;
}
