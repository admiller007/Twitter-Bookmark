import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { sendToBackground } from '../shared/messages';
import { useClassifyProgress, useSettings, useSyncProgress, useTheme } from './hooks/useBackgroundState';
import { ProgressBar } from './components/common';
import { formatNumber } from './lib/format';
import './styles.css';

const BOOKMARKS_URL = 'https://x.com/i/bookmarks';

function Popup(): JSX.Element {
  const { progress, refresh } = useSyncProgress();
  const { progress: classify } = useClassifyProgress();
  const { settings } = useSettings();
  useTheme(settings.theme);

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const session = progress?.session ?? null;
  const running = session?.status === 'running';
  const paused = session?.status === 'paused';
  const attached = progress?.attached ?? false;

  const send = async (request: Parameters<typeof sendToBackground>[0]): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await sendToBackground(request);
      await refresh();
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : String(sendError));
    } finally {
      setBusy(false);
    }
  };

  const openLibrary = (): void => {
    void chrome.tabs.create({ url: chrome.runtime.getURL('options.html#/library') });
  };

  return (
    <div className="popup">
      <div className="row between">
        <b>X Bookmark Vault</b>
        <button type="button" className="subtle" onClick={openLibrary}>
          Open library
        </button>
      </div>

      <div className="stat">
        <div className="stat-label">In your vault</div>
        <div className="stat-value tnum">{formatNumber(progress?.total ?? 0)}</div>
        <div className="stat-hint">
          {session
            ? `${formatNumber(session.new_count)} new · ${formatNumber(session.updated_count)} updated this sync`
            : 'No sync run yet'}
        </div>
      </div>

      {running || paused ? (
        <div>
          <ProgressBar value={running ? 0.6 : 0.3} />
          <div className="small muted" style={{ marginTop: 5 }}>
            {progress?.phase}
          </div>
        </div>
      ) : progress?.phase && progress.phase !== 'Idle' ? (
        <div className="small muted">{progress.phase}</div>
      ) : null}

      {classify?.running ? (
        <div className="small muted">
          Classifying {formatNumber(classify.processed)} / {formatNumber(classify.total)}
        </div>
      ) : null}

      {!attached ? (
        <div className="small muted">
          Open{' '}
          <a href={BOOKMARKS_URL} target="_blank" rel="noreferrer noopener">
            your X bookmarks
          </a>{' '}
          to enable syncing.
        </div>
      ) : null}

      {error ? (
        <div className="small" style={{ color: 'var(--danger)' }}>
          {error}
        </div>
      ) : null}

      <div className="popup-grid">
        {running ? (
          <button type="button" className="primary" disabled={busy} onClick={() => void send({ type: 'sync/pause' })}>
            Pause Sync
          </button>
        ) : paused ? (
          <button type="button" className="primary" disabled={busy} onClick={() => void send({ type: 'sync/resume' })}>
            Resume Sync
          </button>
        ) : (
          <button
            type="button"
            className="primary"
            disabled={busy || !attached}
            onClick={() => void send({ type: 'sync/start', mode: 'incremental' })}
          >
            Sync Bookmarks
          </button>
        )}

        <button
          type="button"
          disabled={busy || !attached || running || paused}
          onClick={() => void send({ type: 'sync/start', mode: 'full' })}
        >
          Full Rescan
        </button>
      </div>

      <div className="popup-grid">
        <button
          type="button"
          onClick={() => void chrome.tabs.create({ url: chrome.runtime.getURL('options.html#/classify') })}
        >
          Classify
        </button>
        <button
          type="button"
          onClick={() => void chrome.tabs.create({ url: chrome.runtime.getURL('options.html#/settings') })}
        >
          Settings
        </button>
      </div>
    </div>
  );
}

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root element');

createRoot(container).render(
  <StrictMode>
    <Popup />
  </StrictMode>,
);
