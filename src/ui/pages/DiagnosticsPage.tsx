import { useCallback, useEffect, useState } from 'react';
import type { Bookmark, DiagnosticEvent, SyncSession } from '../../shared/types';
import type { Settings } from '../../shared/settings';
import { sendToBackground } from '../../shared/messages';
import { clearDiagnostics, getRecentSyncSessions } from '../../database/db';
import { buildDiagnostics } from '../../export/diagnostics';
import { DB_NAME, DB_VERSION } from '../../database/schema';
import { jsonBlob } from '../../export/json';
import { downloadBlob } from '../lib/download';
import { extensionVersion } from '../lib/exports';
import { Card, EmptyState } from '../components/common';
import { formatDateTime, formatNumber, timestampSlug } from '../lib/format';
import { nowIso } from '../../shared/util';
import type { ToastMessage } from '../components/common';

export interface DiagnosticsPageProps {
  bookmarks: Bookmark[];
  settings: Settings;
  notify: (message: ToastMessage) => void;
}

export function DiagnosticsPage({ bookmarks, settings, notify }: DiagnosticsPageProps): JSX.Element {
  const [events, setEvents] = useState<DiagnosticEvent[]>([]);
  const [lastSync, setLastSync] = useState<SyncSession | null>(null);

  const load = useCallback(async () => {
    try {
      const [list, sessions] = await Promise.all([
        sendToBackground<DiagnosticEvent[]>({ type: 'diagnostics/list', limit: 200 }),
        getRecentSyncSessions(1),
      ]);
      setEvents(list);
      setLastSync(sessions[0] ?? null);
    } catch (error) {
      notify({ kind: 'error', text: error instanceof Error ? error.message : String(error) });
    }
  }, [notify]);

  useEffect(() => {
    void load();
  }, [load]);

  const exportReport = (): void => {
    const collected = bookmarks
      .map((b) => b.collected_at)
      .filter(Boolean)
      .sort();

    const report = buildDiagnostics({
      extensionVersion: extensionVersion(),
      bookmarkCount: bookmarks.length,
      classified: bookmarks.filter((b) => b.classification_status === 'classified').length,
      unclassified: bookmarks.filter((b) => b.classification_status === 'unclassified').length,
      failed: bookmarks.filter((b) => b.classification_status === 'failed').length,
      categories: new Set(bookmarks.map((b) => b.category).filter(Boolean)).size,
      oldestCollectedAt: collected[0] ?? null,
      newestCollectedAt: collected[collected.length - 1] ?? null,
      lastSync,
      settings,
      events,
      userAgent: typeof navigator === 'undefined' ? null : navigator.userAgent,
      language: typeof navigator === 'undefined' ? null : navigator.language,
      generatedAt: nowIso(),
    });

    downloadBlob(jsonBlob(report), `x-bookmark-vault-diagnostics-${timestampSlug()}.json`);
    notify({ kind: 'success', text: 'Diagnostics exported (no secrets, no bookmark text).' });
  };

  return (
    <>
      <div className="page-head">
        <h1>Diagnostics</h1>
        <p>
          This extension has no analytics and no telemetry. Nothing is reported anywhere
          automatically - this page is how you inspect what happened, and the export is yours to
          share or not.
        </p>
      </div>

      <Card
        title="Local report"
        actions={
          <div className="row">
            <button type="button" onClick={() => void load()}>
              Refresh
            </button>
            <button type="button" className="primary" onClick={exportReport}>
              Export diagnostics JSON
            </button>
          </div>
        }
      >
        <dl className="kv">
          <dt>Extension version</dt>
          <dd className="mono">{extensionVersion()}</dd>
          <dt>Database</dt>
          <dd className="mono">
            {DB_NAME} (schema v{DB_VERSION})
          </dd>
          <dt>Bookmarks stored</dt>
          <dd className="tnum">{formatNumber(bookmarks.length)}</dd>
          <dt>Last sync</dt>
          <dd>
            {lastSync
              ? `${lastSync.mode} · ${lastSync.status} · ${formatDateTime(lastSync.started_at)}`
              : 'none yet'}
          </dd>
          <dt>Browser</dt>
          <dd className="small mono">
            {typeof navigator === 'undefined' ? 'unknown' : navigator.userAgent}
          </dd>
        </dl>
        <p className="small muted" style={{ marginTop: 12, marginBottom: 0 }}>
          The export contains the fields above plus recent non-sensitive events. It never contains
          cookies, API keys, auth tokens or bookmark content.
        </p>
      </Card>

      <Card
        title="Recent events"
        actions={
          events.length > 0 ? (
            <button
              type="button"
              className="danger"
              onClick={() => {
                void clearDiagnostics().then(() => {
                  setEvents([]);
                  notify({ kind: 'success', text: 'Local event log cleared.' });
                });
              }}
            >
              Clear log
            </button>
          ) : null
        }
      >
        {events.length === 0 ? (
          <EmptyState title="No events logged">
            Sync and classification activity shows up here.
          </EmptyState>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: 150 }}>When</th>
                <th style={{ width: 62 }}>Level</th>
                <th style={{ width: 90 }}>Scope</th>
                <th>Message</th>
              </tr>
            </thead>
            <tbody>
              {events.map((event, position) => (
                <tr key={event.id ?? `${event.ts}-${position}`}>
                  <td className="small muted">{formatDateTime(event.ts)}</td>
                  <td
                    className="small"
                    style={{
                      color:
                        event.level === 'error'
                          ? 'var(--danger)'
                          : event.level === 'warn'
                            ? 'var(--warn)'
                            : 'var(--text-muted)',
                    }}
                  >
                    {event.level}
                  </td>
                  <td className="small mono">{event.scope}</td>
                  <td className="small">
                    {event.message}
                    {event.detail ? (
                      <div className="mono muted">{JSON.stringify(event.detail)}</div>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}
