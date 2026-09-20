/**
 * Versioned JEV classification template.
 *
 * JEV (TypeSafe's System One model) does not generate text. It evaluates one
 * "state" against a map of typed questions and returns a calibrated answer per
 * question, using three primitives:
 *
 *   noul   - yes/no, answered as a probability
 *   choice - one option from a fixed set (max 255), with a distribution
 *   score  - a position along an ordered rubric of 2-10 levels
 *
 * The requested BookmarkClassification is therefore expressed as a set of typed
 * questions rather than a free-text JSON request. Bump PROMPT_VERSION whenever
 * the questions change so previously classified bookmarks can be identified and
 * selectively reclassified.
 */

import type { Bookmark } from '../shared/types';
import { ALL_CONTENT_TYPES } from '../shared/settings';
import { safeHostname, truncate, uniq } from '../shared/util';
import type { ClassifierContext } from './classifier';
import { buildCandidateTags, buildCategoryOptions, buildSubcategoryOptions } from './taxonomy';

export const PROMPT_VERSION = 'jev-questions-v1';

export const MAX_TEXT_CHARS = 1200;
export const MAX_QUOTE_CHARS = 400;

/** Threshold above which a candidate tag is accepted. */
export const TAG_ACCEPT_PROBABILITY = 0.6;

export const REVISIT_LEVELS = [
  'Disposable: a passing remark, already consumed, no reason to open it again.',
  'Low value: mildly interesting but unlikely to be needed later.',
  'Moderate: worth a second look at some point, no urgency.',
  'High: clearly useful reference, tool or idea the reader will want again.',
  'Essential: directly actionable and valuable; the reader should revisit this soon.',
];

export const CONTENT_TYPE_CRITERIA: Record<string, string> = {
  tool: 'Presents a usable tool, app, library or service.',
  article: 'Points to a written article, blog post or essay.',
  video: 'The main payload is a video, talk, demo recording or stream.',
  thread: 'A multi-part thread of posts expanding on one topic.',
  news: 'Announces something new: a launch, release, funding or event.',
  product: 'Describes a purchasable product or commercial offering.',
  tutorial: 'Teaches how to do something step by step.',
  idea: 'An idea, proposal, hypothesis or thought experiment.',
  code: 'Contains source code, a snippet, a config or a repository.',
  resource: 'A list, dataset, template, reference or collection of links.',
  opinion: 'A personal take, argument or commentary.',
  other: 'None of the other content types fits.',
};

/** Fixed rationale sentences; JEV picks one, so no prose is generated. */
export const REASON_OPTIONS: Record<string, { sentence: string; criteria: string }> = {
  reference: {
    sentence: 'Reference material worth consulting again when this topic comes up.',
    criteria: 'The post is factual reference material, documentation or an explainer.',
  },
  try_tool: {
    sentence: 'A tool or product to try out.',
    criteria: 'The post introduces something the reader could install, run or sign up for.',
  },
  learn: {
    sentence: 'A tutorial or explanation to work through when learning this topic.',
    criteria: 'The post teaches a skill or explains how something works.',
  },
  build_idea: {
    sentence: 'An idea that could turn into something to build.',
    criteria: 'The post contains a project idea, business idea or a gap worth filling.',
  },
  buy: {
    sentence: 'Something to consider buying.',
    criteria: 'The post is about a purchasable physical or digital product.',
  },
  stay_informed: {
    sentence: 'News worth being aware of in this area.',
    criteria: 'The post announces a release, launch or industry development.',
  },
  inspiration: {
    sentence: 'Saved as inspiration or a good example of the craft.',
    criteria: 'The post is an example of design, writing or work worth emulating.',
  },
  do_later: {
    sentence: 'A concrete thing to do or follow up on later.',
    criteria: 'The post implies a specific action the reader intended to take.',
  },
  place: {
    sentence: 'A place, event or local recommendation to remember.',
    criteria: 'The post is about a physical place, restaurant, city or event.',
  },
  entertainment: {
    sentence: 'Saved for enjoyment rather than for a task.',
    criteria: 'The post is humour, entertainment or a personal story.',
  },
};

/* ------------------------------------------------------------------- state */

export interface JevQuestion {
  type: 'noul' | 'choice' | 'score';
  instructions: string;
  criteria?: Record<string, string | null> | string[];
}

export interface JevRequestBody {
  model: string;
  state: Record<string, unknown>;
  questions: Record<string, JevQuestion>;
}

/**
 * Builds exactly the payload that leaves the browser.
 *
 * Deliberately excluded: full external URLs (hostnames only), image and video
 * files, the user's notes, manual tags and favourites, and anything at all
 * about the X session. Settings shows this list to the user verbatim.
 */
