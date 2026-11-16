import { createElement } from 'react';
import { Document, Page, Text, View, renderToBuffer, StyleSheet } from '@react-pdf/renderer';
import { formatQuantityForDisplay, Money, sumMoney } from '@uconext/shared';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import type { ReportDataset, ReportItem } from './reports.service.js';

export interface ReportPdfContext {
  organizationName: string; timezone: string; generatedAt: Date;
  branches: readonly { id: string; name: string }[];
  branchId?: string | undefined; from?: string | undefined; to?: string | undefined;
  status?: string | undefined; lowStock?: boolean | undefined;
}
type Column = { key: string; label: string; width: number; numeric?: boolean };
const titles: Record<ReportDataset, string> = {
  sales: 'Reporte de ventas', purchases: 'Reporte de compras', expenses: 'Reporte de gastos',
  inventory: 'Inventario actual', 'inventory-movements': 'Movimientos de inventario', cash: 'Reporte de caja',
};
const columns: Record<ReportDataset, readonly Column[]> = {
  sales: [{ key: 'occurredAt', label: 'Fecha y hora', width: 19 }, { key: 'branchId', label: 'Sucursal', width: 30 },
    { key: 'status', label: 'Estado', width: 23 }, { key: 'total', label: 'Total', width: 28, numeric: true }],
  purchases: [{ key: 'occurredAt', label: 'Fecha y hora', width: 19 }, { key: 'branchId', label: 'Sucursal', width: 30 },
    { key: 'status', label: 'Estado', width: 23 }, { key: 'total', label: 'Total', width: 28, numeric: true }],
  expenses: [{ key: 'occurredAt', label: 'Fecha y hora', width: 15 }, { key: 'branchId', label: 'Sucursal', width: 16 },
    { key: 'categoryName', label: 'Categoría', width: 15 }, { key: 'concept', label: 'Concepto', width: 22 },
    { key: 'status', label: 'Estado', width: 12 }, { key: 'amount', label: 'Importe', width: 20, numeric: true }],
  inventory: [{ key: 'name', label: 'Producto', width: 36 }, { key: 'branchId', label: 'Sucursal', width: 23 },
    { key: 'quantity', label: 'Cantidad', width: 15, numeric: true }, { key: 'minimum', label: 'Mínimo', width: 14, numeric: true },
    { key: 'lowStock', label: 'Stock bajo', width: 12 }],
  'inventory-movements': [{ key: 'occurredAt', label: 'Fecha y hora', width: 18 }, { key: 'branchId', label: 'Sucursal', width: 21 },
    { key: 'itemName', label: 'Producto', width: 28 }, { key: 'effectKind', label: 'Movimiento', width: 18 },
    { key: 'delta', label: 'Cambio', width: 15, numeric: true }],
  cash: [{ key: 'openedAt', label: 'Apertura', width: 17 }, { key: 'branchId', label: 'Sucursal', width: 22 },
    { key: 'status', label: 'Estado', width: 19 }, { key: 'expectedCash', label: 'Efectivo esperado', width: 22, numeric: true },
    { key: 'difference', label: 'Diferencia', width: 20, numeric: true }],
};
const statusLabels: Record<string, string> = { CONFIRMED: 'Confirmada', CANCELLED: 'Anulada', PAID: 'Pagada',
  PENDING_PAYMENT: 'Pendiente de pago', OPEN: 'Abierta', CLOSING: 'En cierre', CONFLICTED: 'En conflicto',
  CLOSED: 'Cerrada', CLOSED_CONFLICT_RESOLVED: 'Cerrada tras conciliación',
  CLOSED_WITH_UNRECOVERED_DEVICE: 'Cerrada con dispositivo irrecuperable' };
const effectLabels: Record<string, string> = { INCREASE: 'Ingreso', DECREASE: 'Egreso',
  TRANSFER_OUT: 'Salida por traslado', TRANSFER_IN: 'Entrada por traslado' };
