import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ReceiptActions } from '../src/features/sales/receipt-actions.js';

describe('T152D receipt recovery', () => {
  const originalCreate = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
  const originalRevoke = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');
  afterEach(() => {
    cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks();
    if (originalCreate) Object.defineProperty(URL, 'createObjectURL', originalCreate);
    else Reflect.deleteProperty(URL, 'createObjectURL');
    if (originalRevoke) Object.defineProperty(URL, 'revokeObjectURL', originalRevoke);
    else Reflect.deleteProperty(URL, 'revokeObjectURL');
  });

  it('shows a recoverable PDF failure without changing the confirmed sale', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response('Unavailable', { status: 503 }))
      .mockResolvedValueOnce(new Response(new Blob(['%PDF-'], { type: 'application/pdf' }),
        { status: 200, headers: { 'Content-Type': 'application/pdf' } }));
    vi.stubGlobal('fetch', fetcher);
    const createObjectURL = vi.fn().mockReturnValue('blob:receipt');
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    render(<><p>Venta confirmada</p><ReceiptActions organizationId="org" saleId="sale" /></>);
    fireEvent.click(screen.getByRole('button', { name: 'Descargar PDF' }));
    await screen.findByRole('alert');
    expect(screen.getByText('Venta confirmada')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Descargar PDF' }));
    await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({ 'X-Organization-Id': 'org' });
  });
});
