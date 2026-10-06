import { describe, expect, it, vi } from 'vitest';

import { assessOfflineCapabilities } from '../src/offline/capability-gate.js';
import { authorizePosOffline } from '../src/offline/authorize-pos.js';

describe('T185B offline capability gate', () => {
  it('rejects authorization when any required browser capability is absent', async () => {
    const available = { serviceWorker: true, indexedDb: true, webCrypto: true };
    expect(assessOfflineCapabilities(available).allowed).toBe(true);
    for (const missing of Object.keys(available) as (keyof typeof available)[]) {
      expect(assessOfflineCapabilities({ ...available, [missing]: false }).allowed).toBe(false);
    }
  });

  it('never sends a POS authorization request when the secure offline platform is unavailable', async () => {
    const request = vi.spyOn(globalThis, 'fetch');
    try {
      await expect(authorizePosOffline('tenant', { branchId: 'branch', publicKey: 'key' }, 'key'))
        .rejects.toThrow(/capacidades/);
      expect(request).not.toHaveBeenCalled();
    } finally { request.mockRestore(); }
  });
});
