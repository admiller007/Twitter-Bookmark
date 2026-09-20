import { describe, expect, it } from 'vitest';
import {
  BackupParseError,
  buildBackup,
  mergeBackup,
  mergeImportedBookmark,
  normalizeImportedBookmark,
  parseBackup,
} from '../src/export/backup';
import { makeBookmark } from './helpers';

describe('parseBackup', () => {
  it('reads a backup file produced by this extension', () => {
    const backup = buildBackup([makeBookmark({ post_id: '123456789012' })], '1.0.0', '2026-05-01T00:00:00.000Z');
    const parsed = parseBackup(JSON.stringify(backup));
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.post_id).toBe('123456789012');
  });

  it('also accepts a bare array of bookmarks', () => {
    const parsed = parseBackup(JSON.stringify([makeBookmark({ post_id: '123456789012' })]));
    expect(parsed).toHaveLength(1);
  });

  it('reports a friendly error for unusable input', () => {
    expect(() => parseBackup('not json')).toThrow(BackupParseError);
    expect(() => parseBackup('{"other":[]}')).toThrow(BackupParseError);
    expect(() => parseBackup('{"bookmarks":[{"post_id":"nope"}]}')).toThrow(BackupParseError);
  });

  it('skips unusable records but keeps the rest of the file', () => {
    const parsed = parseBackup(
      JSON.stringify({ bookmarks: [{ post_id: 'bad' }, { post_id: '123456789012' }] }),
    );
    expect(parsed).toHaveLength(1);
  });
});

describe('normalizeImportedBookmark', () => {
  it('fills in defaults for a partial record', () => {
    const record = normalizeImportedBookmark({ post_id: '123456789012', text: 'hi' });
    expect(record?.classification_status).toBe('unclassified');
    expect(record?.tags).toEqual([]);
    expect(record?.is_currently_bookmarked).toBe(true);
    expect(record?.search_tokens).toContain('hi');
  });

  it('infers a classified status from a record that has a category', () => {
    const record = normalizeImportedBookmark({ post_id: '123456789012', category: 'AI' });
    expect(record?.classification_status).toBe('classified');
  });

  it('drops values that do not belong to the schema', () => {
    const record = normalizeImportedBookmark({
      post_id: '123456789012',
      content_type: 'gizmo',
      media_type: 'hologram',
      revisit_score: 'high',
      actionable: 'maybe',
    });
    expect(record?.content_type).toBeNull();
    expect(record?.media_type).toBe('none');
    expect(record?.revisit_score).toBeNull();
    expect(record?.actionable).toBeNull();
  });
});

