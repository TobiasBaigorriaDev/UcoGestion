import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, expect, it, vi } from 'vitest';

import { InventoryStock } from '../src/features/inventory/inventory-stock.js';

afterEach(cleanup);

const stocks = [{ branchId: 'b1', itemId: 'i1', itemName: 'Yerba', baseUnit: 'UNIT' as const,
  quantity: '2.000', threshold: '2.000', lowStock: true },
{ branchId: 'b1', itemId: 'i2', itemName: 'Aceite', baseUnit: 'UNIT' as const,
  quantity: '8.000', threshold: null, lowStock: false }];
const branches = [{ id: 'b1', name: 'Principal' }, { id: 'b2', name: 'Depósito' }];

it('T114A shows inclusive low stock and lets cashier inspect without edit controls', async () => {
  const { container } = render(<InventoryStock organizationId="o1" role="CASHIER" branches={branches}
    branchId="b1" stocks={stocks} nextCursor={null} onBranchChange={vi.fn()} onReload={vi.fn()} />);
  expect(within(screen.getByText('Yerba').closest('li')!).getByText(/Stock bajo/)).toBeTruthy();
  expect(within(screen.getByText('Aceite').closest('li')!).getByText(/Sin mínimo configurado/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: /guardar mínimo/i })).toBeNull();
  expect((await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })).violations).toEqual([]);
});

it('T114A allows employee to change a minimum and select an assigned branch', async () => {
  const save = vi.fn().mockResolvedValue(undefined);
  const change = vi.fn();
  render(<InventoryStock organizationId="o1" role="EMPLOYEE" branches={branches} branchId="b1"
    stocks={stocks} nextCursor={null} onBranchChange={change} onReload={vi.fn()} onSaveThreshold={save} />);
  await userEvent.clear(screen.getByRole('textbox', { name: /mínimo de Yerba/i }));
  await userEvent.type(screen.getByRole('textbox', { name: /mínimo de Yerba/i }), '4');
  await userEvent.click(screen.getByRole('button', { name: /guardar mínimo de Yerba/i }));
  expect(save).toHaveBeenCalledWith('o1', 'b1', 'i1', '4');
  await userEvent.selectOptions(screen.getByLabelText('Sucursal'), 'b2');
  expect(change).toHaveBeenCalledWith('b2');
});

it('T114A prioritizes low stock and links minimum errors to their input', async () => {
  render(<InventoryStock organizationId="o1" role="EMPLOYEE" branches={branches} branchId="b1"
    stocks={[stocks[1]!, stocks[0]!]} nextCursor={null} onBranchChange={vi.fn()} onReload={vi.fn()} />);
  await userEvent.click(screen.getByRole('button', { name: /solo stock bajo/i }));
  expect(screen.getByText('Yerba')).toBeTruthy();
  expect(screen.queryByText('Aceite')).toBeNull();
  const input = screen.getByRole('textbox', { name: /mínimo de Yerba/i });
  await userEvent.clear(input);
  await userEvent.type(input, '1.5');
  await userEvent.click(screen.getByRole('button', { name: /guardar mínimo de Yerba/i }));
  expect(input.getAttribute('aria-invalid')).toBe('true');
  expect(document.getElementById(input.getAttribute('aria-describedby')!)?.textContent).toMatch(/entero/i);
  expect(screen.getByRole('alert').querySelector('a')?.getAttribute('href')).toBe('#minimum-i1');
});

it('T114A accepts an unchanged stored UNIT minimum displayed as an integer', async () => {
  const save = vi.fn().mockResolvedValue(undefined);
  render(<InventoryStock organizationId="o1" role="OWNER" branches={branches} branchId="b1"
    stocks={stocks} nextCursor="more" onBranchChange={vi.fn()} onReload={vi.fn()} onSaveThreshold={save}
    onLoadMore={vi.fn()} />);
  expect((screen.getByRole('textbox', { name: /mínimo de Yerba/i }) as HTMLInputElement).value).toBe('2');
  expect(screen.getByText(/entre los productos cargados/i)).toBeTruthy();
  await userEvent.click(screen.getByRole('button', { name: /guardar mínimo de Yerba/i }));
  expect(save).toHaveBeenCalledWith('o1', 'b1', 'i1', '2');
});
