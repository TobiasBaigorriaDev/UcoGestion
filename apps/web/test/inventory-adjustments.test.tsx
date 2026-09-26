import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, expect, it, vi } from 'vitest';

import { InventoryAdjustments } from '../src/features/inventory/inventory-adjustments.js';
import { ApiProblemError } from '../src/lib/api/client.js';

afterEach(cleanup);
const stocks = [{ branchId: 'b1', itemId: 'i1', itemName: 'Yerba', baseUnit: 'UNIT' as const,
  quantity: '2.000', threshold: null, lowStock: false }];
const history = [{ id: 'a1', branchId: 'b1', itemId: 'i1', itemName: 'Yerba', direction: 'INCREASE' as const,
  quantity: '2.000', reason: 'CONTEO_FISICO', observation: null, occurredAt: '2026-09-26T00:00:00Z',
  compensatedBy: null, compensates: null }];

it('T114B restricts employee reasons, validates UNIT precision, and exposes confirmed compensation', async () => {
  const confirm = vi.fn().mockResolvedValue(undefined);
  const compensate = vi.fn().mockResolvedValue(undefined);
  const { container } = render(<InventoryAdjustments organizationId="o1" branchId="b1" role="EMPLOYEE"
    stocks={stocks} adjustments={history} nextCursor={null} onReload={vi.fn()}
    onConfirm={confirm} onCompensate={compensate} />);
  expect(screen.queryByRole('option', { name: /inventario inicial/i })).toBeNull();
  await userEvent.type(screen.getByLabelText('Cantidad'), '1.5');
  await userEvent.click(screen.getByRole('button', { name: 'Confirmar ajuste' }));
  expect(confirm).not.toHaveBeenCalled();
  expect(screen.getByRole('alert').textContent).toMatch(/entera/i);
  expect(document.getElementById(screen.getByLabelText('Cantidad').getAttribute('aria-describedby')!)?.textContent).toMatch(/entera/i);
  expect(screen.getByRole('alert').querySelector('a')?.getAttribute('href')).toBe('#adjustment-quantity');
  await userEvent.clear(screen.getByLabelText('Cantidad'));
  await userEvent.type(screen.getByLabelText('Cantidad'), '1');
  await userEvent.click(screen.getByRole('button', { name: 'Confirmar ajuste' }));
  expect(confirm).toHaveBeenCalledWith('o1', expect.objectContaining({ branchId: 'b1', itemId: 'i1', quantity: '1' }));
  await userEvent.click(screen.getByRole('button', { name: /compensar ajuste/i }));
  await userEvent.click(screen.getByRole('button', { name: /confirmar compensación/i }));
  expect(compensate).toHaveBeenCalledWith('o1', 'a1', null);
  expect((await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })).violations).toEqual([]);
});

it('T114B explains stock rejection without clearing the entered quantity', async () => {
  const confirm = vi.fn().mockRejectedValue(new ApiProblemError({ status: 409, code: 'INSUFFICIENT_STOCK',
    message: 'Revisá el stock disponible antes de confirmar.' }));
  render(<InventoryAdjustments organizationId="o1" branchId="b1" role="OWNER" stocks={stocks}
    adjustments={[]} nextCursor={null} onReload={vi.fn()} onConfirm={confirm} />);
  await userEvent.selectOptions(screen.getByLabelText('Tipo de ajuste'), 'DECREASE');
  await userEvent.type(screen.getByLabelText('Cantidad'), '3');
  await userEvent.click(screen.getByRole('button', { name: 'Confirmar ajuste' }));
  expect(await screen.findAllByText(/Revisá el stock disponible/i)).not.toHaveLength(0);
  expect((screen.getByLabelText('Cantidad') as HTMLInputElement).value).toBe('3');
  expect(screen.getByLabelText('Cantidad').getAttribute('aria-invalid')).toBe('true');
});
