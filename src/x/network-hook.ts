/**
 * MAIN-world network observer (optional enhancement).
 *
 * Runs in the page's own JavaScript context so it can see the JSON bodies X
 * already fetches for its timeline. It is strictly read-only: it never issues a
 * request of its own, never reads cookies or auth headers, and never sends
 * anything anywhere except a window.postMessage to this extension's own
 * isolated-world content script.
 *
 * If anything here throws, the original fetch/XHR behaviour is preserved and
 * the DOM extractor continues to carry the sync by itself.
 */

import { collectTweetsFromJson } from './network-parse';
import { NET_HOOK_MESSAGE } from './net-protocol';

declare global {
  interface Window {
    __xbvNetHookInstalled?: boolean;
  }
}

const MAX_BODY_BYTES = 8 * 1024 * 1024;

function isObservableUrl(url: string): boolean {
  try {
    const parsed = new URL(url, location.href);
    if (parsed.hostname !== location.hostname) return false;
    // X serves its timeline data under /i/api/. No operation name is matched.
    return parsed.pathname.includes('/i/api/');
  } catch {
    return false;
  }
}

function publish(body: string): void {
  try {
    if (body.length > MAX_BODY_BYTES) return;
    if (!body.includes('rest_id')) return; // cheap pre-filter

    const parsed: unknown = JSON.parse(body);
    const bookmarks = collectTweetsFromJson(parsed);
    if (bookmarks.length === 0) return;

    window.postMessage({ __xbv: NET_HOOK_MESSAGE, bookmarks }, location.origin);
  } catch {
    // Non-JSON or unexpected shape: nothing to contribute, stay silent.
  }
}

function install(): void {
  if (window.__xbvNetHookInstalled) return;
  window.__xbvNetHookInstalled = true;

  // --- fetch ---------------------------------------------------------------
  const originalFetch = window.fetch;
  if (typeof originalFetch === 'function') {
    window.fetch = async function patchedFetch(
      this: unknown,
      ...args: Parameters<typeof fetch>
    ): Promise<Response> {
      const response = await originalFetch.apply(this as never, args);
      try {
        const input = args[0];
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.toString()
              : (input as Request)?.url;
        if (url && isObservableUrl(url) && response.ok) {
          // Clone so the page still gets an unconsumed body.
          response
            .clone()
            .text()
            .then(publish)
            .catch(() => undefined);
        }
      } catch {
        // Observation must never affect the page's own request.
      }
      return response;
    } as typeof fetch;
  }

  // --- XMLHttpRequest ------------------------------------------------------
  try {
    const OriginalXhr = window.XMLHttpRequest;
    const originalOpen = OriginalXhr.prototype.open;
    const trackedUrl = new WeakMap<XMLHttpRequest, string>();

    OriginalXhr.prototype.open = function patchedOpen(
      this: XMLHttpRequest,
      method: string,
      url: string | URL,
      ...rest: unknown[]
    ) {
      try {
        trackedUrl.set(this, String(url));
        this.addEventListener('load', () => {
          try {
            const target = trackedUrl.get(this);
            if (!target || !isObservableUrl(target)) return;
            if (this.responseType !== '' && this.responseType !== 'text') return;
            publish(this.responseText);
          } catch {
            /* ignore */
          }
        });
      } catch {
        /* ignore */
      }
      return (originalOpen as (...a: unknown[]) => void).call(this, method, url, ...rest);
    } as typeof originalOpen;
  } catch {
    /* ignore */
  }
}

install();
