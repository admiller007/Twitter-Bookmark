/**
 * JEV access routes.
 *
 * JEV can be reached either directly from TypeSafe or through OpenRouter. Both
 * expose the same Decisions API - `{ model, state, questions }` in, typed
 * `answers` out, with the same noul / choice / score primitives - so only the
 * endpoint, the model slug and the error envelope differ. Everything else,
 * including the question template and response validation, is shared.
 */

export type JevProviderId = 'typesafe' | 'openrouter';

export interface JevProviderProfile {
  id: JevProviderId;
  label: string;
  defaultBaseUrl: string;
  /**
   * Other URLs known to serve this provider's Decisions API. Tried once if the
   * configured one answers 404, which matters because OpenRouter's endpoint is
   * still in alpha and is documented inconsistently.
   */
  alternateBaseUrls: string[];
  defaultModel: string;
  modelOptions: string[];
  keyLabel: string;
  keyHint: string;
  keyUrl: string;
  docsUrl: string;
  /** Shown in Settings so the data path is never a surprise. */
  dataPathNote: string;
}

export const JEV_PROVIDERS: Record<JevProviderId, JevProviderProfile> = {
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    defaultBaseUrl: 'https://openrouter.ai/api/v1/api/alpha/decisions',
    alternateBaseUrls: ['https://openrouter.ai/api/alpha/decisions'],
    defaultModel: 'typesafe/jev-1.13',
    modelOptions: ['typesafe/jev-1.13', '~typesafe/jev-latest'],
    keyLabel: 'OpenRouter API key',
    keyHint: 'Starts with "sk-or-". Create one in your OpenRouter dashboard.',
    keyUrl: 'https://openrouter.ai/keys',
    docsUrl: 'https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-questions-and-answers-request',
    dataPathNote:
      'Requests go to OpenRouter, which forwards them to TypeSafe and bills your OpenRouter credits. OpenRouter therefore sees the classification payload described below.',
  },
  typesafe: {
    id: 'typesafe',
    label: 'TypeSafe (direct)',
    defaultBaseUrl: 'https://api.typesafe.ai/v1/systemone',
    alternateBaseUrls: [],
    defaultModel: 'jev-latest',
    modelOptions: ['jev-latest', 'jev-1.13'],
    keyLabel: 'TypeSafe API key',
    keyHint: 'A key issued by TypeSafe for direct System One access.',
    keyUrl: 'https://typesafe.ai',
    docsUrl: 'https://docs.typesafe.ai/api',
    dataPathNote:
      'Requests go directly to TypeSafe. No other service sees the classification payload.',
  },
};

export const DEFAULT_JEV_PROVIDER: JevProviderId = 'openrouter';

export function getProvider(id: JevProviderId | string | undefined): JevProviderProfile {
  if (id === 'typesafe') return JEV_PROVIDERS.typesafe;
  return JEV_PROVIDERS.openrouter;
}

/** Every URL known to belong to a provider, primary first. */
export function providerUrls(profile: JevProviderProfile): string[] {
  return [profile.defaultBaseUrl, ...profile.alternateBaseUrls];
}

/**
 * Infers the route from a stored endpoint, so settings saved before providers
 * existed keep pointing at whatever the user had already configured.
 */
export function inferProviderFromUrl(baseUrl: string | undefined): JevProviderId | null {
  if (!baseUrl) return null;
  if (/(^|\/\/)([^/]*\.)?openrouter\.ai\//i.test(baseUrl)) return 'openrouter';
  if (/(^|\/\/)([^/]*\.)?typesafe\.ai\//i.test(baseUrl)) return 'typesafe';
  return null;
}
