import { useCallback, useEffect, useState } from 'react';
import {
  sendToBackground,
  type ClassifyProgress,
  type SyncProgress,
} from '../../shared/messages';
import { DEFAULT_SETTINGS, loadSettings, saveSettings, type Settings } from '../../shared/settings';

/** Live sync progress, refreshed on background broadcasts. */
export function useSyncProgress(): {
  progress: SyncProgress | null;
  error: string | null;
  refresh: () => Promise<void>;
} {
  const [progress, setProgress] = useState<SyncProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setProgress(await sendToBackground<SyncProgress>({ type: 'sync/progress' }));
      setError(null);
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : String(refreshError));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const listener = (message: unknown): void => {
      const typed = message as { type?: string; progress?: SyncProgress };
      if (typed?.type === 'event/sync-progress' && typed.progress) setProgress(typed.progress);
    };
    chrome.runtime.onMessage.addListener(listener);

    // A safety net in case a broadcast is missed while the page was hidden.
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => {
      chrome.runtime.onMessage.removeListener(listener);
      window.clearInterval(timer);
    };
  }, [refresh]);

  return { progress, error, refresh };
}

export function useClassifyProgress(): { progress: ClassifyProgress | null; refresh: () => Promise<void> } {
  const [progress, setProgress] = useState<ClassifyProgress | null>(null);

  const refresh = useCallback(async () => {
    try {
      setProgress(await sendToBackground<ClassifyProgress>({ type: 'classify/progress' }));
    } catch {
      setProgress(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const listener = (message: unknown): void => {
      const typed = message as { type?: string; progress?: ClassifyProgress };
      if (typed?.type === 'event/classify-progress' && typed.progress) setProgress(typed.progress);
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, [refresh]);

  return { progress, refresh };
}

export function useSettings(): {
  settings: Settings;
  loaded: boolean;
  update: (patch: Partial<Settings>) => Promise<void>;
} {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    void loadSettings().then((next) => {
      setSettings(next);
      setLoaded(true);
    });
  }, []);

  const update = useCallback(async (patch: Partial<Settings>) => {
    setSettings(await saveSettings(patch));
  }, []);

  return { settings, loaded, update };
}

/** Applies the theme preference to the document root. */
export function useTheme(theme: Settings['theme']): void {
  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', theme);
  }, [theme]);
}
