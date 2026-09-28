import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PosCart } from '../src/features/sales/pos-cart.js';

const items = [
  { id: 'apple', name: 'Manzana', type: 'PRODUCT' as const, status: 'ACTIVE' as const,
    baseUnit: 'UNIT' as const, price: '10.00', priceVersion: 1, sku: 'MAN', barcode: '779100' },
  { id: 'juice', name: 'Jugo', type: 'PRODUCT' as const, status: 'ACTIVE' as const,
    baseUnit: 'FRACTIONAL' as const, price: '3.50', priceVersion: 1, sku: null, barcode: null },
];

describe('T152A POS cart', () => {
  afterEach(cleanup);

  it('adds a barcode match, adjusts valid quantities, and keeps the action accessible', () => {
    render(<PosCart items={items} />);
    fireEvent.change(screen.getByLabelText('Código de barras'), { target: { value: '779100' } });
    fireEvent.keyDown(screen.getByLabelText('Código de barras'), { key: 'Enter' });
    expect(screen.getByRole('list', { name: 'Carrito' }).textContent).toContain('Manzana');
    const quantity = screen.getByLabelText('Cantidad de Manzana') as HTMLInputElement;
    fireEvent.change(quantity, { target: { value: '1.5' } });
    expect(screen.getByRole('alert').textContent).toContain('entera');
    expect(quantity.value).toBe('1.5');
    fireEvent.change(quantity, { target: { value: '2' } });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(quantity.value).toBe('2');
  });

  it('searches active priced items and reports unknown scans', () => {
    render(<PosCart items={items} />);
    fireEvent.change(screen.getByLabelText('Buscar producto'), { target: { value: 'jug' } });
    fireEvent.click(screen.getByRole('button', { name: 'Agregar Jugo' }));
    expect(screen.getByRole('list', { name: 'Carrito' }).textContent).toContain('Jugo');
    fireEvent.change(screen.getByLabelText('Código de barras'), { target: { value: 'desconocido' } });
    fireEvent.keyDown(screen.getByLabelText('Código de barras'), { key: 'Enter' });
    expect(screen.getByRole('alert').textContent).toContain('No encontramos');
  });

  it('does not publish a partial cart when one quantity is invalid', () => {
    const onLinesChange = vi.fn();
    render(<PosCart items={items} onLinesChange={onLinesChange} />);
    fireEvent.change(screen.getByLabelText('Buscar producto'), { target: { value: 'man' } });
    fireEvent.click(screen.getByRole('button', { name: 'Agregar Manzana' }));
    fireEvent.change(screen.getByLabelText('Buscar producto'), { target: { value: 'jug' } });
    fireEvent.click(screen.getByRole('button', { name: 'Agregar Jugo' }));
    fireEvent.change(screen.getByLabelText('Cantidad de Manzana'), { target: { value: '1.5' } });
    expect(onLinesChange).toHaveBeenLastCalledWith([]);
  });
});
