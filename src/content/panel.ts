/**
 * In-page control panel injected on https://x.com/i/bookmarks.
 *
 * Rendered inside a shadow root so X's stylesheet cannot affect it and it
 * cannot affect X's. No remote code, no inline event-handler attributes.
 */

export interface PanelCallbacks {
  onSync(mode: 'incremental' | 'full'): void;
  onPause(): void;
  onResume(): void;
  onStop(): void;
  onOpenLibrary(): void;
}

export interface PanelState {
  status: 'idle' | 'running' | 'paused' | 'done' | 'error';
  total: number;
  newCount: number;
  updatedCount: number;
  seenCount: number;
  phase: string;
  error: string | null;
}

const STYLES = `
:host { all: initial; }
.panel {
  position: fixed; right: 20px; bottom: 20px; z-index: 2147483000;
  width: 290px; padding: 14px 16px;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  font-size: 13px; line-height: 1.45; color: #e7e9ea;
  background: #16181c; border: 1px solid #2f3336; border-radius: 14px;
  box-shadow: 0 10px 34px rgba(0,0,0,.45);
}
@media (prefers-color-scheme: light) {
  .panel { background: #fff; color: #0f1419; border-color: #cfd9de; }
  .meta { color: #536471 !important; }
  button.ghost { color: #0f1419 !important; border-color: #cfd9de !important; }
}
.head { display:flex; align-items:center; justify-content:space-between; margin-bottom:10px; }
.title { font-weight:700; font-size:13px; letter-spacing:.2px; }
.dot { width:8px; height:8px; border-radius:50%; background:#71767b; display:inline-block; margin-right:6px; }
.dot.running { background:#1d9bf0; animation: pulse 1.4s ease-in-out infinite; }
.dot.done { background:#00ba7c; }
.dot.error { background:#f4212e; }
.dot.paused { background:#ffd400; }
@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.35} }
.stats { font-variant-numeric: tabular-nums; margin-bottom:8px; }
.stats b { font-size:20px; font-weight:700; }
.meta { color:#71767b; font-size:12px; }
.phase { margin:8px 0 10px; min-height:16px; }
.err { color:#f4212e; margin:6px 0 8px; word-break:break-word; }
.row { display:flex; gap:8px; flex-wrap:wrap; }
button {
  font: inherit; font-weight:600; cursor:pointer; border-radius:999px;
  padding:8px 14px; border:1px solid transparent; transition: filter .12s ease;
}
button:hover { filter: brightness(1.12); }
button:disabled { opacity:.45; cursor:not-allowed; filter:none; }
button.primary { background:#1d9bf0; color:#fff; flex:1; }
button.ghost { background:transparent; color:#e7e9ea; border-color:#536471; }
button.link { background:none; border:none; color:#1d9bf0; padding:6px 0; text-decoration:underline; }
.close { background:none; border:none; color:#71767b; cursor:pointer; font-size:16px; padding:0 4px; }
`;

export class ControlPanel {
  private host: HTMLDivElement | null = null;
  private root: ShadowRoot | null = null;
  private state: PanelState = {
    status: 'idle',
    total: 0,
    newCount: 0,
    updatedCount: 0,
    seenCount: 0,
    phase: 'Ready to sync.',
    error: null,
  };

  constructor(private readonly callbacks: PanelCallbacks) {}

  mount(): void {
    if (this.host) return;

    this.host = document.createElement('div');
    this.host.id = 'x-bookmark-vault-panel';
    this.root = this.host.attachShadow({ mode: 'open' });

    // A constructed stylesheet is not affected by the host page's style-src
    // CSP; the <style> element is only a fallback for older engines.
    let adopted = false;
    try {
      if (typeof CSSStyleSheet !== 'undefined' && 'replaceSync' in CSSStyleSheet.prototype) {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(STYLES);
        this.root.adoptedStyleSheets = [sheet];
        adopted = true;
      }
    } catch {
      adopted = false;
    }
    if (!adopted) {
      const style = document.createElement('style');
      style.textContent = STYLES;
      this.root.appendChild(style);
    }

    const panel = document.createElement('div');
    panel.className = 'panel';
    this.root.appendChild(panel);

    document.documentElement.appendChild(this.host);
    this.render();
  }

  unmount(): void {
    this.host?.remove();
    this.host = null;
    this.root = null;
  }

  isMounted(): boolean {
    return this.host !== null;
  }

  update(patch: Partial<PanelState>): void {
    this.state = { ...this.state, ...patch };
    this.render();
  }

  private render(): void {
    const panel = this.root?.querySelector('.panel');
    if (!panel) return;

    const { status, total, newCount, updatedCount, phase, error } = this.state;
    panel.textContent = '';

    const head = el('div', 'head');
    const title = el('div', 'title');
    const dot = el('span', `dot ${status}`);
    title.appendChild(dot);
    title.appendChild(document.createTextNode('X Bookmark Vault'));
    head.appendChild(title);

    const close = el('button', 'close');
    close.textContent = '×';
    close.title = 'Hide this panel';
    close.addEventListener('click', () => this.unmount());
    head.appendChild(close);
    panel.appendChild(head);

    const stats = el('div', 'stats');
    const strong = document.createElement('b');
    strong.textContent = total.toLocaleString('en-US');
    stats.appendChild(strong);
    stats.appendChild(document.createTextNode(' bookmarks collected'));
    panel.appendChild(stats);

    const meta = el('div', 'meta');
    meta.textContent = `${newCount.toLocaleString('en-US')} new this sync · ${updatedCount.toLocaleString('en-US')} updated`;
    panel.appendChild(meta);

    const phaseEl = el('div', 'phase meta');
    phaseEl.textContent = phase;
    panel.appendChild(phaseEl);

    if (error) {
      const errEl = el('div', 'err');
      errEl.textContent = error;
      panel.appendChild(errEl);
    }

    const row = el('div', 'row');

    if (status === 'running') {
      row.appendChild(button('Pause Sync', 'primary', () => this.callbacks.onPause()));
      row.appendChild(button('Stop', 'ghost', () => this.callbacks.onStop()));
    } else if (status === 'paused') {
      row.appendChild(button('Resume Sync', 'primary', () => this.callbacks.onResume()));
      row.appendChild(button('Stop', 'ghost', () => this.callbacks.onStop()));
    } else {
      row.appendChild(button('Sync Bookmarks', 'primary', () => this.callbacks.onSync('incremental')));
      row.appendChild(button('Full Rescan', 'ghost', () => this.callbacks.onSync('full')));
    }
    panel.appendChild(row);

    panel.appendChild(button('Open library →', 'link', () => this.callbacks.onOpenLibrary()));
  }
}

function el(tag: string, className: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}

function button(label: string, className: string, onClick: () => void): HTMLButtonElement {
  const node = document.createElement('button');
  node.className = className;
  node.textContent = label;
  node.addEventListener('click', onClick);
  return node;
}
