import { describe, expect, it } from 'vitest';
import {
  ARRAY_SEPARATOR,
  CSV_COLUMNS,
  bookmarkToCsvRow,
  csvHeader,
  escapeCsvValue,
  toCsv,
} from '../src/export/csv';
import { makeBookmark } from './helpers';

/** Minimal RFC 4180 parser, used to prove exports round-trip. */
function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];

    if (quoted) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\r' && input[i + 1] === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += 1;
    } else {
      field += char as string;
    }
  }

  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

describe('escapeCsvValue', () => {
  it('leaves simple values untouched', () => {
    expect(escapeCsvValue('hello')).toBe('hello');
    expect(escapeCsvValue(42)).toBe('42');
    expect(escapeCsvValue(true)).toBe('true');
    expect(escapeCsvValue(false)).toBe('false');
  });

  it('renders null and undefined as an empty cell', () => {
    expect(escapeCsvValue(null)).toBe('');
    expect(escapeCsvValue(undefined)).toBe('');
    expect(escapeCsvValue('')).toBe('');
  });

  it('quotes fields containing a comma', () => {
    expect(escapeCsvValue('one, two')).toBe('"one, two"');
  });

  it('doubles embedded quotes', () => {
    expect(escapeCsvValue('say "hi"')).toBe('"say ""hi"""');
    expect(escapeCsvValue('"')).toBe('""""');
  });

  it('quotes multiline values, keeping the line breaks', () => {
    expect(escapeCsvValue('line one\nline two')).toBe('"line one\nline two"');
    expect(escapeCsvValue('cr\r\nlf')).toBe('"cr\r\nlf"');
  });

  it('quotes values with significant leading or trailing whitespace', () => {
    expect(escapeCsvValue('  padded  ')).toBe('"  padded  "');
  });

  it('joins arrays with the pipe separator', () => {
    expect(escapeCsvValue(['a', 'b', 'c'])).toBe(`a${ARRAY_SEPARATOR}b${ARRAY_SEPARATOR}c`);
    expect(escapeCsvValue([])).toBe('');
  });

  it('quotes an array whose members contain commas', () => {
    expect(escapeCsvValue(['a,1', 'b'])).toBe('"a,1|b"');
  });
});

describe('CSV unicode and emoji', () => {
  it('passes emoji, astral characters and non-Latin scripts through unchanged', () => {
    const samples = [
      'rocket 🚀 launch',
      'family 👨‍👩‍👧‍👦 zwj sequence',
      'flag 🇯🇵 regional indicators',
      '日本語のテキスト',
      'Ελληνικά, με κόμμα',
      'עברית',
      'emoji with "quotes" 😅, and a comma',
    ];

    for (const sample of samples) {
      const escaped = escapeCsvValue(sample);
      const [row] = parseCsv(`${escaped}\r\n`);
      expect(row?.[0]).toBe(sample);
    }
  });

  it('round-trips a bookmark whose text has emoji, quotes, commas and newlines', () => {
    const bookmark = makeBookmark({
      post_id: '123456789012',
      text: 'Shipped it 🚀, "finally"\nSecond line, with a comma\nThird 😅',
      tags: ['ai', 'launch'],
      external_urls: ['https://example.com/a,b', 'https://example.com/c'],
      category: 'AI',
      summary: 'Shipped it 🚀',
    });

    const csv = `${csvHeader()}\r\n${bookmarkToCsvRow(bookmark)}\r\n`;
    const rows = parseCsv(csv);

    expect(rows).toHaveLength(2);
    const header = rows[0] as string[];
    const values = rows[1] as string[];
    expect(header).toEqual([...CSV_COLUMNS]);
    expect(values).toHaveLength(CSV_COLUMNS.length);

    const cell = (name: string): string => values[header.indexOf(name)] as string;
    expect(cell('text')).toBe(bookmark.text);
    expect(cell('post_id')).toBe('123456789012');
    expect(cell('tags')).toBe('ai|launch');
    expect(cell('external_urls')).toBe('https://example.com/a,b|https://example.com/c');
    expect(cell('summary')).toBe('Shipped it 🚀');
  });
});

describe('toCsv', () => {
  it('emits a header even when there are no bookmarks', () => {
    expect(toCsv([])).toBe(`${csvHeader()}\r\n`);
  });

  it('includes classification and manual columns', () => {
    const header = csvHeader().split(',');
    for (const column of [
      'category',
      'subcategory',
      'tags',
      'content_type',
      'actionable',
      'revisit_score',
      'summary',
      'why_saved_might_be_useful',
      'classified_at',
      'favorite',
      'personal_note',
      'manual_tags',
    ]) {
      expect(header).toContain(column);
    }
  });

  it('formats the revisit score to two decimals and leaves it blank when unknown', () => {
    const scored = makeBookmark({ post_id: '111111111111', revisit_score: 0.9231 });
    const unscored = makeBookmark({ post_id: '222222222222', revisit_score: null });
    const rows = parseCsv(toCsv([scored, unscored]));
    const header = rows[0] as string[];
    const index = header.indexOf('revisit_score');

    expect((rows[1] as string[])[index]).toBe('0.92');
    expect((rows[2] as string[])[index]).toBe('');
  });

  it('produces one row per bookmark even with multiline text', () => {
    const rows = parseCsv(
      toCsv([
        makeBookmark({ post_id: '111111111111', text: 'a\nb\nc' }),
        makeBookmark({ post_id: '222222222222', text: 'plain' }),
      ]),
    );
    expect(rows).toHaveLength(3);
  });
});
