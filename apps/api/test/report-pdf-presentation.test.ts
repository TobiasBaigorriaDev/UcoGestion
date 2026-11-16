import { expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { renderReportPdf, reportPdfFileName } from '../src/modules/reports/report-pdf.js';
import { reportPdfText } from './report-pdf-text.js';

const context = { organizationName: 'Almacén Don Pedro', timezone: 'America/Argentina/Buenos_Aires',
  generatedAt: new Date('2026-10-12T15:45:00Z'), from: '2026-10-01', to: '2026-10-13',
  branches: [{ id: 'secret-branch-id', name: 'Local principal' }] };

it('names downloads after their report and inclusive dates without internal identifiers', () => {
  expect(reportPdfFileName('expenses', context)).toBe('reporte-gastos-2026-10-01-a-2026-10-12.pdf');
  expect(reportPdfFileName('inventory', context)).toBe('reporte-inventario-actual-2026-10-12.pdf');
});

it('presents the report, inclusive period, organization, generation date and readable rows', async () => {
  const text = await reportPdfText(await renderReportPdf('expenses', [{ id: 'secret-document-id',
    branchId: 'secret-branch-id', categoryName: 'Luz', concept: 'Factura de electricidad',
    occurredAt: '2026-10-12T02:30:00Z', amount: '1234.50', currencyCode: 'ARS', status: 'CONFIRMED',
    actorUserId: 'secret-user-id', internalField: 'must-never-appear' }], context));
  for (const value of ['Reporte de gastos', 'Almacén Don Pedro', '01/10/2026', '12/10/2026',
    '12:45', 'Local principal', 'Categoría', 'Luz', 'Factura de electricidad', '11/10/2026',
    '1.234,50', 'Confirmada', 'Total neto', 'Página 1 de 1']) expect(text).toContain(value);
  expect(text).not.toMatch(/secret-|internalField|must-never-appear|branchId|occurredAt|CONFIRMED/);
  expect(text).not.toContain('13/10/2026');
});

it('repeats table headings and page numbers while preserving every row on multiple pages', async () => {
  const bytes = await renderReportPdf('inventory', Array.from({ length: 85 }, (_, index) => ({
    id: `internal-${index}`, branchId: 'secret-branch-id', name: `Producto ${index}`,
    quantity: '24.000', minimum: '0.500', lowStock: false,
  })), context);
  const document = await PDFDocument.load(bytes);
  const text = await reportPdfText(bytes);
  expect(document.getPageCount()).toBeGreaterThan(1);
  expect(text).toContain('Inventario actual');
  expect(text).toContain('Producto 84');
  expect(text.match(/Cantidad/g)).toHaveLength(document.getPageCount());
  expect(text).toContain('0,50');
  expect(text).not.toContain('24.000');
  expect(text).toContain('Estado actual');
});

it('explains empty reports and renders unknown labels without exposing codes', async () => {
  const text = await reportPdfText(await renderReportPdf('sales', [], context));
  expect(text).toContain('Reporte de ventas');
  expect(text).toContain('Sin registros para los filtros seleccionados');
});
