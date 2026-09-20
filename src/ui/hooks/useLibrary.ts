import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Bookmark, LibraryStats } from '../../shared/types';
import { getAllBookmarks } from '../../database/db';
import { buildSearchIndex, computeFacets, type SearchIndex } from '../../database/search';
import { isoWithinDays } from '../../shared/util';

export interface LibraryState {
  bookmarks: Bookmark[];
  index: SearchIndex;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
}

/**
 * Loads the whole library into memory once and keeps it in sync with
 * background changes. Thousands of records are a few megabytes, which buys
 * instant search and filtering without touching IndexedDB per keystroke.
 */
export function useLibrary(): LibraryState {
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [index, setIndex] = useState<SearchIndex>(() => new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const reloadPending = useRef(false);

  const reload = useCallback(async () => {
    try {
      const all = await getAllBookmarks();
      setBookmarks(all);
      setIndex(buildSearchIndex(all));
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    const listener = (message: unknown): void => {
      if (
        typeof message !== 'object' ||
        message === null ||
        (message as { type?: string }).type !== 'event/bookmarks-changed'
      ) {
        return;
      }
      // Coalesce the burst of change events a running sync produces.
      if (reloadPending.current) return;
      reloadPending.current = true;
      setTimeout(() => {
        reloadPending.current = false;
        void reload();
      }, 1200);
    };

    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, [reload]);

  return { bookmarks, index, loading, error, reload };
}

export function useLibraryStats(bookmarks: Bookmark[]): LibraryStats {
  return useMemo(() => {
    const facets = computeFacets(bookmarks);
    const classifiedCount = bookmarks.filter((b) => b.classification_status === 'classified').length;

    return {
      total: bookmarks.length,
      newThisWeek: bookmarks.filter((b) => isoWithinDays(b.collected_at, 7)).length,
      unclassified: bookmarks.length - classifiedCount,
      failed: bookmarks.filter((b) => b.classification_status === 'failed').length,
      categories: facets.categories.length,
      topCategories: facets.categories.slice(0, 8).map((c) => ({ name: c.value, count: c.count })),
      topAuthors: facets.authors.slice(0, 8).map((a) => ({
        name: a.name ?? a.value,
        handle: a.value,
        count: a.count,
      })),
      topRevisit: [...bookmarks]
        .filter((b) => b.revisit_score !== null)
        .sort((a, b) => (b.revisit_score ?? 0) - (a.revisit_score ?? 0))
        .slice(0, 6),
      withImages: bookmarks.filter((b) => b.image_urls.length > 0).length,
      withVideo: bookmarks.filter((b) => b.video_available).length,
      withExternalLink: bookmarks.filter((b) => b.external_urls.length > 0).length,
      favorites: bookmarks.filter((b) => b.favorite).length,
    };
  }, [bookmarks]);
}
