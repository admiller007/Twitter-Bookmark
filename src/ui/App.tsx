import { useCallback, useEffect, useMemo, useState } from 'react';
import type { LibraryFilters } from '../database/search';
import { useLibrary, useLibraryStats } from './hooks/useLibrary';
import {
  useClassifyProgress,
  useSettings,
  useSyncProgress,
  useTheme,
} from './hooks/useBackgroundState';
import { Banner, Toast, type ToastMessage } from './components/common';
import { Dashboard } from './pages/Dashboard';
import { Library } from './pages/Library';
import { SyncPage } from './pages/SyncPage';
import { Classification } from './pages/Classification';
import { SettingsPage } from './pages/SettingsPage';
import { DiagnosticsPage } from './pages/DiagnosticsPage';
import { Setup } from './pages/Setup';
import { formatNumber } from './lib/format';

type Tab = 'setup' | 'dashboard' | 'library' | 'sync' | 'classify' | 'settings' | 'diagnostics';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'library', label: 'Library' },
  { id: 'sync', label: 'Sync' },
  { id: 'classify', label: 'Classification' },
  { id: 'settings', label: 'Settings' },
  { id: 'diagnostics', label: 'Diagnostics' },
];

function initialTab(): Tab {
  const hash = window.location.hash.replace(/^#\/?/, '');
  const match = TABS.find((tab) => tab.id === hash);
  if (match) return match.id;
  return hash === 'setup' ? 'setup' : 'dashboard';
}

export function App(): JSX.Element {
  const { bookmarks, index, loading, error, reload } = useLibrary();
  const stats = useLibraryStats(bookmarks);
  const { progress: syncProgress, refresh: refreshSync } = useSyncProgress();
  const { progress: classifyProgress } = useClassifyProgress();
  const { settings, loaded: settingsLoaded, update } = useSettings();
  useTheme(settings.theme);

  const [tab, setTab] = useState<Tab>(initialTab);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const [libraryFilters, setLibraryFilters] = useState<Partial<LibraryFilters>>({});

  const notify = useCallback((message: ToastMessage) => setToast(message), []);

  useEffect(() => {
    window.location.hash = `#/${tab}`;
  }, [tab]);

  // Send first-time users to the setup flow once settings have loaded.
  useEffect(() => {
    if (!settingsLoaded) return;
    if (!settings.hasCompletedOnboarding && bookmarks.length === 0 && initialTab() === 'dashboard') {
      setTab('setup');
    }
  }, [settingsLoaded, settings.hasCompletedOnboarding, bookmarks.length]);

  const unclassifiedCount = stats.unclassified;
  const badges = useMemo<Partial<Record<Tab, string>>>(
    () => ({
      library: bookmarks.length > 0 ? formatNumber(bookmarks.length) : undefined,
      classify: unclassifiedCount > 0 ? formatNumber(unclassifiedCount) : undefined,
      sync: syncProgress?.session?.status === 'running' ? 'live' : undefined,
    }),
    [bookmarks.length, unclassifiedCount, syncProgress?.session?.status],
  );

  const openLibraryWith = useCallback((filters: Partial<LibraryFilters>) => {
    setLibraryFilters(filters);
    setTab('library');
  }, []);

  return (
    <div className="app">
      <nav className="sidebar">
        <div className="brand">
          <span className="brand-mark">X</span>
          <span>Bookmark Vault</span>
        </div>

        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className={`nav-item${tab === entry.id ? ' active' : ''}`}
            onClick={() => setTab(entry.id)}
          >
            <span>{entry.label}</span>
            {badges[entry.id] ? <span className="nav-badge">{badges[entry.id]}</span> : null}
          </button>
        ))}

        <button
          type="button"
          className={`nav-item${tab === 'setup' ? ' active' : ''}`}
          onClick={() => setTab('setup')}
        >
          <span>Getting started</span>
        </button>

        <div className="sidebar-foot">
          Local-first. No analytics, no telemetry.
          {syncProgress?.session?.status === 'running' ? (
            <div style={{ marginTop: 6, color: 'var(--accent)' }}>Sync running…</div>
          ) : null}
        </div>
      </nav>

      <main className="main">
        {error ? (
          <Banner kind="error">
            Could not read the local database: {error}. Try reloading this page; if it persists,
            check Diagnostics.
          </Banner>
        ) : null}

        {loading ? (
          <p className="muted">Loading your library…</p>
        ) : tab === 'setup' ? (
          <Setup
            hasBookmarks={bookmarks.length > 0}
            hasApiKey={settings.jevApiKey.length > 0}
            onGoToSync={() => setTab('sync')}
            onGoToSettings={() => setTab('settings')}
            onDismiss={() => {
              void update({ hasCompletedOnboarding: true });
              setTab('dashboard');
            }}
          />
        ) : tab === 'dashboard' ? (
          <Dashboard
            bookmarks={bookmarks}
            stats={stats}
            onGoToSync={() => setTab('sync')}
            onGoToLibrary={() => openLibraryWith({})}
            onOpenRandom={() => {
              const pick = bookmarks[Math.floor(Math.random() * bookmarks.length)];
              if (pick) window.open(pick.post_url, '_blank', 'noopener');
            }}
          />
        ) : tab === 'library' ? (
          <Library
            key={JSON.stringify(libraryFilters)}
            bookmarks={bookmarks}
            index={index}
            reload={reload}
            notify={notify}
            initialFilters={libraryFilters}
          />
        ) : tab === 'sync' ? (
          <SyncPage
            progress={syncProgress}
            refresh={refreshSync}
            notify={notify}
            knownThreshold={settings.incrementalKnownThreshold}
          />
        ) : tab === 'classify' ? (
          <Classification
            bookmarks={bookmarks}
            progress={classifyProgress}
            hasApiKey={settings.jevApiKey.length > 0}
            notify={notify}
            onGoToSettings={() => setTab('settings')}
          />
        ) : tab === 'settings' ? (
          <SettingsPage
            settings={settings}
            update={update}
            bookmarks={bookmarks}
            reload={reload}
            notify={notify}
          />
        ) : (
          <DiagnosticsPage bookmarks={bookmarks} settings={settings} notify={notify} />
        )}
      </main>

      <Toast message={toast} onDismiss={() => setToast(null)} />
    </div>
  );
}