const styles = StyleSheet.create({
  page: { paddingTop: 231, paddingBottom: 62, paddingHorizontal: 36, fontFamily: 'Helvetica',
    fontSize: 9, color: '#0F172A' },
  header: { position: 'absolute', top: 30, left: 36, right: 36 },
  title: { fontSize: 24, lineHeight: 1.15, fontFamily: 'Helvetica-Bold', color: '#166534', marginBottom: 8 },
  organization: { fontSize: 12, lineHeight: 1.3, fontFamily: 'Helvetica-Bold', marginBottom: 12, maxLines: 2 },
  metadata: { fontSize: 9, lineHeight: 1.3, color: '#475569', marginBottom: 4, maxLines: 2 },
  period: { fontSize: 11, lineHeight: 1.3, fontFamily: 'Helvetica-Bold', marginBottom: 4 },
  tableHeader: { flexDirection: 'row', backgroundColor: '#166534', color: '#FFFFFF',
    position: 'absolute', top: 200, left: 36, right: 36,
    paddingVertical: 9, fontFamily: 'Helvetica-Bold', fontSize: 8, lineHeight: 1.3 },
  row: { flexDirection: 'row', borderBottomWidth: 0.5, borderBottomColor: '#DCE4DF', paddingVertical: 9 },
  cell: { paddingHorizontal: 7, lineHeight: 1.4 },
  summary: { marginTop: 20, borderTopWidth: 1, borderTopColor: '#166534', paddingTop: 12 },
  summaryTitle: { fontSize: 12, fontFamily: 'Helvetica-Bold', marginBottom: 6 },
  note: { fontSize: 8, color: '#475569', marginTop: 5 },
  footer: { position: 'absolute', top: 800, height: 22, left: 36, right: 36, flexDirection: 'row',
    justifyContent: 'space-between', borderTopWidth: 0.5, borderTopColor: '#DCE4DF', paddingTop: 8,
    fontSize: 8, lineHeight: 1.3, color: '#475569' },
});
const dateOnly = (date: string) => date.split('-').reverse().join('/');
const previousDate = (date: string) => new Date(Date.parse(date) - 86_400_000).toISOString().slice(0, 10);
export function reportPdfFileName(dataset: ReportDataset, context: ReportPdfContext): string {
  const names: Record<ReportDataset, string> = { sales: 'ventas', purchases: 'compras', expenses: 'gastos',
    inventory: 'inventario-actual', 'inventory-movements': 'movimientos-de-inventario', cash: 'caja' };
  const currentDate = context.generatedAt.toLocaleDateString('en-CA', { timeZone: context.timezone,
    year: 'numeric', month: '2-digit', day: '2-digit' });
  const through = context.to ? previousDate(context.to) : undefined;
  const period = dataset === 'inventory' ? currentDate
    : context.from && through ? context.from === through ? through : `${context.from}-a-${through}`
      : context.from ? `desde-${context.from}` : through ? `hasta-${through}` : `historial-${currentDate}`;
  return `reporte-${names[dataset]}-${period}.pdf`;
}
const localDate = (value: Date, timezone: string) => value.toLocaleString('es-AR', { timeZone: timezone,
  day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const money = (value: string) => {
  const [integer = '', fraction = '00'] = Money.from(value).toString().split('.');
  return `${integer.replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${fraction}`;
};
function periodLabel(dataset: ReportDataset, context: ReportPdfContext): string {
  if (dataset === 'inventory') return `Estado actual al ${localDate(context.generatedAt, context.timezone)}`;
  if (context.from && context.to) return `Del ${dateOnly(context.from)} al ${dateOnly(previousDate(context.to))} (inclusive)`;
  if (context.from) return `Desde el ${dateOnly(context.from)}`;
  if (context.to) return `Hasta el ${dateOnly(previousDate(context.to))} (inclusive)`;
  return 'Todo el historial';
}
function cellValue(column: Column, item: ReportItem, context: ReportPdfContext): string {
  const value = item[column.key];
  if (column.key === 'branchId') return context.branches.find(branch => branch.id === item.branchId)?.name ?? 'Sucursal no disponible';
  if (value === null || value === undefined) return '-';
  if (column.key === 'status') return typeof value === 'string' ? statusLabels[value] ?? 'Estado no disponible' : '-';
  if (column.key === 'effectKind') return typeof value === 'string' ? effectLabels[value] ?? 'Movimiento no disponible' : '-';
  if (column.key === 'lowStock') return value === true ? 'Sí' : 'No';
  if (typeof value !== 'string') return '-';
  if (['occurredAt', 'openedAt'].includes(column.key)) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '-' : localDate(date, context.timezone);
  }
  if (['quantity', 'minimum', 'delta'].includes(column.key)) return formatQuantityForDisplay(value);
  if (column.numeric) return `${money(value)}\n${typeof item.currencyCode === 'string' ? item.currencyCode : ''}`;
  return value;
}

export async function renderReportPdf(dataset: ReportDataset, items: readonly ReportItem[],
  context: ReportPdfContext = { organizationName: 'UcoNext', timezone: 'UTC', generatedAt: new Date(), branches: [] }): Promise<Uint8Array> {
  const title = titles[dataset];
  const tableColumns = columns[dataset];
  const branchLabel = context.branchId ? context.branches.find(branch => branch.id === context.branchId)?.name ?? 'Sucursal no disponible'
    : 'Todas las sucursales autorizadas';
  const filterLabels = [`${context.branchId ? 'Sucursal' : 'Alcance'}: ${branchLabel}`,
    ...(context.status ? [`Estado: ${statusLabels[context.status] ?? 'No disponible'}`] : []),
    ...(context.lowStock === undefined ? [] : [context.lowStock ? 'Solo stock bajo' : 'Sin stock bajo'])];
  const totals = new Map<string, string[]>();
  if (['sales', 'purchases', 'expenses'].includes(dataset)) {
    for (const item of items) {
      const amount = item[dataset === 'expenses' ? 'amount' : 'total'];
      if (item.status === 'CANCELLED' || typeof amount !== 'string' || typeof item.currencyCode !== 'string') continue;
      const values = totals.get(item.currencyCode) ?? []; values.push(amount); totals.set(item.currencyCode, values);
    }
  }
  const header = createElement(View, { style: styles.header, fixed: true },
    createElement(Text, { style: styles.title }, title),
    createElement(Text, { style: styles.organization }, context.organizationName),
    createElement(Text, { style: styles.period }, periodLabel(dataset, context)),
    createElement(Text, { style: styles.metadata }, `Generado el ${localDate(context.generatedAt, context.timezone)} · Hora local del negocio`),
    createElement(Text, { style: styles.metadata }, filterLabels.join(' · ')),
    createElement(Text, { style: styles.metadata }, `${items.length} ${items.length === 1 ? 'registro' : 'registros'}`));
  const tableHeader = createElement(View, { style: styles.tableHeader, fixed: true },
    ...tableColumns.map(column => createElement(Text,
      { key: column.key, style: [styles.cell, { width: `${column.width}%`, textAlign: column.numeric ? 'right' : 'left' }] }, column.label)));
  const rows = items.map((item, index) => createElement(View, { key: `${item.branchId}:${item.id}`,
    wrap: false, style: [styles.row, { backgroundColor: index % 2 === 0 ? '#F4F7F5' : '#FFFFFF' }] },
    ...tableColumns.map(column => createElement(Text, { key: column.key,
      style: [styles.cell, { width: `${column.width}%`, textAlign: column.numeric ? 'right' : 'left',
        fontSize: column.numeric ? 8 : 9 }] }, cellValue(column, item, context)))));
  const summary = totals.size ? createElement(View, { style: styles.summary, wrap: false },
    createElement(Text, { style: styles.summaryTitle }, 'Resumen del período'),
    ...[...totals].map(([currency, values]) => createElement(Text, { key: currency }, `Total neto: ${money(sumMoney(values))} ${currency}`)),
    createElement(Text, { style: styles.note }, 'Las operaciones anuladas aparecen en el detalle y se excluyen del total neto.')) : null;
  const footer = createElement(View, { style: styles.footer, fixed: true },
    createElement(Text, { style: { width: 200, height: 14 } }, 'UcoNext · Reportes'));
  const document = createElement(Document, { title, author: context.organizationName, subject: periodLabel(dataset, context), language: 'es-AR' },
    createElement(Page, { size: 'A4', style: styles.page }, header, tableHeader,
      ...(items.length ? rows : [createElement(Text, { key: 'empty', style: styles.note }, 'Sin registros para los filtros seleccionados.')]),
      summary, footer));
  // Stamp after pagination so numbering has a stable position on every page.
  const pdf = await PDFDocument.load(await renderToBuffer(document));
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const pages = pdf.getPages();
  for (const [index, page] of pages.entries()) {
    const label = `Página ${index + 1} de ${pages.length}`;
    page.drawText(label, { x: page.getWidth() - 36 - font.widthOfTextAtSize(label, 8),
      y: 26, font, size: 8, color: rgb(71 / 255, 85 / 255, 105 / 255) });
  }
  return pdf.save();
}
