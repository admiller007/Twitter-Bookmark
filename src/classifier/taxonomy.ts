/**
 * Local taxonomy helpers.
 *
 * JEV's Choice primitive selects from a fixed option set, so the category and
 * subcategory option lists are assembled here: every label the library already
 * uses comes first (which is what makes JEV reuse existing categories), then
 * the user's seed list, then a small generic tail.
 */

import type { Bookmark } from '../shared/types';
import { safeHostname, truncate } from '../shared/util';

/** JEV's Choice primitive accepts at most 255 options. */
export const MAX_CHOICE_OPTIONS = 250;

export const GENERIC_SUBCATEGORIES = [
  'General',
  'Agents',
  'LLMs',
  'Prompting',
  'Frontend',
  'Backend',
  'DevOps',
  'Testing',
  'APIs',
  'Libraries',
  'Tooling',
  'Automation',
  'Security',
  'Data',
  'Mobile',
  'Hardware',
  'Printing',
  'UI Design',
  'Typography',
  'Marketing',
  'Strategy',
  'Hiring',
  'Recipes',
  'Restaurants',
  'Fitness',
  'Finance',
  'Career',
  'Learning',
  'News',
  'Gaming',
  'Travel Tips',
  'Local',
  'Reference',
];

/** Category options: learned labels first, then seeds, then a fallback. */
export function buildCategoryOptions(known: string[], seeds: string[]): string[] {
  const out: string[] = [];
  for (const name of [...known, ...seeds, 'Other']) {
    const label = name.trim();
    if (!label || out.includes(label)) continue;
    out.push(label);
    if (out.length >= MAX_CHOICE_OPTIONS) break;
  }
  return out;
}

export function buildSubcategoryOptions(known: string[]): string[] {
  const out: string[] = [];
  for (const name of [...known, ...GENERIC_SUBCATEGORIES]) {
    const label = name.trim();
    if (!label || out.includes(label)) continue;
    out.push(label);
    if (out.length >= MAX_CHOICE_OPTIONS) break;
  }
  return out;
}

/* ------------------------------------------------------------------- tags */

const TAG_KEYWORDS: Record<string, string[]> = {
  ai: ['ai', 'artificial intelligence', 'machine learning', ' ml '],
  llm: ['llm', 'language model', 'gpt', 'claude', 'gemini', 'mistral'],
  'agentic-ai': ['agent', 'agentic', 'autonomous', 'tool use', 'mcp'],
  prompting: ['prompt', 'system prompt', 'few-shot'],
  rag: ['rag', 'retrieval', 'embedding', 'vector db', 'vector database'],
  'computer-use': ['computer use', 'browser automation', 'clicks for you'],
  coding: ['code', 'coding', 'programming', 'developer', 'refactor'],
  typescript: ['typescript', ' ts ', 'tsx'],
  javascript: ['javascript', 'node.js', 'nodejs', ' js '],
  python: ['python', 'pytorch', 'pandas', 'numpy'],
  rust: ['rust', 'cargo'],
  go: ['golang'],
  react: ['react', 'next.js', 'nextjs'],
  css: ['css', 'tailwind'],
  database: ['database', 'postgres', 'sqlite', 'mysql', 'indexeddb'],
  devops: ['docker', 'kubernetes', 'ci/cd', 'deploy', 'terraform'],
  security: ['security', 'vulnerability', 'exploit', 'auth', 'encryption'],
  api: ['api', 'endpoint', 'webhook', 'rest ', 'graphql'],
  'open-source': ['open source', 'open-source', 'oss', 'mit license'],
  'developer-tools': ['cli', 'ide', 'editor', 'extension', 'plugin', 'devtool'],
  design: ['design', 'figma', 'ux', 'ui ', 'typography'],
  product: ['product', 'roadmap', 'pm ', 'feature'],
  startup: ['startup', 'founder', 'yc ', 'seed round', 'saas'],
  business: ['business', 'revenue', 'pricing', 'mrr', 'customers'],
  marketing: ['marketing', 'growth', 'seo', 'newsletter'],
  productivity: ['productivity', 'workflow', 'habit', 'focus', 'notion'],
  hardware: ['hardware', 'raspberry pi', 'arduino', 'esp32', 'chip', 'gpu'],
  '3d-printing': ['3d print', '3d-print', 'filament', 'bambu', 'prusa', 'stl'],
  mac: ['mac', 'macos', 'apple silicon', 'm1', 'm2', 'm3', 'm4'],
  ios: ['ios', 'iphone', 'ipad', 'swiftui'],
  android: ['android'],
  windows: ['windows'],
  linux: ['linux', 'ubuntu', 'debian', 'nixos'],
  video: ['video', 'youtube', 'stream'],
  tutorial: ['tutorial', 'how to', 'guide', 'walkthrough', 'step by step'],
  thread: ['thread', '🧵'],
  research: ['paper', 'arxiv', 'research', 'study', 'benchmark'],
  news: ['announcing', 'launch', 'released', 'today we', 'now available'],
  food: ['recipe', 'cook', 'bake', 'restaurant', 'dinner'],
  travel: ['travel', 'flight', 'hotel', 'itinerary'],
  chicago: ['chicago'],
  finance: ['investing', 'stock', 'etf', 'tax', 'budget'],
  health: ['health', 'sleep', 'workout', 'fitness', 'nutrition'],
};

