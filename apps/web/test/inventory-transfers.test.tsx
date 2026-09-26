import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, expect, it, vi } from 'vitest';

import { InventoryTransfers } from '../src/features/inventory/inventory-transfers.js';
import { ApiProblemError } from '../src/lib/api/client.js';

afterEach(cleanup);
const branches = [{ id: 'b1', name: 'Principal' }, { id: 'b2', name: 'Depósito' }];
const stocks = [{ branchId: 'b1', itemId: 'i1', itemName: 'Yerba', baseUnit: 'UNIT' as const,
  quantity: '5.000', threshold: null, lowStock: false }];
const history = [{ id: 't1', originBranchId: 'b1', destinationBranchId: 'b2', occurredAt: '2026-09-26T00:00:00Z',
  compensatedBy: null, compensates: null, lines: [{ itemId: 'i1', itemName: 'Yerba', quantity: '1.000' }] }];

it('T114C submits valid lines and offers explicit compensation of a confirmed transfer', async () => {
  const confirm = vi.fn().mockResolvedValue(undefined);
  const compensate = vi.fn().mockResolvedValue(undefined);
  const { container } = render(<InventoryTransfers organizationId="o1" role="OWNER" branches={branches}
    originBranchId="b1" stocks={stocks} transfers={history} nextCursor={null}
    onOriginChange={vi.fn()} onReload={vi.fn()} onConfirm={confirm} onCompensate={compensate} />);
  await userEvent.selectOptions(screen.getByLabelText('Destino'), 'b2');
  await userEvent.type(screen.getByLabelText('Cantidad de Yerba'), '2');
  await userEvent.click(screen.getByRole('button', { name: 'Confirmar transferencia' }));
  expect(confirm).toHaveBeenCalledWith('o1', { originBranchId: 'b1', destinationBranchId: 'b2',
    lines: [{ itemId: 'i1', quantity: '2' }] });
  await userEvent.click(screen.getByRole('button', { name: /compensar transferencia/i }));
  await userEvent.click(screen.getByRole('button', { name: /confirmar compensación/i }));
  expect(compensate).toHaveBeenCalledWith('o1', 't1');
  expect((await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })).violations).toEqual([]);
});

it('T114C leaves a multi-line stock rejection unassigned when the server does not identify a line', async () => {
  const confirm = vi.fn().mockRejectedValue(new ApiProblemError({ status: 409, code: 'INSUFFICIENT_STOCK',
    message: 'Revisá el stock disponible antes de confirmar.' }));
  render(<InventoryTransfers organizationId="o1" role="OWNER" branches={branches}
    originBranchId="b1" stocks={[...stocks, { ...stocks[0]!, itemId: 'i2', itemName: 'Aceite' }]}
    transfers={[]} nextCursor={null} onOriginChange={vi.fn()} onReload={vi.fn()} onConfirm={confirm} />);
  await userEvent.selectOptions(screen.getByLabelText('Destino'), 'b2');
  await userEvent.type(screen.getByLabelText('Cantidad de Yerba'), '1');
  await userEvent.click(screen.getByRole('button', { name: 'Agregar producto' }));
  await userEvent.selectOptions(screen.getByLabelText('Producto de línea 2'), 'i2');
  await userEvent.type(screen.getByLabelText('Cantidad de Aceite'), '1');
  await userEvent.click(screen.getByRole('button', { name: 'Confirmar transferencia' }));
  expect((await screen.findByRole('alert')).textContent).toMatch(/stock disponible/i);
  expect(screen.getByLabelText('Cantidad de Yerba').getAttribute('aria-invalid')).toBe('false');
  expect(screen.getByLabelText('Cantidad de Aceite').getAttribute('aria-invalid')).toBe('false');
});

it('T114C rejects a same-branch destination and decimal quantity for UNIT', async () => {
  const confirm = vi.fn();
  render(<InventoryTransfers organizationId="o1" role="EMPLOYEE" branches={branches}
    originBranchId="b1" stocks={stocks} transfers={[]} nextCursor={null}
    onOriginChange={vi.fn()} onReload={vi.fn()} onConfirm={confirm} />);
  await userEvent.type(screen.getByLabelText('Cantidad de Yerba'), '1.5');
  await userEvent.click(screen.getByRole('button', { name: 'Confirmar transferencia' }));
  expect(confirm).not.toHaveBeenCalled();
  expect(screen.getByRole('alert').textContent).toMatch(/destino|entera/i);
  expect(screen.getByLabelText('Destino').getAttribute('aria-invalid')).toBe('true');
  expect(screen.getByRole('alert').querySelector('a')?.getAttribute('href')).toBe('#transfer-destination');
  await userEvent.selectOptions(screen.getByLabelText('Destino'), 'b2');
  await userEvent.click(screen.getByRole('button', { name: 'Confirmar transferencia' }));
  const quantity = screen.getByLabelText('Cantidad de Yerba');
  expect(quantity.getAttribute('aria-invalid')).toBe('true');
  expect(document.getElementById(quantity.getAttribute('aria-describedby')!)?.textContent).toMatch(/entera/i);
});
