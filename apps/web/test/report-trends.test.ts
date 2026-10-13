import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { buildReportTrends, loadReportChartRows, reportChartRange, reportRangeFilters } from '../src/features/insights/report-trends';
import type { ReportPage } from '../src/features/insights/insights-api';

const range = { from: '2026-10-01', through: '2026-10-03' };
const row = { id: 's1', branchId: 'b', occurredAt: '2026-10-02T02:00:00Z', status: 'CONFIRMED', total: '0.10', currencyCode: 'ARS' };
const now = new Date('2026-10-02T15:00:00Z');
describe('tendencias de reportes', () => {
  it('agrupa gastos por ID de categoría y moneda con ceros e importes exactos, sin anulaciones', () => {
    const expenses = [{ ...row, categoryId: 'light', categoryName: 'Luz', amount: '0.10' },
      { ...row, id: 'e2', categoryId: 'light', categoryName: 'Luz', amount: '0.20' },
      { ...row, id: 'e3', categoryId: 'rent', categoryName: 'Alquiler', amount: '500.00' },
      { ...row, id: 'e4', categoryId: 'light', categoryName: 'Luz', amount: '1000.00', status: 'CANCELLED' },
      { ...row, id: 'e5', categoryId: 'light', categoryName: 'Luz', amount: '2.00', currencyCode: 'USD' }];
    expect(buildReportTrends(expenses, 'expenses', range, 'UTC', now).categories).toEqual([
      { id: 'rent', name: 'Alquiler', currency: 'ARS', values: ['0.00', '500.00'] },
      { id: 'light', name: 'Luz', currency: 'ARS', values: ['0.00', '0.30'] },
      { id: 'light', name: 'Luz', currency: 'USD', values: ['0.00', '2.00'] },
    ]);
  });
  it('conserva fechas inclusivas, cambios de mes y el límite de gráficos', () => {
    expect(reportRangeFilters({ from: '2026-12-31', through: '2026-12-31' })).toEqual({ from: '2026-12-31', to: '2027-01-01' });
    expect(reportChartRange({ from: '2026-10-01', to: '2026-11-01' })).toEqual({ from: '2026-10-01', through: '2026-10-31' });
    expect(reportChartRange({ from: '2026-10-01', to: '2026-11-02' })).toBeNull();
    expect(() => reportRangeFilters({ from: '2026-10-02', through: '2026-10-01' })).toThrow();
  });
  it('agrupa en hora local, completa ceros y corta los intervalos futuros', () => {
    const result = buildReportTrends([row], 'sales', range, 'America/Argentina/Buenos_Aires', now);
    expect(result.labels).toEqual(['2026-10-01', '2026-10-02']);
    expect(result.amounts).toEqual([{ currency: 'ARS', values: ['0.10', '0.00'] }]);
    expect(result.counts).toEqual(['1', '0']);
  });
  it('separa monedas históricas y no duplica registros ni suma anulaciones', () => {
    const result = buildReportTrends([row, row, { ...row, id: 's2', currencyCode: 'USD' },
      { ...row, id: 's3', status: 'CANCELLED', total: '900.00' }], 'sales', range, 'UTC', now);
    expect(result.counts).toEqual(['0', '2']);
    expect(result.amounts).toEqual([{ currency: 'ARS', values: ['0.00', '0.10'] }, { currency: 'USD', values: ['0.00', '0.10'] }]);
  });
  it('usa amount en gastos y la fecha de apertura en caja', () => {
    expect(buildReportTrends([{ ...row, amount: '12.34' }], 'expenses', range, 'UTC', now).amounts[0]?.values).toEqual(['0.00', '12.34']);
    expect(buildReportTrends([{ ...row, openedAt: '2026-10-01T15:00:00Z' }], 'cash', range, 'UTC', now).counts).toEqual(['1', '0']);
    expect(buildReportTrends([row], 'inventory-movements', range, 'UTC', now).amounts).toEqual([]);
  });
  it('mantiene exactamente las sumas decimales para importes variables', () => {
    fc.assert(fc.property(fc.array(fc.bigInt({ min: 0n, max: 999999999999999999n }), { minLength: 1, maxLength: 20 }), cents => {
      const format = (value: bigint) => `${value / 100n}.${String(value % 100n).padStart(2, '0')}`;
      const rows = cents.map((value, index) => ({ ...row, id: String(index), total: format(value) }));
      const result = buildReportTrends(rows, 'sales', range, 'UTC', now);
      expect(result.amounts[0]?.values[1]).toBe(format(cents.reduce((sum, value) => sum + value, 0n)));
    }));
  });
  it('rechaza errores de páginas posteriores y cursores repetidos sin devolver datos parciales', async () => {
    const signal = new AbortController().signal;
    let calls = 0;
    await expect(loadReportChartRows(async () => {
      if (calls++) throw new Error('offline');
      return { dataset: 'sales', items: [row], nextCursor: 'next' };
    }, 'o', 'sales', {}, signal)).rejects.toThrow('offline');
    await expect(loadReportChartRows(async (): Promise<ReportPage> => ({ dataset: 'sales', items: [row], nextCursor: 'same' }),
      'o', 'sales', {}, signal)).rejects.toThrow('Acotá');
  });
});