describe('mergeImportedBookmark', () => {
  it('inserts a record the library has never seen', () => {
    const result = mergeImportedBookmark(undefined, makeBookmark({ post_id: '123456789012' }));
    expect(result.outcome).toBe('inserted');
  });

  it('keeps the earliest collected_at', () => {
    const local = makeBookmark({ post_id: '123456789012' }, '2026-05-01T00:00:00.000Z');
    const imported = makeBookmark({ post_id: '123456789012' }, '2026-01-01T00:00:00.000Z');
    const result = mergeImportedBookmark(local, imported);
    expect(result.record.collected_at).toBe('2026-01-01T00:00:00.000Z');
  });

  it('adopts a classification the local record does not have', () => {
    const local = makeBookmark({ post_id: '123456789012' });
    const imported = makeBookmark({
      post_id: '123456789012',
      category: 'AI',
      subcategory: 'Agents',
      tags: ['agentic-ai'],
      content_type: 'tool',
      actionable: true,
      revisit_score: 0.9,
      summary: 'summary',
      why_saved_might_be_useful: 'why',
      classification_status: 'classified',
      classified_at: '2026-04-01T00:00:00.000Z',
      classifier_version: 'jev-latest/jev-questions-v1',
    });

    const result = mergeImportedBookmark(local, imported);
    expect(result.outcome).toBe('merged');
    expect(result.record.category).toBe('AI');
    expect(result.record.revisit_score).toBe(0.9);
    expect(result.record.classification_status).toBe('classified');
  });

  it('keeps the newer of two classifications', () => {
    const local = makeBookmark({
      post_id: '123456789012',
      category: 'Local Category',
      classification_status: 'classified',
      classified_at: '2026-06-01T00:00:00.000Z',
    });
    const older = makeBookmark({
      post_id: '123456789012',
      category: 'Older Category',
      classification_status: 'classified',
      classified_at: '2026-01-01T00:00:00.000Z',
    });

    expect(mergeImportedBookmark(local, older).record.category).toBe('Local Category');

    const newer = makeBookmark({
      post_id: '123456789012',
      category: 'Newer Category',
      classification_status: 'classified',
      classified_at: '2026-09-01T00:00:00.000Z',
    });
    expect(mergeImportedBookmark(local, newer).record.category).toBe('Newer Category');
  });

  it('fills gaps in user-owned fields but never erases them', () => {
    const local = makeBookmark({
      post_id: '123456789012',
      favorite: true,
      personal_note: 'my local note',
      manual_tags: ['local'],
    });
    const imported = makeBookmark({
      post_id: '123456789012',
      favorite: false,
      personal_note: 'imported note',
      manual_tags: ['imported'],
    });

    const result = mergeImportedBookmark(local, imported);
    expect(result.record.favorite).toBe(true);
    expect(result.record.personal_note).toBe('my local note');
    expect(result.record.manual_tags.sort()).toEqual(['imported', 'local']);
  });

  it('adds a note when the local record has none', () => {
    const local = makeBookmark({ post_id: '123456789012', personal_note: null });
    const imported = makeBookmark({ post_id: '123456789012', personal_note: 'from backup' });
    expect(mergeImportedBookmark(local, imported).record.personal_note).toBe('from backup');
  });

  it('does not let an older backup overwrite newer scraped metadata', () => {
    const local = makeBookmark({
      post_id: '123456789012',
      text: 'current text',
      like_count: 500,
      updated_at: '2026-09-01T00:00:00.000Z',
    });
    const imported = makeBookmark({
      post_id: '123456789012',
      text: 'stale text',
      like_count: 5,
      updated_at: '2026-01-01T00:00:00.000Z',
    });

    const result = mergeImportedBookmark(local, imported);
    expect(result.record.text).toBe('current text');
    expect(result.record.like_count).toBe(500);
  });

  it('takes scraped values from a strictly newer backup', () => {
    const local = makeBookmark({
      post_id: '123456789012',
      like_count: 5,
      updated_at: '2026-01-01T00:00:00.000Z',
    });
    const imported = makeBookmark({
      post_id: '123456789012',
      like_count: 900,
      updated_at: '2026-09-01T00:00:00.000Z',
    });
    expect(mergeImportedBookmark(local, imported).record.like_count).toBe(900);
  });

  it('fills an empty local field from an older backup', () => {
    const local = makeBookmark({
      post_id: '123456789012',
      text: null,
      updated_at: '2026-09-01T00:00:00.000Z',
    });
    const imported = makeBookmark({
      post_id: '123456789012',
      text: 'recovered text',
      updated_at: '2026-01-01T00:00:00.000Z',
    });
    expect(mergeImportedBookmark(local, imported).record.text).toBe('recovered text');
  });

  it('reports "unchanged" when the backup adds nothing', () => {
    const local = makeBookmark({ post_id: '123456789012' });
    const result = mergeImportedBookmark(local, { ...local });
    expect(result.outcome).toBe('unchanged');
    expect(result.record).toBe(local);
  });
});

describe('mergeBackup', () => {
  it('merges by post_id instead of creating duplicates', () => {
    const existing = [
      makeBookmark({ post_id: '111111111111' }),
      makeBookmark({ post_id: '222222222222' }),
    ];
    const imported = [
      makeBookmark({ post_id: '222222222222', category: 'AI', classification_status: 'classified', classified_at: '2026-09-01T00:00:00.000Z' }),
      makeBookmark({ post_id: '333333333333' }),
    ];

    const summary = mergeBackup(existing, imported);
    expect(summary.inserted).toBe(1);
    expect(summary.merged).toBe(1);
    expect(summary.unchanged).toBe(0);
    expect(summary.records.map((r) => r.post_id).sort()).toEqual(['222222222222', '333333333333']);
  });

  it('is idempotent: re-importing the same file changes nothing', () => {
    const existing = [makeBookmark({ post_id: '111111111111' })];
    const first = mergeBackup(existing, [makeBookmark({ post_id: '111111111111' })]);
    expect(first.unchanged).toBe(1);
    expect(first.records).toHaveLength(0);
  });

  it('collapses duplicates inside the imported file itself', () => {
    const imported = [
      makeBookmark({ post_id: '111111111111', personal_note: null }),
      makeBookmark({ post_id: '111111111111', personal_note: 'second copy' }),
    ];
    const summary = mergeBackup([], imported);
    const ids = new Set(summary.records.map((r) => r.post_id));
    expect(ids.size).toBe(1);
    const final = summary.records[summary.records.length - 1];
    expect(final?.personal_note).toBe('second copy');
  });

  it('round-trips a full library through export and import', () => {
    const library = [
      makeBookmark({ post_id: '111111111111', text: 'emoji 🚀 and, commas', tags: ['ai'] }),
      makeBookmark({ post_id: '222222222222', text: 'multi\nline' }),
    ];
    const serialized = JSON.stringify(buildBackup(library, '1.0.0', '2026-05-01T00:00:00.000Z'));
    const restored = mergeBackup([], parseBackup(serialized));

    expect(restored.inserted).toBe(2);
    expect(restored.records[0]?.text).toBe('emoji 🚀 and, commas');
    expect(restored.records[1]?.text).toBe('multi\nline');
  });
});
