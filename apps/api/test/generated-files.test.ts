import { PDFDict, PDFDocument, PDFName } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { renderReceiptHtml, renderReceiptPdf } from '../src/modules/sales/receipt-renderer.js';
import { renderReportPdf } from '../src/modules/reports/report-pdf.js';

const injected = '<script>window.receiptExecuted=true</script><img src=x onerror="window.receiptExecuted=true">';
const receipt = { label: 'Comprobante no fiscal', organization: { name: injected }, branch: { name: 'Centro' },
  customer: { name: 'javascript:alert(1)' }, items: [{ name: injected, quantity: '1.000', unit: 'UNIT', lineTotal: '10.00' }],
  payments: [{ method: 'CASH', appliedAmount: '10.00' }], currency: 'ARS', subtotal: '10.00', discount: '0.00', total: '10.00' };

describe('T229 passive generated files', () => {
  it('renders untrusted snapshot text without active HTML', () => {
    const html = renderReceiptHtml(receipt);
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&lt;img');
    expect(html).not.toMatch(/<(?:script|iframe|object|embed|img|a)\b/i);
    expect(Buffer.byteLength(html)).toBeGreaterThan(100);
  });
  it('generates parseable receipt/report PDFs without actions, links or attachments', async () => {
    const files = [await renderReceiptPdf(receipt), await renderReportPdf('expenses', [{ id: 'document', branchId: 'branch', concept: injected, amount: '10.00' }])];
    for (const file of files) {
      expect(Buffer.from(file.subarray(0, 5)).toString()).toBe('%PDF-');
      expect(file.byteLength).toBeGreaterThan(100);
      const pdf = await PDFDocument.load(file);
      expect(pdf.getPageCount()).toBeGreaterThan(0);
      for (const key of ['OpenAction', 'AA', 'AcroForm']) expect(pdf.catalog.has(PDFName.of(key)), key).toBe(false);
      // A Names dictionary can contain harmless destinations; inspect active trees.
      const names = pdf.catalog.lookupMaybe(PDFName.of('Names'), PDFDict);
      for (const key of ['JavaScript', 'EmbeddedFiles']) expect(names?.has(PDFName.of(key)) ?? false, key).toBe(false);
      for (const page of pdf.getPages()) {
        expect(page.node.has(PDFName.of('AA'))).toBe(false);
        expect(page.node.Annots()?.size() ?? 0).toBe(0);
      }
    }
  });
});
