/**
 * Test environment: a real (in-memory) IndexedDB and a minimal chrome API so
 * modules that touch extension storage can be imported without mocking them
 * at every call site.
 */
import 'fake-indexeddb/auto';
import { vi } from 'vitest';

const storage = new Map<string, unknown>();

const chromeStub = {
  storage: {
    local: {
      get: vi.fn(async (key: string | string[] | null) => {
        if (typeof key === 'string') {
          return storage.has(key) ? { [key]: storage.get(key) } : {};
        }
        const out: Record<string, unknown> = {};
        for (const [k, v] of storage) out[k] = v;
        return out;
      }),
      set: vi.fn(async (items: Record<string, unknown>) => {
        for (const [key, value] of Object.entries(items)) storage.set(key, value);
      }),
      clear: vi.fn(async () => storage.clear()),
    },
  },
  runtime: {
    getManifest: () => ({ version: '1.0.0' }),
    getURL: (path: string) => `chrome-extension://test/${path}`,
    sendMessage: vi.fn(async () => undefined),
    onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
    onConnect: { addListener: vi.fn() },
    onInstalled: { addListener: vi.fn() },
    onStartup: { addListener: vi.fn() },
    connect: vi.fn(),
  },
  permissions: {
    contains: vi.fn(async () => true),
    request: vi.fn(async () => true),
  },
  tabs: { create: vi.fn(async () => undefined) },
};

(globalThis as unknown as { chrome: unknown }).chrome = chromeStub;