function normalizeTag(raw: string): string {
  return raw
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
}

/** Hashtags written by the post author. Factual, so always kept. */
export function extractHashtags(bookmark: Bookmark): string[] {
  const text = `${bookmark.text ?? ''} ${bookmark.quoted_post_text ?? ''}`;
  const matches = text.match(/#[\p{L}\p{N}_]{2,30}/gu) ?? [];
  const out: string[] = [];
  for (const match of matches) {
    const tag = normalizeTag(match.slice(1));
    if (tag && !out.includes(tag)) out.push(tag);
  }
  return out.slice(0, 6);
}

/**
 * Candidate tags derived locally from the post.
 *
 * These are proposals only - JEV votes on each one with a yes/no question, so
 * a keyword that happens to appear without being what the post is about gets
 * dropped rather than persisted.
 */
export function buildCandidateTags(bookmark: Bookmark, limit = 12): string[] {
  const haystack = ` ${(bookmark.text ?? '').toLowerCase()} ${(bookmark.quoted_post_text ?? '').toLowerCase()} `;
  const candidates: string[] = [];

  for (const [tag, needles] of Object.entries(TAG_KEYWORDS)) {
    if (needles.some((needle) => haystack.includes(needle))) candidates.push(tag);
  }

  for (const url of bookmark.external_urls) {
    const host = safeHostname(url);
    if (!host) continue;
    const label = normalizeTag(host.split('.').slice(0, -1).join('-') || host);
    if (label && label.length >= 2 && !candidates.includes(label)) candidates.push(label);
  }

  if (bookmark.video_available && !candidates.includes('video')) candidates.push('video');
  if (bookmark.image_urls.length > 0 && !candidates.includes('image')) candidates.push('image');

  const hashtags = extractHashtags(bookmark);
  const merged: string[] = [];
  for (const tag of [...hashtags, ...candidates]) {
    if (!merged.includes(tag)) merged.push(tag);
  }
  return merged.slice(0, limit);
}

/* --------------------------------------------------------------- summaries */

/**
 * Extractive summary.
 *
 * JEV is a decision model: it returns typed answers, never prose. Rather than
 * inventing a summary (which would risk stating things the post does not say),
 * the summary is taken verbatim from the post's own opening sentences. When a
 * post has no text at all, the summary states only what is factually known.
 */
export function deriveSummary(bookmark: Bookmark, maxLength = 240): string {
  const raw = (bookmark.text ?? '').replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim();

  if (raw.length > 0) {
    const sentences = (raw.match(/[^.!?\n]+[.!?]?/g) ?? [raw]).map((part) => part.trim());
    const kept: string[] = [];
    let length = 0;

    for (const sentence of sentences) {
      if (sentence.length === 0) continue;
      const added = length === 0 ? sentence.length : length + 1 + sentence.length;
      if (added > maxLength) break;
      kept.push(sentence);
      length = added;
    }

    // A single sentence longer than the limit is truncated rather than dropped.
    return kept.length > 0 ? kept.join(' ') : truncate(raw, maxLength);
  }

  const handle = bookmark.author_handle ? `@${bookmark.author_handle}` : 'an X user';
  if (bookmark.quoted_post_text) {
    return truncate(`${handle} quoted: ${bookmark.quoted_post_text.replace(/\s+/g, ' ').trim()}`, maxLength);
  }
  if (bookmark.video_available) return `Video post by ${handle} with no caption text.`;
  if (bookmark.image_urls.length > 0) {
    return `Image post by ${handle} with ${bookmark.image_urls.length} image(s) and no caption text.`;
  }
  return `Post by ${handle} with no extractable text.`;
}
