import type { ContentType } from '../../shared/types';
import type { Facets, LibraryFilters } from '../../database/search';
import { EMPTY_FILTERS } from '../../database/search';
import { Card } from './common';

export interface FilterPanelProps {
  filters: LibraryFilters;
  facets: Facets;
  onChange: (patch: Partial<LibraryFilters>) => void;
}

function toggle<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}

function FacetList({
  rows,
  selected,
  onToggle,
  limit = 12,
}: {
  rows: Array<{ value: string; count: number; label?: string }>;
  selected: string[];
  onToggle: (value: string) => void;
  limit?: number;
}): JSX.Element {
  // Selected values stay visible even when they fall outside the top N.
  const visible = rows.slice(0, limit);
  for (const value of selected) {
    if (!visible.some((row) => row.value === value)) {
      const found = rows.find((row) => row.value === value);
      if (found) visible.push(found);
    }
  }

  if (visible.length === 0) return <p className="small muted">None yet.</p>;

  return (
    <div>
      {visible.map((row) => (
        <button
          type="button"
          key={row.value}
          className={`facet${selected.includes(row.value) ? ' on' : ''}`}
          onClick={() => onToggle(row.value)}
        >
          <span>{row.label ?? row.value}</span>
          <span>{row.count}</span>
        </button>
      ))}
    </div>
  );
}

export function FilterPanel({ filters, facets, onChange }: FilterPanelProps): JSX.Element {
  const activeCount =
    filters.categories.length +
    filters.subcategories.length +
    filters.contentTypes.length +
    filters.tags.length +
    filters.authors.length +
    filters.domains.length +
    (filters.actionable !== 'any' ? 1 : 0) +
    (filters.minRevisit > 0 ? 1 : 0) +
    (filters.hasImages ? 1 : 0) +
    (filters.hasVideo ? 1 : 0) +
    (filters.hasExternalLink ? 1 : 0) +
    (filters.favoritesOnly ? 1 : 0) +
    (filters.classification !== 'any' ? 1 : 0);

  return (
    <div className="filter-panel">
      <Card
        title={<h2>Filters</h2>}
        actions={
          activeCount > 0 ? (
            <button
              type="button"
              className="subtle"
              onClick={() => onChange({ ...EMPTY_FILTERS, query: filters.query })}
            >
              Clear {activeCount}
            </button>
          ) : null
        }
      >
        <div className="filter-group">
          <h3>Status</h3>
          <select
            value={filters.classification}
            onChange={(event) =>
              onChange({ classification: event.target.value as LibraryFilters['classification'] })
            }
          >
            <option value="any">All bookmarks</option>
            <option value="classified">Classified</option>
            <option value="unclassified">Unclassified</option>
            <option value="failed">Classification failed</option>
          </select>
        </div>

        <div className="filter-group">
          <h3>Category</h3>
          <FacetList
            rows={facets.categories}
            selected={filters.categories}
            onToggle={(value) => onChange({ categories: toggle(filters.categories, value) })}
          />
        </div>

        <div className="filter-group">
          <h3>Subcategory</h3>
          <FacetList
            rows={facets.subcategories}
            selected={filters.subcategories}
            onToggle={(value) => onChange({ subcategories: toggle(filters.subcategories, value) })}
            limit={8}
          />
        </div>

        <div className="filter-group">
          <h3>Content type</h3>
          <FacetList
            rows={facets.contentTypes}
            selected={filters.contentTypes}
            onToggle={(value) =>
              onChange({ contentTypes: toggle(filters.contentTypes, value as ContentType) })
            }
            limit={12}
          />
        </div>

        <div className="filter-group">
          <h3>Tags</h3>
          <FacetList
            rows={facets.tags}
            selected={filters.tags}
            onToggle={(value) => onChange({ tags: toggle(filters.tags, value) })}
            limit={12}
          />
        </div>

        <div className="filter-group">
          <h3>Author</h3>
          <FacetList
            rows={facets.authors.map((author) => ({
              value: author.value,
              count: author.count,
              label: `@${author.value}`,
            }))}
            selected={filters.authors}
            onToggle={(value) => onChange({ authors: toggle(filters.authors, value) })}
            limit={10}
          />
        </div>

        <div className="filter-group">
          <h3>Link domain</h3>
          <FacetList
            rows={facets.domains}
            selected={filters.domains}
            onToggle={(value) => onChange({ domains: toggle(filters.domains, value) })}
            limit={10}
          />
        </div>

        <div className="filter-group">
          <h3>Attributes</h3>
          <label className="check">
            <input
              type="checkbox"
              checked={filters.hasImages}
              onChange={(event) => onChange({ hasImages: event.target.checked })}
            />
            <span>Has images</span>
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={filters.hasVideo}
              onChange={(event) => onChange({ hasVideo: event.target.checked })}
            />
            <span>Has video</span>
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={filters.hasExternalLink}
              onChange={(event) => onChange({ hasExternalLink: event.target.checked })}
            />
            <span>Has external link</span>
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={filters.favoritesOnly}
              onChange={(event) => onChange({ favoritesOnly: event.target.checked })}
            />
            <span>Favourites only</span>
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={!filters.includeUnbookmarked}
              onChange={(event) => onChange({ includeUnbookmarked: !event.target.checked })}
            />
            <span>Still bookmarked on X only</span>
          </label>
        </div>

        <div className="filter-group">
          <h3>Actionable</h3>
          <select
            value={filters.actionable}
            onChange={(event) =>
              onChange({ actionable: event.target.value as LibraryFilters['actionable'] })
            }
          >
            <option value="any">Any</option>
            <option value="yes">Actionable</option>
            <option value="no">Not actionable</option>
          </select>
        </div>

        <div className="filter-group">
          <h3>Minimum revisit score: {Math.round(filters.minRevisit * 100)}%</h3>
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={Math.round(filters.minRevisit * 100)}
            onChange={(event) => onChange({ minRevisit: Number(event.target.value) / 100 })}
          />
        </div>
      </Card>
    </div>
  );
}
