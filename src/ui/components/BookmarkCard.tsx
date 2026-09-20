import { useState } from 'react';
import type { Bookmark } from '../../shared/types';
import { formatCompact, formatDate, percent } from '../lib/format';

export interface BookmarkCardProps {
  bookmark: Bookmark;
  selected: boolean;
  onToggleSelect: (postId: string) => void;
  onToggleFavorite: (bookmark: Bookmark) => void;
  onSaveNote: (bookmark: Bookmark, note: string, manualTags: string[]) => void;
  onFilterCategory: (category: string) => void;
}

export function BookmarkCard({
  bookmark,
  selected,
  onToggleSelect,
  onToggleFavorite,
  onSaveNote,
  onFilterCategory,
}: BookmarkCardProps): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState(bookmark.personal_note ?? '');
  const [manualTags, setManualTags] = useState(bookmark.manual_tags.join(', '));
  const [copied, setCopied] = useState(false);

  const thumbnail = bookmark.media_thumbnail_urls[0] ?? bookmark.image_urls[0] ?? null;
  const tags = [...bookmark.tags, ...bookmark.manual_tags].slice(0, 8);

  return (
    <article className={`bookmark${selected ? ' selected' : ''}`}>
      <div className="bookmark-head">
        <input
          type="checkbox"
          checked={selected}
          onChange={() => onToggleSelect(bookmark.post_id)}
          aria-label={`Select post ${bookmark.post_id}`}
        />
        <span className="bookmark-author">{bookmark.author_name ?? 'Unknown author'}</span>
        {bookmark.author_handle ? (
          <span className="bookmark-handle">@{bookmark.author_handle}</span>
        ) : null}
        <span className="bookmark-date">{formatDate(bookmark.posted_at)}</span>
      </div>

      {bookmark.text ? (
        <div className="bookmark-text">
          {bookmark.text.length > 420 ? `${bookmark.text.slice(0, 420)}…` : bookmark.text}
        </div>
      ) : (
        <div className="bookmark-text muted">(no text in this post)</div>
      )}

      {bookmark.quoted_post_text ? (
        <div className="quoted">
          {bookmark.quoted_post_author ? <b>@{bookmark.quoted_post_author}: </b> : null}
          {bookmark.quoted_post_text.length > 180
            ? `${bookmark.quoted_post_text.slice(0, 180)}…`
            : bookmark.quoted_post_text}
        </div>
      ) : null}

      {thumbnail ? (
        <img
          className="bookmark-thumb"
          src={thumbnail}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={(event) => {
            event.currentTarget.style.display = 'none';
          }}
        />
      ) : null}

      {bookmark.category ? (
        <button
          type="button"
          className="subtle bookmark-path"
          style={{ alignSelf: 'flex-start', padding: 0 }}
          onClick={() => onFilterCategory(bookmark.category as string)}
          title="Filter by this category"
        >
          {bookmark.category}
          {bookmark.subcategory ? ` → ${bookmark.subcategory}` : ''}
        </button>
      ) : (
        <span className="tag">unclassified</span>
      )}

      {tags.length > 0 ? (
        <div className="bookmark-tags">
          {tags.map((tag) => (
            <span className="tag" key={tag}>
              {tag}
            </span>
          ))}
        </div>
      ) : null}

      {bookmark.summary ? <div className="small muted">{bookmark.summary}</div> : null}

      {bookmark.classification_status === 'failed' && bookmark.classification_error ? (
        <div className="small" style={{ color: 'var(--danger)' }}>
          Classification failed: {bookmark.classification_error}
        </div>
      ) : null}

      {editing ? (
        <div>
          <textarea
            value={note}
            placeholder="Your private note (never sent to JEV)"
            onChange={(event) => setNote(event.target.value)}
          />
          <input
            type="text"
            value={manualTags}
            placeholder="your-tag, another-tag"
            onChange={(event) => setManualTags(event.target.value)}
            style={{ marginTop: 6 }}
          />
          <div className="row" style={{ marginTop: 7 }}>
            <button
              type="button"
              className="primary"
              onClick={() => {
                onSaveNote(
                  bookmark,
                  note,
                  manualTags
                    .split(',')
                    .map((tag) => tag.trim())
                    .filter(Boolean),
                );
                setEditing(false);
              }}
            >
              Save
            </button>
            <button type="button" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : bookmark.personal_note ? (
        <div className="small" style={{ borderLeft: '2px solid var(--accent)', paddingLeft: 8 }}>
          {bookmark.personal_note}
        </div>
      ) : null}

      <div className="bookmark-foot">
        <a href={bookmark.post_url} target="_blank" rel="noreferrer noopener">
          Open on X
        </a>

        {bookmark.revisit_score !== null ? (
          <span className="revisit" title="JEV revisit score">
            <span className="revisit-bar">
              <span style={{ width: `${bookmark.revisit_score * 100}%`, display: 'block' }} />
            </span>
            {percent(bookmark.revisit_score)}
          </span>
        ) : null}

        {bookmark.actionable ? <span className="tag accent">actionable</span> : null}
        {!bookmark.is_currently_bookmarked ? <span className="tag">removed on X</span> : null}

        <span className="spacer" />

        <button
          type="button"
          className="subtle"
          title={bookmark.favorite ? 'Remove favourite' : 'Mark as favourite'}
          onClick={() => onToggleFavorite(bookmark)}
        >
          {bookmark.favorite ? '★' : '☆'}
        </button>
        <button
          type="button"
          className="subtle"
          title="Copy post URL"
          onClick={() => {
            void navigator.clipboard.writeText(bookmark.post_url).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button type="button" className="subtle" title="Add a note" onClick={() => setEditing((v) => !v)}>
          Note
        </button>
      </div>

      <div className="small muted tnum">
        {formatCompact(bookmark.like_count)} likes {'·'} {formatCompact(bookmark.reply_count)} replies{' '}
        {'·'} {formatCompact(bookmark.repost_count)} reposts {'·'}{' '}
        {formatCompact(bookmark.view_count)} views
      </div>
    </article>
  );
}
