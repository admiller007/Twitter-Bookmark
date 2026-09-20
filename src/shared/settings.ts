import type { ContentType } from './types';
import {
  DEFAULT_JEV_PROVIDER,
  getProvider,
  inferProviderFromUrl,
  type JevProviderId,
} from '../classifier/providers';

/**
 * Settings live in chrome.storage.local. The JEV API key is stored here too and
 * is never written into IndexedDB, exports, backups or diagnostics.
 */
export interface Settings {
  /** Which route to JEV: through OpenRouter, or straight to TypeSafe. */
  jevProvider: JevProviderId;
  /** API key for the selected provider. Empty means classification is off. */
  jevApiKey: string;
  jevBaseUrl: string;
  jevModel: string;
  /** Bookmarks classified in parallel. */
  jevConcurrency: number;
  jevMaxRetries: number;
  /** Consecutive already-known bookmarks that end an incremental sync. */
  incrementalKnownThreshold: number;
  /** Scroll rounds with zero unseen ids before a sync is considered finished. */
  emptyRoundLimit: number;
  /** Milliseconds to wait after each scroll step for X to render new posts. */
  scrollDelayMs: number;
  /** Pixels scrolled per step; kept below one viewport so nothing is skipped. */
  scrollStepRatio: number;
  /** Use the MAIN-world network observer as an extraction enhancement. */
  enableNetworkEnhancement: boolean;
  /** Full Rescan may mark absent bookmarks as no longer bookmarked. */
  detectUnbookmarkedOnFullRescan: boolean;
  theme: 'system' | 'light' | 'dark';
  /** Extra categories the user wants JEV to prefer, on top of learned ones. */
  seedCategories: string[];
  hasCompletedOnboarding: boolean;
}

export const DEFAULT_SEED_CATEGORIES = [
  'AI',
  'AI Agents',
  'Coding',
  'Developer Tools',
  'Product Management',
  'Business Ideas',
  '3D Printing',
  'Design',
  'Hardware',
  'Interesting Products',
  'Recipes / Food',
  'Chicago',
  'Travel',
  'Productivity',
  'Entertainment',
  'Things to Try',
  'Things to Buy',
  'Research',
];

/**
 * Optional build-time defaults (see .env.example). Only the endpoint and model
 * can be set this way. The API key deliberately cannot: a key baked into the
 * bundle would ship inside the extension and end up in version control.
 */
const ENV_PROVIDER = import.meta.env?.VITE_JEV_PROVIDER;
const ENV_BASE_URL = import.meta.env?.VITE_JEV_BASE_URL;
const ENV_MODEL = import.meta.env?.VITE_JEV_MODEL;

const DEFAULT_PROVIDER: JevProviderId =
  ENV_PROVIDER === 'typesafe' || ENV_PROVIDER === 'openrouter'
    ? ENV_PROVIDER
    : DEFAULT_JEV_PROVIDER;

const DEFAULT_PROFILE = getProvider(DEFAULT_PROVIDER);

export const DEFAULT_SETTINGS: Settings = {
  jevProvider: DEFAULT_PROVIDER,
  jevApiKey: '',
  jevBaseUrl: ENV_BASE_URL || DEFAULT_PROFILE.defaultBaseUrl,
  jevModel: ENV_MODEL || DEFAULT_PROFILE.defaultModel,
  jevConcurrency: 4,
  jevMaxRetries: 3,
  incrementalKnownThreshold: 40,
  emptyRoundLimit: 6,
  scrollDelayMs: 900,
  scrollStepRatio: 0.8,
  enableNetworkEnhancement: true,
  detectUnbookmarkedOnFullRescan: false,
  theme: 'system',
  seedCategories: DEFAULT_SEED_CATEGORIES,
  hasCompletedOnboarding: false,
};

const STORAGE_KEY = 'xbv_settings';

export async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const raw = (stored[STORAGE_KEY] ?? {}) as Partial<Settings>;
  const settings: Settings = { ...DEFAULT_SETTINGS, ...raw };

  // Settings saved before the provider choice existed only recorded an
  // endpoint. Keep honouring it rather than silently switching routes.
  if (!raw.jevProvider && raw.jevBaseUrl) {
    settings.jevProvider = inferProviderFromUrl(raw.jevBaseUrl) ?? settings.jevProvider;
  }

  return settings;
}

/** Endpoint and model defaults for a route, used when the user switches. */
export function providerDefaults(provider: JevProviderId): Pick<Settings, 'jevBaseUrl' | 'jevModel'> {
  const profile = getProvider(provider);
  return { jevBaseUrl: profile.defaultBaseUrl, jevModel: profile.defaultModel };
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const current = await loadSettings();
  const next: Settings = { ...current, ...patch };
  await chrome.storage.local.set({ [STORAGE_KEY]: next });
  return next;
}

/** Settings minus every secret, safe for diagnostics export. */
export function redactSettings(settings: Settings): Record<string, unknown> {
  const { jevApiKey, ...rest } = settings;
  return { ...rest, jevApiKeyConfigured: jevApiKey.length > 0 };
}

/**
 * Exactly what leaves the browser when a bookmark is classified. Rendered
 * verbatim in Settings so the user can see the payload before enabling JEV.
 */
export const JEV_DATA_SENT_DESCRIPTION: string[] = [
  'The post text (truncated to 1,200 characters)',
  'The author display name and @handle',
  'The quoted post text, if the bookmark quotes another post (truncated)',
  'Hostnames of external links only, e.g. "github.com" — never the full URL',
  'Whether the post has images or video, and how many',
  'Approximate engagement counts (likes / replies / reposts / views)',
  'The list of category names already used in your library, so JEV reuses them',
  'A short list of candidate tags derived locally from the post text',
];

export const JEV_DATA_NEVER_SENT: string[] = [
  'Your X session cookies, auth tokens or any credential',
  'Your X username or password (the extension never asks for them)',
  'Full external URLs, image files or video files',
  'Your personal notes, manual tags or favorites',
  'Anything at all when no API key is configured',
];

export const ALL_CONTENT_TYPES: ContentType[] = [
  'tool',
  'article',
  'video',
  'thread',
  'news',
  'product',
  'tutorial',
  'idea',
  'code',
  'resource',
  'opinion',
  'other',
];
