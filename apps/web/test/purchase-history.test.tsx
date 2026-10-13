import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  loadPurchaseHistory: vi.fn(), loadPurchaseTrends: vi.fn(),
}));
vi.mock('../src/features/purchases/purchases-api.js', () => mocks);

import { PurchaseHistory } from '../src/features/purchases/purchase-history.js';

afterEach(() => { cleanup(); vi.resetAllMocks(); });

it('D07 shows products, local time, spend and charts, then selects the purchase', async () => {
  const onSelect = vi.fn();
  mocks.loadPurchaseHistory.mockResolvedValue({ items: [{
    id: '11111111-1111-4111-8111-111111111111', branchId: 'branch',
    supplierName: 'Bodega Sur', status: 'PAID', total: '14.50', currency: 'ARS',
    confirmedAt: '2026-10-11T12:30:00Z',
    items: [{ itemName: 'Cajas', quantity: '2.000', lineTotal: '14.50' }],
  }], nextCursor: null });
  mocks.loadPurchaseTrends.mockResolvedValue({ currency: 'ARS',
    points: [{ date: '2026-10-11', hour: 9, amount: '14.50', count: 1 }] });
  const { container } = render(<QueryClientProvider client={new QueryClient({ defaultOptions: {
    queries: { retry: false },
  } })}><PurchaseHistory organizationId="org" branchId="branch" timezone="America/Argentina/Buenos_Aires"
    branches={[{ id: 'branch', name: 'Centro' }]} onSelect={onSelect} /></QueryClientProvider>);
  expect(await screen.findByText('Bodega Sur')).toBeTruthy();
  expect(screen.getByText(/Cajas/)).toBeTruthy();
  expect(screen.getAllByText(/14,50/).length).toBeGreaterThan(0);
  expect(screen.getByRole('heading', { name: 'Gasto neto' })).toBeTruthy();
  await userEvent.click(screen.getByRole('button', { name: /Ver compra/i }));
  expect(onSelect).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111');
  await userEvent.click(screen.getByRole('button', { name: 'Esta semana' }));
  await waitFor(() => expect(mocks.loadPurchaseTrends).toHaveBeenCalledWith('org', expect.objectContaining({
    groupBy: 'DAY', branchId: 'branch',
  })));
  expect((await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })).violations).toEqual([]);
});