export function buildState(bookmark: Bookmark, context: ClassifierContext): Record<string, unknown> {
  const domains = uniq(
    bookmark.external_urls.map((url) => safeHostname(url)).filter((d): d is string => d !== null),
  );

  const state: Record<string, unknown> = {
    post_text: bookmark.text ? truncate(bookmark.text, MAX_TEXT_CHARS) : null,
    author_name: bookmark.author_name,
    author_handle: bookmark.author_handle,
    linked_domains: domains,
    has_images: bookmark.image_urls.length > 0,
    image_count: bookmark.image_urls.length,
    has_video: bookmark.video_available,
    is_reply: bookmark.reply_to_post_id !== null,
    engagement: {
      likes: bookmark.like_count,
      replies: bookmark.reply_count,
      reposts: bookmark.repost_count,
      views: bookmark.view_count,
    },
    existing_categories_in_library: context.knownCategories.slice(0, 60),
  };

  if (bookmark.quoted_post_text) {
    state['quoted_post_text'] = truncate(bookmark.quoted_post_text, MAX_QUOTE_CHARS);
    state['quoted_post_author'] = bookmark.quoted_post_author;
  }

  return state;
}

export const TAG_QUESTION_PREFIX = 'tag__';

/** Stable question key for a candidate tag. */
export function tagQuestionKey(tag: string, index: number): string {
  return `${TAG_QUESTION_PREFIX}${index}_${tag.replace(/[^a-z0-9]/gi, '_')}`;
}

export interface BuiltQuestions {
  questions: Record<string, JevQuestion>;
  /** Maps each tag question key back to its tag. */
  tagKeys: Map<string, string>;
  categoryOptions: string[];
  subcategoryOptions: string[];
}

const GROUNDING =
  'Judge only from the information in the state. Do not assume anything about ' +
  'the contents of a linked page that has not been quoted here.';

export function buildQuestions(bookmark: Bookmark, context: ClassifierContext): BuiltQuestions {
  const categoryOptions = buildCategoryOptions(context.knownCategories, context.seedCategories);
  const subcategoryOptions = buildSubcategoryOptions(context.knownSubcategories);

  const categoryCriteria: Record<string, string | null> = {};
  for (const option of categoryOptions) {
    categoryCriteria[option] =
      option === 'Other' ? 'No listed category is a reasonable fit for this post.' : null;
  }

  const subcategoryCriteria: Record<string, string | null> = {};
  for (const option of subcategoryOptions) subcategoryCriteria[option] = null;

  const contentTypeCriteria: Record<string, string | null> = {};
  for (const type of ALL_CONTENT_TYPES) contentTypeCriteria[type] = CONTENT_TYPE_CRITERIA[type] ?? null;

  const reasonCriteria: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(REASON_OPTIONS)) reasonCriteria[key] = value.criteria;

  const questions: Record<string, JevQuestion> = {
    category: {
      type: 'choice',
      instructions:
        'Which single category does this saved X post belong to? Prefer a category ' +
        `already used in this library when one fits. ${GROUNDING}`,
      criteria: categoryCriteria,
    },
    subcategory: {
      type: 'choice',
      instructions:
        'Which narrower topic best describes this post within its category? ' +
        `Choose "General" if none is clearly more specific. ${GROUNDING}`,
      criteria: subcategoryCriteria,
    },
    content_type: {
      type: 'choice',
      instructions: `What kind of content is this post? ${GROUNDING}`,
      criteria: contentTypeCriteria,
    },
    actionable: {
      type: 'noul',
      instructions:
        'Does this post give the reader something concrete to do - a tool to try, ' +
        'steps to follow, a thing to buy, or a specific follow-up?',
      criteria: {
        true: 'There is a clear, specific action the reader could take from this post.',
        false: 'The post is informational, commentary or entertainment with no concrete action.',
      },
    },
    revisit: {
      type: 'score',
      instructions:
        'How valuable would it be for the person who bookmarked this post to come ' +
        `back to it later? ${GROUNDING}`,
      criteria: REVISIT_LEVELS,
    },
    reason: {
      type: 'choice',
      instructions:
        'Why would someone most likely have bookmarked this post? Pick the single best reason.',
      criteria: reasonCriteria,
    },
  };

  const tagKeys = new Map<string, string>();
  const candidates = buildCandidateTags(bookmark);
  candidates.forEach((tag, index) => {
    const key = tagQuestionKey(tag, index);
    tagKeys.set(key, tag);
    questions[key] = {
      type: 'noul',
      instructions: `Is "${tag}" an accurate topic tag for this post? ${GROUNDING}`,
      criteria: {
        true: `The post is genuinely about ${tag}.`,
        false: `${tag} is not what this post is about, even if the word appears.`,
      },
    };
  });

  return { questions, tagKeys, categoryOptions, subcategoryOptions };
}

export function buildRequestBody(
  bookmark: Bookmark,
  context: ClassifierContext,
  model: string,
): { body: JevRequestBody; built: BuiltQuestions } {
  const built = buildQuestions(bookmark, context);
  return {
    body: {
      model,
      state: buildState(bookmark, context),
      questions: built.questions,
    },
    built,
  };
}

/**
 * Repair pass: re-asks only the questions whose answers could not be read,
 * with the instruction restated more explicitly.
 */
export function buildRepairBody(
  body: JevRequestBody,
  failedKeys: string[],
): JevRequestBody {
  const questions: Record<string, JevQuestion> = {};
  for (const key of failedKeys) {
    const original = body.questions[key];
    if (!original) continue;
    questions[key] = {
      ...original,
      instructions: `${original.instructions} Answer this question directly using only the listed options.`,
    };
  }
  return { ...body, questions };
}
