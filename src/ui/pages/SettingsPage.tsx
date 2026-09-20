import { useEffect, useRef, useState } from 'react';
import type { Bookmark } from '../../shared/types';
import {
  DEFAULT_SETTINGS,
  JEV_DATA_NEVER_SENT,
  JEV_DATA_SENT_DESCRIPTION,
  type Settings,
} from '../../shared/settings';
import { sendToBackground } from '../../shared/messages';
import { Banner, Card } from '../components/common';
import { exportBackup, exportCsv, exportJson, importBackupFile } from '../lib/exports';
import type { ToastMessage } from '../components/common';

export interface SettingsPageProps {
  settings: Settings;
  update: (patch: Partial<Settings>) => Promise<void>;
  bookmarks: Bookmark[];
  reload: () => Promise<void>;
  notify: (message: ToastMessage) => void;
}

export function SettingsPage({
  settings,
  update,
  bookmarks,
  reload,
  notify,
}: SettingsPageProps): JSX.Element {
  const [apiKey, setApiKey] = useState(settings.jevApiKey);
  const [showKey, setShowKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [hasHostPermission, setHasHostPermission] = useState<boolean | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => setApiKey(settings.jevApiKey), [settings.jevApiKey]);

  const originPattern = (() => {
    try {
      return `${new URL(settings.jevBaseUrl).origin}/*`;
    } catch {
      return null;
    }
  })();

  useEffect(() => {
    if (!originPattern) {
      setHasHostPermission(null);
      return;
    }
    void chrome.permissions
      .contains({ origins: [originPattern] })
      .then(setHasHostPermission)
      .catch(() => setHasHostPermission(null));
  }, [originPattern]);

  const requestPermission = async (): Promise<void> => {
    if (!originPattern) return;
    try {
      const granted = await chrome.permissions.request({ origins: [originPattern] });
      setHasHostPermission(granted);
      notify({
        kind: granted ? 'success' : 'error',
        text: granted
          ? `Network access granted for ${originPattern}.`
          : 'Permission was declined, so JEV requests will be blocked.',
      });
    } catch (error) {
      notify({ kind: 'error', text: error instanceof Error ? error.message : String(error) });
    }
  };

  const testConnection = async (): Promise<void> => {
    setTesting(true);
    try {
      const result = await sendToBackground<{ model: string }>({ type: 'classify/test' });
      notify({ kind: 'success', text: `JEV responded. Model: ${result.model}` });
    } catch (error) {
      notify({ kind: 'error', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setTesting(false);
    }
  };

  return (
    <>
      <div className="page-head">
        <h1>Settings</h1>
        <p>Your bookmarks, notes and classifications stay in this browser.</p>
      </div>

      <Card title="JEV classification (optional)">
        <label className="field">
          <span>JEV API key</span>
          <div className="row">
            <input
              type={showKey ? 'text' : 'password'}
              value={apiKey}
              placeholder="Paste your TypeSafe / JEV API key"
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setApiKey(event.target.value)}
              onBlur={() => {
                if (apiKey !== settings.jevApiKey) void update({ jevApiKey: apiKey.trim() });
              }}
            />
            <button type="button" onClick={() => setShowKey((v) => !v)}>
              {showKey ? 'Hide' : 'Show'}
            </button>
          </div>
          <small>
            Stored with chrome.storage.local in this browser profile only. It is never written into
            the bookmark database, exports, backups or diagnostics, and never logged.
          </small>
        </label>

        <div className="grid cols-2">
          <label className="field">
            <span>API endpoint</span>
            <input
              type="text"
              value={settings.jevBaseUrl}
              onChange={(event) => void update({ jevBaseUrl: event.target.value })}
            />
            <small>Default: {DEFAULT_SETTINGS.jevBaseUrl}</small>
          </label>
          <label className="field">
            <span>Model</span>
            <input
              type="text"
              value={settings.jevModel}
              onChange={(event) => void update({ jevModel: event.target.value })}
            />
            <small>Default: {DEFAULT_SETTINGS.jevModel}</small>
          </label>
        </div>

        {originPattern && hasHostPermission === false ? (
          <Banner kind="info">
            Chrome needs your permission before the extension can reach{' '}
            <span className="mono">{originPattern}</span>. The extension requests no host access at
            install time, so you grant only this one endpoint.{' '}
            <button type="button" onClick={() => void requestPermission()}>
              Grant network access
            </button>
          </Banner>
        ) : null}

        <div className="grid cols-2">
          <label className="field">
            <span>Bookmarks classified in parallel</span>
            <input
              type="number"
              min={1}
              max={12}
              value={settings.jevConcurrency}
              onChange={(event) => void update({ jevConcurrency: Number(event.target.value) })}
            />
            <small>Lower this if you hit rate limits.</small>
          </label>
          <label className="field">
            <span>Attempts per request</span>
            <input
              type="number"
              min={1}
              max={8}
              value={settings.jevMaxRetries}
              onChange={(event) => void update({ jevMaxRetries: Number(event.target.value) })}
            />
            <small>Retries use exponential backoff with jitter.</small>
          </label>
        </div>

        <div className="row">
          <button type="button" onClick={() => void testConnection()} disabled={testing || !settings.jevApiKey}>
            {testing ? 'Testing…' : 'Test connection'}
          </button>
          {settings.jevApiKey ? (
            <button
              type="button"
              className="danger"
              onClick={() => {
                setApiKey('');
                void update({ jevApiKey: '' });
                notify({ kind: 'success', text: 'API key removed from this browser.' });
              }}
            >
              Remove key
            </button>
          ) : null}
        </div>
      </Card>

      <Card title="What is sent to JEV">
        <p className="small muted">
          Only when you run a classification, and only for the bookmarks being classified. If no API
          key is set, nothing leaves your browser at all.
        </p>
        <div className="grid cols-2">
          <div>
            <h3 style={{ marginBottom: 6 }}>Sent</h3>
            <ul className="list-plain small">
              {JEV_DATA_SENT_DESCRIPTION.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
          <div>
            <h3 style={{ marginBottom: 6 }}>Never sent</h3>
            <ul className="list-plain small">
              {JEV_DATA_NEVER_SENT.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
        </div>
      </Card>

      <Card title="Categories JEV should prefer">
        <label className="field">
          <span>Seed categories (one per line)</span>
          <textarea
            rows={8}
            value={settings.seedCategories.join('\n')}
            onChange={(event) =>
              void update({
                seedCategories: event.target.value
                  .split('\n')
                  .map((line) => line.trim())
                  .filter(Boolean),
              })
            }
          />
          <small>
            Categories already used in your library are always offered first, so JEV reuses them
            instead of inventing near-duplicates. These seeds are offered alongside them.
          </small>
        </label>
        <button type="button" onClick={() => void update({ seedCategories: DEFAULT_SETTINGS.seedCategories })}>
          Reset to defaults
        </button>
      </Card>

      <Card title="Sync behaviour">
        <div className="grid cols-2">
          <label className="field">
            <span>Stop after N consecutive known bookmarks</span>
            <input
              type="number"
              min={1}
              max={500}
              value={settings.incrementalKnownThreshold}
              onChange={(event) =>
                void update({ incrementalKnownThreshold: Number(event.target.value) })
              }
            />
            <small>
              Incremental syncs only. Default {DEFAULT_SETTINGS.incrementalKnownThreshold}. Full
              Rescan always ignores this.
            </small>
          </label>
          <label className="field">
            <span>Quiet scroll attempts before finishing</span>
            <input
              type="number"
              min={2}
              max={30}
              value={settings.emptyRoundLimit}
              onChange={(event) => void update({ emptyRoundLimit: Number(event.target.value) })}
            />
            <small>How many scrolls with zero new posts end a sync.</small>
          </label>
          <label className="field">
            <span>Wait after each scroll (ms)</span>
            <input
              type="number"
              min={200}
              max={8000}
              step={100}
              value={settings.scrollDelayMs}
              onChange={(event) => void update({ scrollDelayMs: Number(event.target.value) })}
            />
            <small>Raise this on a slow connection or if X rate-limits you.</small>
          </label>
          <label className="field">
            <span>Scroll step (fraction of a screen)</span>
            <input
              type="number"
              min={0.2}
              max={0.95}
              step={0.05}
              value={settings.scrollStepRatio}
              onChange={(event) => void update({ scrollStepRatio: Number(event.target.value) })}
            />
            <small>Below 1.0 so no post scrolls past without being rendered.</small>
          </label>
        </div>

        <label className="check">
          <input
            type="checkbox"
            checked={settings.enableNetworkEnhancement}
            onChange={(event) => void update({ enableNetworkEnhancement: event.target.checked })}
          />
          <span>
            Use X&apos;s own API responses as an enhancement
            <small>
              Reads JSON the page already fetched to fill in full link URLs, exact counts and reply
              ids. Purely additive: the DOM extractor runs either way, so turning this off (or X
              changing its API) does not stop collection.
            </small>
          </span>
        </label>

        <label className="check">
          <input
            type="checkbox"
            checked={settings.detectUnbookmarkedOnFullRescan}
            onChange={(event) =>
              void update({ detectUnbookmarkedOnFullRescan: event.target.checked })
            }
          />
          <span>
            Detect removed bookmarks during a Full Rescan
            <small>
              Flags records not seen during a full rescan as no longer bookmarked. They are never
              deleted, and incremental syncs never flag anything.
            </small>
          </span>
        </label>
      </Card>

      <Card title="Export and backup">
        <div className="row">
          <button
            type="button"
            className="primary"
            disabled={bookmarks.length === 0}
            onClick={() => {
              void exportCsv(bookmarks, 'all')
                .then((count) => notify({ kind: 'success', text: `Exported ${count} rows to CSV.` }))
                .catch((error: unknown) =>
                  notify({ kind: 'error', text: error instanceof Error ? error.message : String(error) }),
                );
            }}
          >
            Export CSV
          </button>
          <button
            type="button"
            disabled={bookmarks.length === 0}
            onClick={() => {
              void exportJson(bookmarks, 'all').then((count) =>
                notify({ kind: 'success', text: `Exported ${count} records to JSON.` }),
              );
            }}
          >
            Export JSON
          </button>
          <button
            type="button"
            disabled={bookmarks.length === 0}
            onClick={() => {
              void exportBackup(bookmarks).then((count) =>
                notify({ kind: 'success', text: `Backed up ${count} records.` }),
              );
            }}
          >
            Export Backup
          </button>
          <button type="button" onClick={() => fileInput.current?.click()}>
            Import Backup
          </button>
          <input
            ref={fileInput}
            type="file"
            accept="application/json,.json"
            style={{ display: 'none' }}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (!file) return;
              void importBackupFile(file, bookmarks)
                .then(async (result) => {
                  await reload();
                  notify({
                    kind: 'success',
                    text: `Imported: ${result.inserted} added, ${result.merged} merged, ${result.unchanged} already up to date.`,
                  });
                })
                .catch((error: unknown) =>
                  notify({ kind: 'error', text: error instanceof Error ? error.message : String(error) }),
                );
            }}
          />
        </div>
        <p className="small muted" style={{ marginTop: 10, marginBottom: 0 }}>
          CSV is UTF-8 with a byte-order mark so Excel renders emoji correctly. Lists such as tags
          and URLs are separated inside a cell by <span className="mono">|</span>. Importing merges
          by post id, so re-importing a backup never creates duplicates.
        </p>
      </Card>

      <Card title="Appearance">
        <label className="field">
          <span>Theme</span>
          <select
            className="select-inline"
            value={settings.theme}
            onChange={(event) => void update({ theme: event.target.value as Settings['theme'] })}
          >
            <option value="system">Match system</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </label>
      </Card>
    </>
  );
}
