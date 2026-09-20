import { useState } from 'react';
import type { Bookmark } from '../../shared/types';
import { sendToBackground, type ClassifyProgress } from '../../shared/messages';
import { Banner, Card, EmptyState, ProgressBar, Stat } from '../components/common';
import { formatNumber, percent } from '../lib/format';
import { PROMPT_VERSION, REVISIT_LEVELS } from '../../classifier/prompt';
import type { ToastMessage } from '../components/common';

export interface ClassificationProps {
  bookmarks: Bookmark[];
  progress: ClassifyProgress | null;
  hasApiKey: boolean;
  notify: (message: ToastMessage) => void;
  onGoToSettings: () => void;
}

export function Classification({
  bookmarks,
  progress,
  hasApiKey,
  notify,
  onGoToSettings,
}: ClassificationProps): JSX.Element {
  const [busy, setBusy] = useState(false);

  const classified = bookmarks.filter((b) => b.classification_status === 'classified');
  const failed = bookmarks.filter((b) => b.classification_status === 'failed');
  const unprocessed = bookmarks.filter(
    (b) => b.classification_status === 'unclassified' || b.classification_status === 'pending',
  );

  const start = async (scope: 'unprocessed' | 'selected', postIds?: string[]): Promise<void> => {
    setBusy(true);
    try {
      await sendToBackground({ type: 'classify/start', scope, postIds });
      notify({ kind: 'success', text: 'Classification started.' });
    } catch (error) {
      notify({ kind: 'error', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="page-head">
        <h1>Classification</h1>
        <p>
          JEV is optional. Collecting, searching, browsing, backing up and exporting all work
          without it.
        </p>
      </div>

      {!hasApiKey ? (
        <Banner kind="info">
          No JEV API key is configured, so classification is disabled.{' '}
          <button type="button" className="subtle" onClick={onGoToSettings}>
            Add a key in Settings
          </button>
        </Banner>
      ) : null}

      <div className="grid cols-4">
        <Stat label="Classified" value={formatNumber(classified.length)} />
        <Stat label="Unprocessed" value={formatNumber(unprocessed.length)} />
        <Stat label="Failed" value={formatNumber(failed.length)} hint="retryable" />
        <Stat
          label="Coverage"
          value={bookmarks.length === 0 ? '—' : percent(classified.length / bookmarks.length)}
        />
      </div>

      <Card title="Run classification">
        {progress?.running ? (
          <div style={{ marginBottom: 12 }}>
            <ProgressBar value={progress.total === 0 ? 0 : progress.processed / progress.total} />
            <div className="small muted" style={{ marginTop: 6 }}>
              {progress.phase} {'·'} {formatNumber(progress.processed)} /{' '}
              {formatNumber(progress.total)} {'·'} {formatNumber(progress.succeeded)} ok,{' '}
              {formatNumber(progress.failed)} failed
            </div>
          </div>
        ) : progress?.phase && progress.phase !== 'Idle' ? (
          <p className="small muted">{progress.phase}</p>
        ) : null}

        {progress?.error ? <Banner kind="error">{progress.error}</Banner> : null}

        <div className="row">
          <button
            type="button"
            className="primary"
            disabled={busy || !hasApiKey || progress?.running || unprocessed.length + failed.length === 0}
            onClick={() => void start('unprocessed')}
          >
            Classify Unprocessed ({formatNumber(unprocessed.length + failed.length)})
          </button>

          <button
            type="button"
            disabled={busy || !hasApiKey || progress?.running || failed.length === 0}
            onClick={() => void start('selected', failed.map((b) => b.post_id))}
          >
            Retry Failed ({formatNumber(failed.length)})
          </button>

          <button
            type="button"
            disabled={busy || !hasApiKey || progress?.running || classified.length === 0}
            onClick={() => {
              const stale = classified.filter(
                (b) => !b.classifier_version?.endsWith(PROMPT_VERSION),
              );
              if (stale.length === 0) {
                notify({ kind: 'info', text: 'Every classification already uses the current prompt version.' });
                return;
              }
              void start('selected', stale.map((b) => b.post_id));
            }}
            title="Only reclassifies bookmarks classified with an older prompt version"
          >
            Reclassify Outdated
          </button>

          {progress?.running ? (
            <button
              type="button"
              onClick={() => {
                void sendToBackground({ type: 'classify/stop' }).catch(() => undefined);
              }}
            >
              Stop
            </button>
          ) : null}
        </div>

        <p className="small muted" style={{ marginTop: 12, marginBottom: 0 }}>
          To reclassify a specific set, select bookmarks in the Library and use{' '}
          <b>Reclassify Selected</b>. Nothing is ever reclassified automatically.
        </p>
      </Card>

      <Card title="How JEV is used">
        <p className="small muted">
          JEV is a decision model: it returns typed, calibrated answers rather than generated text.
          Each bookmark becomes one request containing a small state object and a set of typed
          questions ({<span className="mono">{PROMPT_VERSION}</span>}):
        </p>
        <table className="table">
          <thead>
            <tr>
              <th>Field</th>
              <th>JEV primitive</th>
              <th>How it is derived</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>category / subcategory</td>
              <td className="mono">choice</td>
              <td>Picked from the categories already in your library plus your seed list, so existing labels get reused.</td>
            </tr>
            <tr>
              <td>contentType</td>
              <td className="mono">choice</td>
              <td>One of the twelve fixed content types.</td>
            </tr>
            <tr>
              <td>actionable</td>
              <td className="mono">noul</td>
              <td>Yes/no probability, stored as true when at least 0.5.</td>
            </tr>
            <tr>
              <td>revisitScore</td>
              <td className="mono">score</td>
              <td>
                Position along a {REVISIT_LEVELS.length}-level rubric, normalised to 0.0 - 1.0.
              </td>
            </tr>
            <tr>
              <td>tags</td>
              <td className="mono">noul</td>
              <td>
                Candidate tags are derived locally from the post, then JEV votes on each one; only
                accepted tags are stored. The author&apos;s own hashtags are always kept.
              </td>
            </tr>
            <tr>
              <td>whySavedMightBeUseful</td>
              <td className="mono">choice</td>
              <td>JEV selects one of a fixed set of reasons, so no prose is invented.</td>
            </tr>
            <tr>
              <td>summary</td>
              <td className="mono">n/a</td>
              <td>
                Taken verbatim from the post&apos;s own opening sentences. JEV does not generate
                text, and nothing is invented about links it has not seen.
              </td>
            </tr>
          </tbody>
        </table>
      </Card>

      {bookmarks.length === 0 ? (
        <Card>
          <EmptyState title="Nothing to classify yet">Run a sync first.</EmptyState>
        </Card>
      ) : null}
    </>
  );
}
