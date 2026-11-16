import { mkdir, writeFile } from 'node:fs/promises';
import { renderReportPdf } from '../../apps/api/dist/modules/reports/report-pdf.js';
const context = { organizationName: 'Almacén Don Pedro', timezone: 'America/Argentina/Buenos_Aires',
  generatedAt: new Date('2026-10-12T15:45:00Z'), from: '2026-10-01', to: '2026-10-13',
  branches: [{ id: 'b1', name: 'Local principal' }], branchId: 'b1' };
const expenses = [
  { categoryName: 'Servicios', concept: 'Factura de electricidad', amount: '48250.50', status: 'CONFIRMED' },
  { categoryName: 'Alquiler', concept: 'Alquiler del local - octubre', amount: '350000.00', status: 'CONFIRMED' },
  { categoryName: 'Servicios', concept: 'Internet y telefonía', amount: '28500.00', status: 'CONFIRMED' },
  { categoryName: 'Mantenimiento', concept: 'Reparación de la heladera exhibidora', amount: '76000.00', status: 'CANCELLED' },
  { categoryName: 'Limpieza', concept: 'Insumos de limpieza para el salón y el depósito', amount: '18450.75', status: 'CONFIRMED' },
].map((item, index) => ({ ...item, id: `e${index}`, branchId: 'b1', currencyCode: 'ARS', occurredAt: '2026-10-11T13:30:00Z' }));
await mkdir('output/pdf', { recursive: true });
await writeFile('output/pdf/reporte-de-gastos.pdf', await renderReportPdf('expenses', expenses, context));
await writeFile('output/pdf/inventario-multipagina.pdf', await renderReportPdf('inventory',
  Array.from({ length: 85 }, (_, index) => ({ id: `i${index}`, branchId: 'b1',
    name: index === 0 ? 'Queso cremoso de elaboración artesanal' : `Producto del almacén ${index + 1}`,
    quantity: index === 0 ? '1.235' : '24.000', minimum: '0.500', lowStock: false })), context));
await writeFile('output/pdf/reporte-textos-largos.pdf', await renderReportPdf('cash', [{
  id: 'c1', branchId: 'b1', openedAt: '2026-10-12T13:30:00Z', status: 'CLOSED_WITH_UNRECOVERED_DEVICE',
  expectedCash: '123456789012345678.99', difference: '-98765432109876543.21', currencyCode: 'ARS',
}], { ...context, organizationName: 'Almacén y distribuidora de productos artesanales de la cordillera y del Valle de Uco',
  branches: [{ id: 'b1', name: 'Sucursal del paseo comercial del centro y depósito de mercadería regional' }] }));
console.log('PDF previews generated');
