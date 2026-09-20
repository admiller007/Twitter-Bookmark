import { Card } from '../components/common';

export interface SetupProps {
  onGoToSync: () => void;
  onGoToSettings: () => void;
  onDismiss: () => void;
  hasBookmarks: boolean;
  hasApiKey: boolean;
}

export function Setup({
  onGoToSync,
  onGoToSettings,
  onDismiss,
  hasBookmarks,
  hasApiKey,
}: SetupProps): JSX.Element {
  return (
    <>
      <div className="page-head">
        <h1>Welcome to X Bookmark Vault</h1>
        <p>
          A local-first library of everything you have bookmarked on X. Your data stays in this
          browser; the only thing that can ever leave is the bookmark text you explicitly send to
          JEV for classification.
        </p>
      </div>

      <Card title="Getting started">
        <div className="steps">
          <Step
            n={1}
            title="Make sure you are logged in to X"
            body="The extension reuses the session you already have in this browser. It never asks for your username or password, and it never sends your cookies anywhere."
          />
          <Step
            n={2}
            title="Open your bookmarks page"
            body={
              <>
                Go to{' '}
                <a href="https://x.com/i/bookmarks" target="_blank" rel="noreferrer noopener">
                  https://x.com/i/bookmarks
                </a>{' '}
                and let it finish loading. A small control panel appears in the bottom-right corner
                of that page.
              </>
            }
          />
          <Step
            n={3}
            title="Click Sync Bookmarks"
            body="The first run walks your whole history, saving each post to IndexedDB as it is discovered. You can pause, resume, close the tab or quit Chrome; the run picks up where it left off."
          />
          <Step
            n={4}
            title="Optionally configure JEV"
            body={
              hasApiKey
                ? 'A JEV API key is configured. You can classify bookmarks whenever you like.'
                : 'Add a JEV API key in Settings to get categories, tags, content types and revisit scores. Everything else works without it.'
            }
          />
          <Step
            n={5}
            title="Classify, browse, export"
            body="Run Classify Unprocessed, then search and filter your library locally, and export the whole thing to CSV or JSON whenever you want."
          />
        </div>

        <div className="row" style={{ marginTop: 16 }}>
          <button type="button" className="primary big" onClick={onGoToSync}>
            {hasBookmarks ? 'Go to Sync' : 'Start my first sync'}
          </button>
          <button type="button" onClick={onGoToSettings}>
            Configure JEV
          </button>
          <span className="spacer" />
          <button type="button" className="subtle" onClick={onDismiss}>
            Don&apos;t show this again
          </button>
        </div>
      </Card>

      <Card title="What this extension can and cannot see">
        <div className="grid cols-2">
          <div>
            <h3 style={{ marginBottom: 6 }}>It uses</h3>
            <ul className="list-plain small">
              <li>The X bookmarks page rendered in your own logged-in tab</li>
              <li>Local storage in this browser profile (IndexedDB)</li>
              <li>The JEV endpoint, only if you configure a key and start a classification</li>
            </ul>
          </div>
          <div>
            <h3 style={{ marginBottom: 6 }}>It never</h3>
            <ul className="list-plain small">
              <li>Asks for, stores or transmits your X credentials</li>
              <li>Sends cookies or auth tokens anywhere</li>
              <li>Reports analytics, telemetry or usage data</li>
              <li>Runs remotely hosted code or uses eval</li>
            </ul>
          </div>
        </div>
      </Card>
    </>
  );
}

function Step({ n, title, body }: { n: number; title: string; body: React.ReactNode }): JSX.Element {
  return (
    <div className="step">
      <div className="step-num">{n}</div>
      <div className="step-body">
        <h3>{title}</h3>
        <p>{body}</p>
      </div>
    </div>
  );
}
