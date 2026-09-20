# X Bookmark Vault

A local-first Chrome extension (Manifest V3) that collects every post you have
bookmarked on X/Twitter, stores it in IndexedDB in your own browser, optionally
classifies it with **JEV** (TypeSafe's System One model), and exports the whole
library to CSV or JSON.

```
X Bookmarks  →  local IndexedDB  →  optional JEV classification  →  searchable library  →  CSV / JSON
```

Your bookmarks never leave your browser. The only thing that can ever be sent
anywhere is the specific bookmark text you deliberately submit to JEV for
classification, and Settings shows that payload field by field before you
enable it. There is no analytics, no telemetry and no external database.

---

## 1. Install dependencies

Requires Node.js 20+ (built and tested on Node 22).

```bash
npm install
```

## 2. Run locally

```bash
npm run typecheck     # TypeScript, strict mode
npm test              # 149 tests
npm run verify        # typecheck + tests + production build
```

`npm run dev` rebuilds into `dist/` on every change. Chrome does not hot-reload
extensions, so after a rebuild press the reload icon on the extension card in
`chrome://extensions`, then reload the X tab.

## 3. Build the extension

```bash
npm run build
```

This produces a complete, loadable extension in **`dist/`** and then verifies
it: every file the manifest references exists, content scripts are classic
(non-module) scripts, no page loads remote code, and nothing calls `eval`.

## 4. Load the unpacked extension into Chrome

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked**
4. Select the **`dist`** folder inside this repository
   (the folder containing `manifest.json` — not the repository root)

Pin the extension to your toolbar if you want the popup one click away.

## 5. Configure JEV (optional)

Classification is entirely optional. Collecting, searching, browsing, backing
up and exporting all work with no API key at all.

1. Click the extension icon → **Settings** (or open the options page)
2. Paste your JEV API key
3. Chrome will ask you to grant network access to the endpoint
   (`https://api.typesafe.ai/*` by default) — the extension requests **no** host
   permissions at install time, so you grant only that one origin
4. Click **Test connection**

The key is stored with `chrome.storage.local` in this browser profile only. It
is never written into the bookmark database, exports, backups or diagnostics,
and is never logged.

## 6. Perform the first bookmark sync

1. Make sure you are **logged in to X in this browser**. The extension reuses
   the session you already have; it never asks for your username or password
   and never transmits your cookies.
2. Open <https://x.com/i/bookmarks> and let the page finish loading.
3. A control panel appears in the bottom-right corner. Click **Sync
   Bookmarks** (the extension popup and the Sync tab have the same buttons).
4. Leave the tab open while it scrolls. Progress shows live:
   `1,284 bookmarks collected · 36 new this sync · 7 updated · Scanning older bookmarks…`

You can **Pause** and **Resume** at any time. Closing the tab, quitting Chrome
or hitting an error does not lose anything: every batch is written to IndexedDB
before the collector scrolls on, and the run resumes when you reopen the
bookmarks page.

Once the first import is done, later syncs are fast — see
[Incremental sync](#incremental-sync).

## 7. Export a CSV

**Settings → Export and backup → Export CSV**, or in the **Library** use
**Export filtered CSV** to export only what your current search and filters
match.

The file is UTF-8 with a byte-order mark so Excel renders emoji correctly,
quoted per RFC 4180 (commas, quotes, multi-line posts and Unicode all survive
a round trip), and list-valued cells such as `tags` and `external_urls` are
separated inside the cell with `|`.

Columns: `post_id, post_url, author_name, author_handle, posted_at,
collected_at, text, external_urls, image_urls, media_type, video_available,
quoted_post_url, quoted_post_text, like_count, reply_count, repost_count,
view_count, category, subcategory, tags, content_type, actionable,
revisit_score, summary, why_saved_might_be_useful, classified_at,
classification_status, favorite, personal_note, manual_tags,
is_currently_bookmarked`.

**Export JSON**, **Export Backup** and **Import Backup** are beside it. Import
merges by `post_id`, so re-importing a backup never creates duplicates.

---

## How collection works

X renders the bookmarks timeline as a **virtualized list**: posts are removed
from the DOM shortly after they scroll out of view. The collector therefore
never treats the page as a snapshot it can read at the end.

- Posts are harvested on every DOM mutation *and* before every scroll step, so
  they are captured the moment they render.
- Each batch is streamed to the background service worker, which persists it to
  IndexedDB and only then acknowledges — the next scroll waits for that
  acknowledgement.
- Scroll steps are smaller than one viewport so nothing can slip past.
- Loading is detected by watching for actual new content, not by page height,
  which is unreliable in a virtualized feed.
- Stalls escalate: longer waits, then a nudge back up to force X to re-run its
  windowing logic, then a jump to the bottom. X's own "Something went wrong"
  retry button is clicked automatically.
- The sync ends only after several consecutive scroll rounds discover zero new
  post ids.

The content script never writes to IndexedDB directly. It runs in x.com's
origin, while the database belongs to the extension's origin, so everything is
funnelled through the background worker — which is also what makes the whole
run resumable.

### Deduplication

The X post id is the canonical primary key:
`https://x.com/username/status/123456789` → `post_id = 123456789`.

Re-seeing a post updates its record instead of duplicating it. A later sync
that extracts *less* information than a previous one can only add fields, never
erase them, and classification and your own notes are never touched by a sync.

### Incremental sync

After the first import, **Sync Bookmarks** scans from the newest bookmark
downward and stops once it has seen **40 consecutive bookmarks that are already
in your library** (configurable in Settings). A single known bookmark proves
nothing — any unknown bookmark resets the streak to zero — so the run keeps
going through an interleaved batch and only concludes when it hits a long
unbroken run of known history.

**Full Rescan** bypasses that heuristic entirely and walks the whole timeline.

### Deleted bookmarks

An incremental scan never inspects the whole history, so a bookmark's absence
is not evidence it was removed, and nothing is ever deleted automatically.

A Full Rescan can optionally flag records it did not see as
`is_currently_bookmarked = false` (off by default, enable in Settings). They
stay in your library, stay exported, and are only hidden if you ask for it.

### The network enhancement (optional)

A second content script runs in the page's own JavaScript context and reads the
JSON bodies X has already fetched for its timeline, filling in full expanded
link URLs, exact engagement counts, reply parent ids and complete long-post
text. It is **shape-based, not endpoint-based**: it looks for objects that have
a numeric `rest_id` next to a `legacy` block, anywhere in any response. No
GraphQL operation name or query id is hardcoded.

It is read-only — it never issues a request of its own and never touches
cookies or auth headers — and it is purely additive. The DOM extractor carries
the entire sync on its own, so turning this off (Settings) or X changing its
API shape does not stop collection.

---

## How JEV is used

JEV is a **decision model**: it evaluates one state against a map of typed
questions and returns a calibrated answer for each. It never generates prose.
It has three primitives:

| Primitive | Answer |
| --- | --- |
| `noul` | yes/no, as a probability |
| `choice` | one option from a fixed set (max 255), with a distribution |
| `score` | a position along an ordered rubric of 2–10 levels |

The requested `BookmarkClassification` is expressed in those terms:

| Field | Primitive | How it is derived |
| --- | --- | --- |
| `category` / `subcategory` | `choice` | Options are the categories **already in your library** first, then your seed list. This is what makes JEV reuse existing categories instead of inventing near-duplicates. |
| `contentType` | `choice` | One of the twelve fixed content types. |
| `actionable` | `noul` | Stored as `true` at probability ≥ 0.5. |
| `revisitScore` | `score` | Position on a 5-level rubric, normalised to 0.0–1.0. |
| `tags` | `noul` × N | Candidate tags are derived **locally** from the post (keywords, link domains, hashtags); JEV votes yes/no on each and only accepted ones are stored. The author's own hashtags are facts about the post, so they are always kept. |
| `whySavedMightBeUseful` | `choice` | JEV picks one of a fixed set of reasons, plus the factual link domains. |
| `summary` | — | Taken **verbatim** from the post's own opening sentences. JEV does not generate text, and nothing is invented about a link it has not seen. |

The question template is versioned in code as `PROMPT_VERSION`
(`src/classifier/prompt.ts`). Each classification records
`classifier_version = "<model>/<prompt version>"`, so **Reclassify Outdated**
can re-run only the bookmarks classified by an older template. Nothing is ever
reclassified automatically.

JEV sits behind one interface, so replacing it means writing one file:

```ts
interface BookmarkClassifier {
  classify(bookmarks: Bookmark[]): Promise<BookmarkClassification[]>;
}
```

**Reliability.** Requests run with a configurable concurrency limit, retry on
429/5xx/529 with exponential backoff and jitter, honour `Retry-After`, and
checkpoint to IndexedDB after every chunk. Every response is validated before
it is persisted: an unknown category, an out-of-range score or a missing answer
triggers **one repair pass** that re-asks only the unreadable questions. If that
also fails, that single bookmark is marked `classification_status = "failed"`
with the reason, the bookmark itself is preserved, and the queue keeps going. A
401 is never retried.

### What is sent to JEV

Only when you start a classification, and only for the bookmarks being
classified:

- The post text (truncated to 1,200 characters)
- The author display name and @handle
- The quoted post text, if any (truncated)
- **Hostnames only** of external links, e.g. `github.com` — never the full URL
- Whether the post has images or video, and how many
- Approximate engagement counts
- The category names already used in your library
- A short list of locally-derived candidate tags

Never sent: your X cookies, tokens or credentials; full external URLs; image or
video files; your personal notes, manual tags or favourites; anything at all
when no API key is configured. Settings shows this same list in the UI.

---

## Chrome permissions

The extension asks for as little as it can. Every permission and why it exists:

| Permission | Why |
| --- | --- |
| `storage` | Stores your settings and the JEV API key with `chrome.storage.local`, scoped to this browser profile. |
| `unlimitedStorage` | IndexedDB holds the full library — thousands of posts with text and metadata. Without this, Chrome can evict the database under storage pressure. |
| Content script on `https://x.com/*`, `https://twitter.com/*` | Reads the bookmarks timeline you are already looking at, and draws the in-page control panel. This is the only site the extension touches. |
| `optional_host_permissions: https://*/*` | **Not granted at install time.** Only used to request access to the one JEV endpoint you configure, at the moment you configure it. If you never enable JEV, nothing is ever granted. |

Deliberately **not** requested:

- `tabs` — the popup learns whether a bookmarks tab is connected from the
  background worker's own port, not by reading your tabs.
- `downloads` — exports use an object URL and a synthetic anchor click.
- `webRequest` / `declarativeNetRequest` — nothing intercepts network traffic.
- Broad host permissions at install time.

The extension executes no remotely hosted code, uses no `eval`, and ships a
Manifest V3 CSP of `script-src 'self'; object-src 'self'`. The build verifier
fails if any of that stops being true.

---

## Project layout

```
src/
  background/      MV3 service worker: owns the database, sync and classification
    index.ts         message router and lifecycle
    sync-controller.ts  sync session state, batch persistence, stop decisions
    classify-runner.ts  classification queue with checkpointing
    incremental.ts      the incremental stop heuristic (pure)
  content/         content script (isolated world) + in-page control panel
  x/               everything that knows about X's markup, isolated here
    extractor.ts     DOM adapter (pure functions over Elements)
    collector.ts     scroll / virtualization engine
    network-hook.ts  MAIN-world response observer (optional enhancement)
    network-parse.ts shape-based tweet parser (pure)
  classifier/
    classifier.ts    the BookmarkClassifier interface
    jev.ts           JEV adapter: batching, retries, backoff
    prompt.ts        versioned question template
    validate.ts      strict response validation
    taxonomy.ts      category options, local tag candidates, extractive summary
  database/
    schema.ts        stores, indexes, migrations, merge rules (pure)
    db.ts            promise wrapper over IndexedDB
    search.ts        inverted index, filters, sorting, facets (pure)
  export/          csv.ts, json.ts, backup.ts, diagnostics.ts
  shared/          types, message protocol, settings, logger, utilities
  ui/              React options page (Dashboard / Library / Sync /
                   Classification / Settings / Diagnostics) and the popup
tests/             149 tests, with realistic X markup fixtures
```

### Database versioning

`DB_VERSION` and an append-only `MIGRATIONS` array in
`src/database/schema.ts`. To change the schema, bump the version and append a
migration — the first schema is explicitly not assumed to be the last. Indexes
exist for `collected_at`, `posted_at`, `author_handle`, `category`,
`classification_status`, `is_currently_bookmarked` and a multi-entry
`search_tokens` index.

### Search

Search is local and instant. An inverted index is built once from the token
list stored on each bookmark, terms are ANDed, and the final term is treated as
a prefix so results narrow while you type — no full-database scan per
keystroke. Queries and bookmark data are never sent to any search service.

### Your own metadata

`favorite`, `personal_note` and `manual_tags` are yours. Classification never
overwrites them, backup import only ever fills them in, and they are included
in CSV exports.

---

## Diagnostics

Since there is no telemetry, **Diagnostics** is how you see what happened: a
local rolling event log plus an exportable JSON report containing the extension
version, browser version, database schema version, bookmark counts, last sync
status and recent errors. It contains no cookies, no API key, no auth tokens
and no bookmark content.

## Known limitations

- **X can change its markup at any time.** Extraction is isolated in
  `src/x/extractor.ts` and leans on durable signals (status URLs, `<time
  datetime>`, `data-testid`, accessible labels) rather than generated class
  names, and each field degrades to `null` independently — but a large redesign
  will need that one file updated.
- **The bookmarks tab must stay open** while a sync runs. It can be in the
  background, but if you close it the run parks itself and resumes when you
  reopen the page.
- **`reply_to_post_id` is usually `null` from the DOM.** X's bookmarks timeline
  renders "Replying to @handle" without linking the parent post. The network
  enhancement recovers it when it is available.
- **Truncated link text.** When X routes a link through `t.co` and shows a
  shortened display URL, the full path is not in the DOM. Rather than guess,
  the extractor stores the origin only; the network enhancement fills in the
  real expanded URL when it can.
- **JEV cannot invent a brand-new category name.** Its `choice` primitive
  selects from a fixed option set, so the taxonomy grows through the library's
  own categories plus your seed list in Settings (and you can rename or
  bulk-assign categories in the Library).
- **Summaries are extractive, not generated,** because JEV returns typed
  decisions rather than text. This is a deliberate trade-off in favour of never
  fabricating a description.
- **Engagement counts are point-in-time** — whatever X displayed when the post
  was collected. Re-syncing refreshes them.
- **CSV cells are not sanitised against spreadsheet formula injection.** A post
  whose text begins with `=` is exported verbatim, because altering your data
  would be worse. Treat exports as untrusted input if you open them in a
  spreadsheet.
- **Full Rescan deletion detection needs an uninterrupted run** to be complete;
  it is off by default and only ever flags, never deletes.

## License

MIT
