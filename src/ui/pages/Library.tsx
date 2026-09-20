import { useCallback, useDeferredValue, useMemo, useState } from 'react';
import type { Bookmark } from '../../shared/types';
import {
  EMPTY_FILTERS,
  computeFacets,
  queryLibrary,
  type LibraryFilters,
  type SearchIndex,
  type SortKey,
} from '../../database/search';
import { bulkUpdateBookmarks, updateManualFields } from '../../database/db';
import { sendToBackground } from '../../shared/messages';
import { BookmarkCard } from '../components/BookmarkCard';
import { FilterPanel } from '../components/FilterPanel';
import { Banner, Card, EmptyState } from '../components/common';
import { exportCsv, exportJson } from '../lib/exports';
import { formatNumber } from '../lib/format';
import type { ToastMessage } from '../components/common';

const PAGE_SIZE = 40;

export interface LibraryProps {
  bookmarks: Bookmark[];
  index: SearchIndex;
  reload: () => Promise<void>;
  notify: (message: ToastMessage) => void;
  initialFilters?: Partial<LibraryFilters>;
}

export function Library({
  bookmarks,
  index,
  reload,
  notify,
  initialFilters,
}: LibraryProps): JSX.Element {
  const [filters, setFilters] = useState<LibraryFilters>({ ...EMPTY_FILTERS, ...initialFilters });
  const [sort, setSort] = useState<SortKey>('recently-collected');
  const [visible, setVisible] = useState(PAGE_SIZE);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [bulkCategory, setBulkCategory] = useState('');

  // Keeps typing responsive on a large library: the expensive query runs
  // against a deferred copy of the filter state.
  const deferredFilters = useDeferredValue(filters);

  const facets = useMemo(() => computeFacets(bookmarks), [bookmarks]);
  const results = useMemo(
    () => queryLibrary({ bookmarks, index, filters: deferredFilters, sort }),
    [bookmarks, index, deferredFilters, sort],
  );

  const patchFilters = useCallback((patch: Partial<LibraryFilters>) => {
    setFilters((current) => ({ ...current, ...patch }));
    setVisible(PAGE_SIZE);
  }, []);

  const toggleSelect = useCallback((postId: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(postId)) next.delete(postId);
      else next.add(postId);
      return next;
    });
  }, []);

  const onToggleFavorite = useCallback(
    async (bookmark: Bookmark) => {
      try {
        await updateManualFields(bookmark.post_id, { favorite: !bookmark.favorite });
        await reload();
      } catch (error) {
        notify({ kind: 'error', text: error instanceof Error ? error.message : String(error) });
      }
    },
    [notify, reload],
  );

  const onSaveNote = useCallback(
    async (bookmark: Bookmark, note: string, manualTags: string[]) => {
      try {
        await updateManualFields(bookmark.post_id, {
          personal_note: note.trim() === '' ? null : note.trim(),
          manual_tags: manualTags,
        });
        await reload();
        notify({ kind: 'success', text: 'Note saved locally.' });
      } catch (error) {
        notify({ kind: 'error', text: error instanceof Error ? error.message : String(error) });
      }
    },
    [notify, reload],
  );

  const shown = results.slice(0, visible);
  const selectedList = [...selected];

  return (
    <>
      <div className="page-head">
        <h1>Library</h1>
        <p>
          Everything is searched and filtered locally in this browser. Nothing here is sent
          anywhere.
        </p>
      </div>

      <div className="library">
        <FilterPanel filters={filters} facets={facets} onChange={patchFilters} />

        <div>
          <div className="toolbar">
            <input
              className="search"
              type="search"
              placeholder="Search text, author, category, tags, summary…"
              value={filters.query}
              onChange={(event) => patchFilters({ query: event.target.value })}
            />
            <select
              className="select-inline"
              value={sort}
              onChange={(event) => setSort(event.target.value as SortKey)}
              aria-label="Sort order"
            >
              <option value="recently-collected">Recently collected</option>
              <option value="newest">Newest posts</option>
              <option value="oldest">Oldest posts</option>
              <option value="revisit">Highest revisit score</option>
              <option value="likes">Most liked</option>
              <option value="author">Author</option>
            </select>
            <button
              type="button"
              onClick={() => {
                void exportCsv(results, 'filtered').then(() =>
                  notify({ kind: 'success', text: `Exported ${results.length} rows to CSV.` }),
                );
              }}
              disabled={results.length === 0}
            >
              Export filtered CSV
            </button>
            <button
              type="button"
              onClick={() => {
                void exportJson(results, 'filtered').then(() =>
                  notify({ kind: 'success', text: `Exported ${results.length} rows to JSON.` }),
                );
              }}
              disabled={results.length === 0}
            >
              Export filtered JSON
            </button>
          </div>

          <div className="row between small muted" style={{ marginBottom: 10 }}>
            <span>
              {formatNumber(results.length)} of {formatNumber(bookmarks.length)} bookmarks
              {filters.query ? ` matching “${filters.query}”` : ''}
            </span>
            {results.length > 0 ? (
              <button
                type="button"
                className="subtle"
                onClick={() => {
                  const pick = results[Math.floor(Math.random() * results.length)];
                  if (pick) window.open(pick.post_url, '_blank', 'noopener');
                }}
              >
                Random from these results
              </button>
            ) : null}
          </div>

          {selectedList.length > 0 ? (
            <Card>
              <div className="row">
                <b>{selectedList.length} selected</b>
                <button
                  type="button"
                  onClick={() => {
                    void sendToBackground({
                      type: 'classify/start',
                      scope: 'selected',
                      postIds: selectedList,
                    })
                      .then(() =>
                        notify({
                          kind: 'success',
                          text: `Reclassifying ${selectedList.length} bookmark(s).`,
                        }),
                      )
                      .catch((error: unknown) =>
                        notify({
                          kind: 'error',
                          text: error instanceof Error ? error.message : String(error),
                        }),
                      );
                  }}
                >
                  Reclassify Selected
                </button>
                <button
                  type="button"
                  onClick={() => {
                    for (const id of selectedList.slice(0, 15)) {
                      const bookmark = bookmarks.find((b) => b.post_id === id);
                      if (bookmark) window.open(bookmark.post_url, '_blank', 'noopener');
                    }
                  }}
                >
                  Open on X (max 15)
                </button>
                <input
                  type="text"
                  className="select-inline"
                  placeholder="Set category…"
                  value={bulkCategory}
                  onChange={(event) => setBulkCategory(event.target.value)}
                  style={{ width: 170 }}
                />
                <button
                  type="button"
                  disabled={bulkCategory.trim() === ''}
                  onClick={() => {
                    void bulkUpdateBookmarks(selectedList, { category: bulkCategory.trim() })
                      .then(async (count) => {
                        setBulkCategory('');
                        await reload();
                        notify({ kind: 'success', text: `Updated ${count} bookmark(s).` });
                      })
                      .catch((error: unknown) =>
                        notify({
                          kind: 'error',
                          text: error instanceof Error ? error.message : String(error),
                        }),
                      );
                  }}
                >
                  Apply category
                </button>
                <span className="spacer" />
                <button type="button" className="subtle" onClick={() => setSelected(new Set())}>
                  Clear selection
                </button>
              </div>
            </Card>
          ) : null}

          {results.length === 0 ? (
            <Card>
              <EmptyState
                title={bookmarks.length === 0 ? 'No bookmarks collected yet' : 'No matches'}
                action={
                  bookmarks.length > 0 ? (
                    <button type="button" onClick={() => setFilters({ ...EMPTY_FILTERS })}>
                      Reset all filters
                    </button>
                  ) : null
                }
              >
                {bookmarks.length === 0
                  ? 'Run a sync from the Sync tab to fill your library.'
                  : 'Try a broader search or clear some filters.'}
              </EmptyState>
            </Card>
          ) : (
            <>
              <div className="cards">
                {shown.map((bookmark) => (
                  <BookmarkCard
                    key={bookmark.post_id}
                    bookmark={bookmark}
                    selected={selected.has(bookmark.post_id)}
                    onToggleSelect={toggleSelect}
                    onToggleFavorite={(target) => void onToggleFavorite(target)}
                    onSaveNote={(target, note, tags) => void onSaveNote(target, note, tags)}
                    onFilterCategory={(category) => patchFilters({ categories: [category] })}
                  />
                ))}
              </div>

              {visible < results.length ? (
                <div className="row" style={{ justifyContent: 'center', marginTop: 16 }}>
                  <button type="button" onClick={() => setVisible((current) => current + PAGE_SIZE)}>
                    Show more ({formatNumber(results.length - visible)} remaining)
                  </button>
                </div>
              ) : null}
            </>
          )}

          {filters.query && results.length === 0 && bookmarks.length > 0 ? (
            <Banner>Search matches whole words and prefixes across post text, authors, categories, tags and summaries.</Banner>
          ) : null}
        </div>
      </div>
    </>
  );
}
