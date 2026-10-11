import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { dashboardPeriodRange, dashboardRangeFilters, formatDashboardAmount, moneyChartWidths } from '../src/features/insights/dashboard-presentation';

describe('dashboard calendar periods', () => {
  const timezone = 'America/Argentina/Buenos_Aires';
  const now = new Date('2026-10-12T01:30:00Z');
  it('uses the organization day rather than the UTC day', () => {
    expect(dashboardPeriodRange('day', timezone, now)).toEqual({ from: '2026-10-11', through: '2026-10-11' });
    expect(dashboardPeriodRange('week', timezone, now)).toEqual({ from: '2026-10-05', through: '2026-10-11' });
    expect(dashboardPeriodRange('month', timezone, now)).toEqual({ from: '2026-10-01', through: '2026-10-31' });
  });
  it('includes the final date and handles DST and leap years with calendar arithmetic', () => {
    expect(dashboardPeriodRange('month', timezone, new Date('2024-02-20T12:00:00Z'))).toEqual({ from: '2024-02-01', through: '2024-02-29' });
    expect(dashboardRangeFilters({ from: '2026-03-08', through: '2026-03-08' }, 'America/New_York')).toEqual({ from: '2026-03-08T05:00:00.000Z', to: '2026-03-09T04:00:00.000Z' });
    expect(dashboardPeriodRange('week', timezone, new Date('2026-01-01T12:00:00Z'))).toEqual({ from: '2025-12-29', through: '2026-01-04' });
  });
  it('rejects missing, impossible and reversed dates before querying', () => {
    for (const range of [{ from: '', through: '' }, { from: '2026-02-30', through: '2026-03-01' }, { from: '2026-10-12', through: '2026-10-11' }]) {
      expect(() => dashboardRangeFilters(range, timezone)).toThrow();
    }
  });
});

describe('exact chart presentation', () => {
  it('formats large monetary strings without a number conversion', () => {
    expect(formatDashboardAmount('999999999999999999.99')).toBe('999.999.999.999.999.999,99');
    expect(formatDashboardAmount('-1250.50')).toBe('-1.250,50');
    expect(moneyChartWidths(['0.00', '999999999999999999.99'])).toEqual(['0', '1000']);
    expect(moneyChartWidths(['0.00', '0.00'])).toEqual(['0', '0']);
  });
  it('keeps every graphical width bounded and preserves ordering', () => {
    fc.assert(fc.property(fc.array(fc.bigInt({ min: 0n, max: 99999999999999999999n }), { minLength: 1, maxLength: 10 }), cents => {
      const amounts = cents.map(value => `${value / 100n}.${(value % 100n).toString().padStart(2, '0')}`);
      const widths = moneyChartWidths(amounts).map(BigInt);
      expect(widths.every(value => value >= 0n && value <= 1000n)).toBe(true);
      for (let index = 1; index < cents.length; index++) {
        const current = cents[index], previous = cents[index - 1];
        const currentWidth = widths[index], previousWidth = widths[index - 1];
        if (current === undefined || previous === undefined || currentWidth === undefined || previousWidth === undefined) throw new Error('Missing generated chart entry');
        if (current >= previous) expect(currentWidth >= previousWidth).toBe(true);
      }
    }));
  });
});
