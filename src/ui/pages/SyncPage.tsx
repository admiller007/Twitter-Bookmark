import { useEffect, useState } from 'react';
import type { SyncSession } from '../../shared/types';
import { sendToBackground, type SyncProgress } from '../../shared/messages';
import { getRecentSyncSessions } from '../../database/db';
import { Banner, Card, ProgressBar, Stat } from '../components/common';
import { formatDateTime, formatNumber, formatRelative } from '../lib/format';
import type { ToastMessage } from '../components/common';

const BOOKMARKS_URL = 'https://x.com/i/bookmarks';

export interface SyncPageProps {
  progress: SyncProgress | null;
  refresh: () => Promise<void>;
  notify: (message: ToastMessage) => void;
  knownThreshold: number;
}

export function SyncPage({ progress, refresh, notify, knownThreshold }: SyncPageProps): JSX.Element {
  const [history, setHistory] = useState<SyncSession[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void getRecentSyncSessions(8).then(setHistory);
  }, [progress?.session?.status, progress?.session?.sync_id]);

  const session = progress?.session ?? null;
  const running = session?.status === 'running';
  const paused = session?.status === 'paused';
  const attached = progress?.attached ?? false;

  const run = async (request: Parameters<typeof sendToBackground>[0], label: string): Promise<void> => {
    setBusy(true);
    try {
      await sendToBackground(request);
      await refresh();
      notify({ kind: 'success', text: label });
    } catch (error) {
      notify({ kind: 'error', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="page-head">
        <h1>Sync</h1>
        <p>
          Collection reads the bookmarks page you are already logged into. The extension never sees
          your password and never sends your session cookies anywhere.
        </p>
      </div>

      {!attached ? (
        <Banner kind="info">
          No X bookmarks tab is connected.{' '}
          <a href={BOOKMARKS_URL} target="_blank" rel="noreferrer noopener">
            Open {BOOKMARKS_URL}
          </a>{' '}
          and let it finish loading, then come back here (or use the panel in the corner of that
          page).
        </Banner>
      ) : null}

      {session?.status === 'error' && session.error_message ? (
        <Banner kind="error">{session.error_message}</Banner>
      ) : null}

      <Card
        title="Collection"
        actions={<span className="small muted">{progress?.phase ?? 'Idle'}</span>}
      >
        <div className="grid cols-4" style={{ marginBottom: 14 }}>
          <Stat label="In your vault" value={formatNumber(progress?.total ?? 0)} />
          <Stat label="New this sync" value={formatNumber(session?.new_count ?? 0)} />
          <Stat label="Updated" value={formatNumber(session?.updated_count ?? 0)} />
          <Stat label="Seen this sync" value={formatNumber(session?.seen_count ?? 0)} />
        </div>

        {running || paused ? (
          <div style={{ marginBottom: 14 }}>
            <ProgressBar value={session ? Math.min(0.95, session.seen_count / Math.max(50, session.seen_count + 40)) : 0} />
            <div className="small muted" style={{ marginTop: 6 }}>
              {session?.mode === 'full' ? 'Full rescan' : 'Incremental sync'} {'·'} streak of{' '}
              {session?.consecutive_known_count ?? 0} already-known bookmarks (stops at{' '}
              {knownThreshold})
              {session && session.empty_rounds > 0
                ? ` · ${session.empty_rounds} quiet scroll attempt(s)`
                : ''}
            </div>
          </div>
        ) : null}

        <div className="row">
          {running ? (
            <button type="button" className="primary big" disabled={busy} onClick={() => void run({ type: 'sync/pause' }, 'Sync paused.')}>
              Pause Sync
            </button>
          ) : paused ? (
            <button type="button" className="primary big" disabled={busy} onClick={() => void run({ type: 'sync/resume' }, 'Sync resumed.')}>
              Resume Sync
            </button>
          ) : (
            <button
              type="button"
              className="primary big"
              disabled={busy || !attached}
              onClick={() => void run({ type: 'sync/start', mode: 'incremental' }, 'Sync started.')}
            >
              Sync Bookmarks
            </button>
          )}

          <button
            type="button"
            disabled={busy || !attached || running || paused}
            onClick={() => void run({ type: 'sync/start', mode: 'full' }, 'Full rescan started.')}
            title="Scan the entire bookmark history, ignoring the incremental stop heuristic"
          >
            Full Rescan
          </button>

          {running || paused ? (
            <button type="button" disabled={busy} onClick={() => void run({ type: 'sync/stop' }, 'Sync stopped.')}>
              Stop
            </button>
          ) : null}

          <span className="spacer" />
          <a className="btn" href={BOOKMARKS_URL} target="_blank" rel="noreferrer noopener">
            Open X bookmarks
          </a>
        </div>
      </Card>

      <Card title="How syncing works">
        <ol className="list-plain small muted">
          <li>
            Posts are extracted the moment they render and saved to IndexedDB immediately, before X
            can recycle them out of the page.
          </li>
          <li>
            The X post id is the primary key, so re-syncing updates existing records instead of
            duplicating them.
          </li>
          <li>
            An incremental sync stops once it has seen {knownThreshold} bookmarks in a row that are
            already in your library. Any unknown bookmark resets that streak.
          </li>
          <li>
            A Full Rescan ignores that heuristic and walks the entire history. Only a full rescan can
            flag bookmarks you removed on X, and even then it flags rather than deletes.
          </li>
          <li>
            Progress is persisted continuously, so closing the tab, quitting Chrome or an error
            leaves the run resumable.
          </li>
        </ol>
      </Card>

      <Card title="Recent syncs">
        {history.length === 0 ? (
          <p className="small muted">No syncs yet.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Started</th>
                <th>Mode</th>
                <th>Status</th>
                <th>New</th>
                <th>Updated</th>
                <th>Seen</th>
                <th>Outcome</th>
              </tr>
            </thead>
            <tbody>
              {history.map((entry) => (
                <tr key={entry.sync_id}>
                  <td title={formatDateTime(entry.started_at)}>{formatRelative(entry.started_at)}</td>
                  <td>{entry.mode}</td>
                  <td>{entry.status}</td>
                  <td className="tnum">{formatNumber(entry.new_count)}</td>
                  <td className="tnum">{formatNumber(entry.updated_count)}</td>
                  <td className="tnum">{formatNumber(entry.seen_count)}</td>
                  <td className="small muted">{entry.error_message ?? entry.stop_reason ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}
