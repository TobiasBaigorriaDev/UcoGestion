import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(resolve('public/sw.js'), 'utf8');

describe('T185A service worker', () => {
  it('only precaches versioned public shell assets and never caches private API responses', async () => {
    const handlers = new Map<string, (event: { request?: Request; waitUntil?: (work: Promise<unknown>) => void;
      respondWith?: (work: Promise<Response>) => void }) => void>();
    const addAll = vi.fn(async (...args: [string[]]) => { void args; });
    const cachePut = vi.fn();
    const network = vi.fn(async () => new Response('private', { status: 200 }));
    runInNewContext(source, {
      self: { location: { origin: 'https://example.test' },
        addEventListener: (kind: string, handler: typeof handlers extends Map<string, infer V> ? V : never) => handlers.set(kind, handler),
        skipWaiting: vi.fn(), clients: { claim: vi.fn() } },
      caches: { open: async () => ({ addAll, put: cachePut, match: async () => undefined }),
        keys: async () => [] },
      fetch: network, URL, Response, Promise,
      indexedDB: { databases: async () => [] },
    });
    let install: Promise<unknown> | undefined;
    handlers.get('install')?.({ waitUntil: (work) => { install = work; } });
    await install;
    expect(addAll).toHaveBeenCalledOnce();
    const urls = addAll.mock.calls[0]?.[0];
    expect(urls).toEqual(['/offline-shell-v1.html', '/offline-icon-v1.svg']);
    let response: Promise<Response> | undefined;
    handlers.get('fetch')?.({ request: new Request('https://example.test/api/v1/customers'),
      respondWith: (work) => { response = work; } });
    if (response) expect(await response).toBeDefined();
    expect(cachePut).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
  });
});
