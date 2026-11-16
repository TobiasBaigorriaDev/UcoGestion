import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PosCart } from '../src/features/sales/pos-cart.js';

const item = (id: string, name: string, price: string, baseUnit: 'UNIT' | 'FRACTIONAL' = 'UNIT') => ({
  id, name, type: 'PRODUCT' as const, status: 'ACTIVE' as const, trackInventory: true, baseUnit, price, priceVersion: 1, sku: null, barcode: null,
});
const items = [item('a', 'Yerba mate', '1800.00'), item('b', 'Queso', '4500.00', 'FRACTIONAL'), item('c', 'Yogur', '900.00')];

describe('D08 counter cart', () => {
  afterEach(cleanup);

  it('adds the first search result with Enter and clears the search for the next product', () => {
    const onLinesChange = vi.fn();
    render(<PosCart items={items} onLinesChange={onLinesChange} />);
    const search = screen.getByLabelText('Buscar producto');
    fireEvent.change(search, { target: { value: 'yo' } });
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(within(screen.getByRole('list', { name: 'Carrito' })).getByText('Yogur')).toBeDefined();
    expect((search as HTMLInputElement).value).toBe('');
    expect(onLinesChange).toHaveBeenLastCalledWith([{ itemId: 'c', quantity: '1' }]);
  });

  it('offers product buttons with Argentine prices before searching', () => {
    render(<PosCart items={items} />);
    const quick = screen.getByRole('list', { name: 'Productos' });
    expect(within(quick).getByRole('button', { name: 'Agregar Yerba mate' }).textContent).toContain('$ 1.800,00');
    fireEvent.click(within(quick).getByRole('button', { name: 'Agregar Queso' }));
    expect(within(screen.getByRole('list', { name: 'Carrito' })).getByText('Queso')).toBeDefined();
  });

  it('adds one more unit when the same product is added again and offers +/− for whole units', () => {
    const onLinesChange = vi.fn();
    render(<PosCart items={items} onLinesChange={onLinesChange} />);
    const quick = screen.getByRole('list', { name: 'Productos' });
    fireEvent.click(within(quick).getByRole('button', { name: 'Agregar Yerba mate' }));
    fireEvent.click(within(quick).getByRole('button', { name: 'Agregar Yerba mate' }));
    expect((screen.getByLabelText('Cantidad de Yerba mate') as HTMLInputElement).value).toBe('2');
    fireEvent.click(screen.getByRole('button', { name: 'Sumar una unidad de Yerba mate' }));
    fireEvent.click(screen.getByRole('button', { name: 'Sumar una unidad de Yerba mate' }));
    fireEvent.click(screen.getByRole('button', { name: 'Restar una unidad de Yerba mate' }));
    expect(onLinesChange).toHaveBeenLastCalledWith([{ itemId: 'a', quantity: '3' }]);
    expect(screen.getByRole('button', { name: 'Restar una unidad de Yerba mate' })).toHaveProperty('disabled', false);
  });

  it('keeps fractional quantities typed, without unit buttons or automatic increments', () => {
    render(<PosCart items={items} />);
    const quick = screen.getByRole('list', { name: 'Productos' });
    fireEvent.click(within(quick).getByRole('button', { name: 'Agregar Queso' }));
    fireEvent.click(within(quick).getByRole('button', { name: 'Agregar Queso' }));
    expect(screen.queryByRole('button', { name: 'Sumar una unidad de Queso' })).toBeNull();
    expect((screen.getByLabelText('Cantidad de Queso') as HTMLInputElement).value).toBe('1');
    expect(screen.getByRole('alert').textContent).toContain('Queso ya está en el carrito');
  });
});
