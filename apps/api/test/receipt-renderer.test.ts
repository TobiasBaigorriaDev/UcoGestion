import { describe, expect, it } from 'vitest';
import { renderReceiptHtml, renderReceiptPdf } from '../src/modules/sales/receipt-renderer.js';
import { pdfText } from './receipt-pdf-text.js';
import { saleCodeFromId } from '@uconext/shared';

const saleId = '11111111-1111-4111-8111-111111111111';
const receipt = { saleId, saleCode: saleCodeFromId(saleId), label: 'Comprobante no fiscal', organization: { name: 'Local' },
  branch: { name: '<script>private()</script>' }, customer: null, items: [], payments: [],
  subtotal: '0.00', discount: '0.00', total: '0.00', currency: 'ARS' };

describe('D03 receipt identity', () => {
  it('preserves the original paid and on-account amounts in HTML and PDF', async () => {
    const snapshot = { ...receipt, total: '10.00', paidAmount: '4.00', onAccountAmount: '6.00',
      customer: { name: 'Ana' }, payments: [{ method: 'CASH', appliedAmount: '4.00' }] };
    for (const output of [renderReceiptHtml(snapshot), await pdfText(await renderReceiptPdf(snapshot))]) {
      expect(output).toContain('Total: 10.00 ARS');
      expect(output).toContain('Pagado en esta venta: 4.00 ARS');
      expect(output).toContain('A cuenta del cliente: 6.00 ARS');
      expect(output).toContain('CASH: 4.00');
    }
    expect(snapshot.onAccountAmount).toBe('6.00');
  });
  it('uses the same quantity format in HTML and PDF without altering snapshots', async () => {
    const snapshot = { ...receipt, items: [
      { name: 'Cajas', quantity: '24.000', unit: 'UNIT', lineTotal: '24.00' },
      { name: 'Queso', quantity: '1.235', unit: 'FRACTIONAL', lineTotal: '12.35' },
    ] };
    for (const output of [renderReceiptHtml(snapshot), await pdfText(await renderReceiptPdf(snapshot))]) {
      expect(output).toContain('Cajas | 24 UNIT');
      expect(output).toContain('Queso | 1,24 FRACTIONAL');
    }
    expect(snapshot.items[1]?.quantity).toBe('1.235');
  });
  it('prints the short sale code as visible text while escaping snapshot values', () => {
    const html = renderReceiptHtml(receipt);
    expect(html).toContain(`ID de venta: ${receipt.saleCode}`);
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
  });
  it('includes the same ID in the decoded PDF page text', async () => {
    expect(await pdfText(await renderReceiptPdf(receipt))).toContain(`ID de venta: ${receipt.saleCode}`);
  });
});
