import axe from 'axe-core';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SaleConfirmation } from '../src/features/sales/sale-confirmation';
import { saleCodeFromId } from '@uconext/shared';

const saleId = '11111111-1111-4111-8111-111111111111';
const saleCode = saleCodeFromId(saleId);
const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

afterEach(() => {
  cleanup(); vi.restoreAllMocks();
  if (clipboardDescriptor) Object.defineProperty(navigator, 'clipboard', clipboardDescriptor);
  else Reflect.deleteProperty(navigator, 'clipboard');
});

describe('D03 confirmation identity', () => {
  it('shows the short ID for a zero sale and copies only that ID by keyboard', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const { container } = render(<SaleConfirmation saleId={saleId} total="0.00" />);
    expect(document.activeElement).toBe(screen.getByRole('region', { name: 'Confirmación de venta' }));
    expect(screen.getByText(saleCode)).toBeDefined();
    expect(screen.getByText(/Total: 0.00/)).toBeDefined();
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Copiar ID de venta' }));
    await user.keyboard('{Enter}');
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(saleCode));
    expect(await screen.findByText('ID de venta copiado.')).toBeDefined();
    expect((await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })).violations).toEqual([]);
  });

  it.each(['missing', 'denied'])('keeps the selectable ID and explains manual copy when clipboard is %s', async kind => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: kind === 'missing'
      ? undefined : { writeText: vi.fn().mockRejectedValue(new Error('denied')) } });
    render(<SaleConfirmation saleId={saleId} total="10.00" />);
    await user.click(screen.getByRole('button', { name: 'Copiar ID de venta' }));
    expect(await screen.findByText('No pudimos copiar el ID. Seleccioná el ID de venta y copialo manualmente.')).toBeDefined();
    expect(screen.getByText(saleCode)).toBeDefined();
    expect(screen.getByText('Venta confirmada')).toBeDefined();
  });

  it('clears copy feedback when the confirmed sale changes', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<SaleConfirmation saleId={saleId} total="10.00" />);
    await user.click(screen.getByRole('button', { name: 'Copiar ID de venta' }));
    await screen.findByText('ID de venta copiado.');
    rerender(<SaleConfirmation saleId="22222222-2222-4222-8222-222222222222" total="20.00" />);
    expect(screen.queryByText('ID de venta copiado.')).toBeNull();
    expect(screen.queryByText(saleCode)).toBeNull();
  });
});
