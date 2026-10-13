import { describe, expect, it } from 'vitest';
import { renderReceiptHtml, renderReceiptPdf } from '../src/modules/sales/receipt-renderer.js';
import { pdfText } from './receipt-pdf-text.js';
import { saleCodeFromId } from '@uconext/shared';

const saleId = '11111111-1111-4111-8111-111111111111';
const receipt = { saleId, saleCode: saleCodeFromId(saleId), label: 'Comprobante no fiscal', organization: { name: 'Local' },
  branch: { name: '<script>private()</script>' }, customer: null, items: [], payments: [],
  subtotal: '0.00', discount: '0.00', total: '0.00', currency: 'ARS' };

describe('D03 receipt identity', () => {
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
