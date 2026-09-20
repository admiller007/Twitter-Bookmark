import type { Bookmark, LibraryStats } from '../../shared/types';
import { BarList, Card, EmptyState, Stat } from '../components/common';
import { formatNumber, formatRelative, percent } from '../lib/format';

export interface DashboardProps {
  bookmarks: Bookmark[];
  stats: LibraryStats;
  onGoToSync: () => void;
  onGoToLibrary: () => void;
  onOpenRandom: () => void;
}

export function Dashboard({
  bookmarks,
  stats,
  onGoToSync,
  onGoToLibrary,
  onOpenRandom,
}: DashboardProps): JSX.Element {
  if (bookmarks.length === 0) {
    return (
      <>
        <div className="page-head">
          <h1>Dashboard</h1>
          <p>Nothing has been collected yet.</p>
        </div>
        <Card>
          <EmptyState
            title="Your vault is empty"
            action={
              <button type="button" className="primary big" onClick={onGoToSync}>
                Go to Sync
              </button>
            }
          >
            Open <span className="mono">https://x.com/i/bookmarks</span> while logged in, then run
            your first sync. Everything is stored locally in this browser.
          </EmptyState>
        </Card>
      </>
    );
  }

  const classified = stats.total - stats.unclassified;
  const monthly = groupByMonth(bookmarks).slice(0, 8);

  return (
    <>
      <div className="page-head">
        <h1>Dashboard</h1>
        <p>A local overview of everything you have saved from X.</p>
      </div>

      <div className="grid cols-4">
        <Stat label="Total bookmarks" value={formatNumber(stats.total)} />
        <Stat label="New this week" value={formatNumber(stats.newThisWeek)} hint="by collection date" />
        <Stat
          label="Unclassified"
          value={formatNumber(stats.unclassified)}
          hint={stats.failed > 0 ? `${stats.failed} failed` : `${formatNumber(classified)} classified`}
        />
        <Stat label="Categories" value={formatNumber(stats.categories)} />
      </div>

      <div className="grid cols-2" style={{ marginTop: 14 }}>
        <Card title="Top categories">
          {stats.topCategories.length === 0 ? (
            <p className="small muted">
              Nothing classified yet. Configure JEV in Settings, then run Classify Unprocessed.
            </p>
          ) : (
            <BarList rows={stats.topCategories.map((c) => ({ label: c.name, count: c.count }))} />
          )}
        </Card>

        <Card title="Top authors">
          <BarList rows={stats.topAuthors.map((a) => ({ label: `@${a.handle ?? a.name}`, count: a.count }))} />
        </Card>
      </div>

      <div className="grid cols-2" style={{ marginTop: 14 }}>
        <Card
          title="Highest revisit score"
          actions={
            <button type="button" className="subtle" onClick={onGoToLibrary}>
              Open library
            </button>
          }
        >
          {stats.topRevisit.length === 0 ? (
            <p className="small muted">Revisit scores appear after JEV classification.</p>
          ) : (
            <table className="table">
              <tbody>
                {stats.topRevisit.map((bookmark) => (
                  <tr key={bookmark.post_id}>
                    <td style={{ width: 52 }} className="tnum">
                      <b>{percent(bookmark.revisit_score)}</b>
                    </td>
                    <td>
                      <a href={bookmark.post_url} target="_blank" rel="noreferrer noopener">
                        {bookmark.summary ?? bookmark.text?.slice(0, 90) ?? bookmark.post_id}
                      </a>
                      <div className="small muted">
                        {bookmark.author_handle ? `@${bookmark.author_handle}` : 'unknown'}
                        {bookmark.category ? ` · ${bookmark.category}` : ''}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <Card title="Library composition">
          <dl className="kv">
            <dt>With images</dt>
            <dd className="tnum">{formatNumber(stats.withImages)}</dd>
            <dt>With video</dt>
            <dd className="tnum">{formatNumber(stats.withVideo)}</dd>
            <dt>With external link</dt>
            <dd className="tnum">{formatNumber(stats.withExternalLink)}</dd>
            <dt>Favourites</dt>
            <dd className="tnum">{formatNumber(stats.favorites)}</dd>
            <dt>Most recent collection</dt>
            <dd>{formatRelative(mostRecent(bookmarks))}</dd>
          </dl>
          <div className="row" style={{ marginTop: 12 }}>
            <button type="button" onClick={onOpenRandom}>
              Open a random bookmark
            </button>
          </div>
        </Card>
      </div>

      {monthly.length > 0 ? (
        <Card title="Bookmarks by month posted">
          <BarList rows={monthly} />
        </Card>
      ) : null}
    </>
  );
}

function mostRecent(bookmarks: Bookmark[]): string | null {
  let latest: string | null = null;
  for (const bookmark of bookmarks) {
    if (!latest || bookmark.collected_at > latest) latest = bookmark.collected_at;
  }
  return latest;
}

function groupByMonth(bookmarks: Bookmark[]): Array<{ label: string; count: number }> {
  const counts = new Map<string, number>();
  for (const bookmark of bookmarks) {
    if (!bookmark.posted_at) continue;
    const key = bookmark.posted_at.slice(0, 7);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([label, count]) => ({ label, count }));
}
