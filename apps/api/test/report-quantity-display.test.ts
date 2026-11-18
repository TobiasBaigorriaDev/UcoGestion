import { expect, it } from 'vitest';
import { renderReportPdf } from '../src/modules/reports/report-pdf.js';
import { PDFDocument, PDFRawStream, decodePDFRawStream } from 'pdf-lib';

it('formats quantities and minimums in human-readable report PDFs', async () => {
  const document = await PDFDocument.load(await renderReportPdf('inventory', [
    { id: 'i1', branchId: 'b1', quantity: '24.000', minimum: '0.500' },
  ]));
  const text = document.context.enumerateIndirectObjects().flatMap(([, object]) => {
    if (!(object instanceof PDFRawStream)) return [];
    const content = Buffer.from(decodePDFRawStream(object).decode()).toString('latin1');
    return [...content.matchAll(/\[([^\]]*)\]\s*TJ/g)].map(match =>
      [...(match[1] ?? '').matchAll(/<([0-9a-f]+)>/gi)].map(part =>
        Buffer.from(part[1] ?? '', 'hex').toString('latin1')).join(''));
  }).join('\n');
  expect(text).toContain('Cantidad');
  expect(text).toContain('Mínimo');
  expect(text).toContain('24');
  expect(text).toContain('0,50');
  expect(text).not.toContain('24.000');
});
