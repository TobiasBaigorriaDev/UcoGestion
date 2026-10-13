import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadSaleHistory } from '../src/features/sales/sales-api';

afterEach(() => vi.unstubAllGlobals());

describe('sales history response compatibility', () => {
  it('accepts a scoped history row from the previous API without branchId', async () => {
    const sale = { id: '11111111-1111-4111-8111-111111111111', status: 'CONFIRMED',
      total: '25.00', currency: 'ARS', confirmedAt: '2026-10-11T12:00:00Z' };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ items: [sale], nextCursor: null }),
      { status: 200, headers: { 'content-type': 'application/json' } })));
    const page = await loadSaleHistory('org', 'branch', { from: '2026-10-11', to: '2026-10-11' });
    expect(page.items[0]).toMatchObject({ ...sale, branchId: 'branch' });
  });
});
