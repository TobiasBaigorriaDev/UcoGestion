import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { OfflineReceiptActions, offlineReceiptHtml } from '../src/features/sales/offline-receipt-actions';
import type { OfflineReceipt } from '../src/offline/offline-pos-actions';
import { saleCodeFromId } from '@uconext/shared';

const receipt: OfflineReceipt = { saleId: '11111111-1111-4111-8111-111111111111', label: 'Comprobante no fiscal', branchName: '<script>alert(1)</script>',
  localReference: 'OFF-device-original', currency: 'ARS', subtotal: '0.00', discount: '0.00', total: '0.00', items: [], payments: [], occurredAt: '2026-10-11T12:00:00Z' };
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('formats offline receipt quantities with the same rule as online receipts', () => {
  const snapshot: OfflineReceipt = { ...receipt, items: [
    { itemId: 'i1', itemName: 'Queso', quantity: '0.500', baseUnit: 'FRACTIONAL',
      unitPrice: '10.00', lineTotal: '5.00', sku: null, barcode: null, type: 'PRODUCT',
      trackInventory: true, priceVersion: 1 },
  ] };
  expect(offlineReceiptHtml(snapshot)).toContain('Queso | 0,50 FRACTIONAL');
  expect(snapshot.items[0]?.quantity).toBe('0.500');
});
it('D03 creates passive local HTML with the short sale code', () => {
  const html = offlineReceiptHtml(receipt);
  expect(html).toContain(`ID de venta: ${saleCodeFromId(receipt.saleId)}`); expect(html).toContain('&lt;script&gt;');
  expect(html).not.toContain('<script>'); expect(html).toContain('cuando se sincronice');
});
it('D03 retains confirmation on blocked popup and failed download', () => {
  vi.spyOn(window, 'open').mockReturnValue(null);
  vi.stubGlobal('URL', { createObjectURL: () => { throw new Error('Storage full'); }, revokeObjectURL: vi.fn() });
  render(<OfflineReceiptActions receipt={receipt} />);
  fireEvent.click(screen.getByRole('button', { name: 'Ver comprobante local para imprimir' }));
  expect(screen.getByRole('alert').textContent).toContain('La venta sigue confirmada');
  fireEvent.click(screen.getByRole('button', { name: 'Descargar comprobante local' }));
  expect(screen.getByRole('alert').textContent).toContain('La venta sigue confirmada');
  fireEvent.click(screen.getByRole('button', { name: 'Ver comprobante local' }));
  expect(screen.getByText(`ID de venta: ${saleCodeFromId(receipt.saleId)}`)).toBeDefined();
});
it('D03 retires temporary print windows and blob URLs with the owning identity', () => {
  const tab = { opener: window, location: { href: '' }, close: vi.fn() };
  vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
  const revoke = vi.fn(); vi.stubGlobal('URL', { createObjectURL: () => 'blob:receipt', revokeObjectURL: revoke });
  const view = render(<OfflineReceiptActions receipt={receipt} />);
  fireEvent.click(screen.getByRole('button', { name: 'Ver comprobante local para imprimir' }));
  expect(tab.location.href).toBe('blob:receipt'); expect(tab.opener).toBeNull();
  view.unmount(); expect(revoke).toHaveBeenCalledWith('blob:receipt'); expect(tab.close).toHaveBeenCalledTimes(1);
});
