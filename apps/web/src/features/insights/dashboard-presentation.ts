import { Money } from '@uconext/shared';
import { startOfDayInTimezone, type DashboardFilters } from './insights-api';

export type DashboardRange = Readonly<{ from: string; through: string }>;
export type DashboardPreset = 'day' | 'week' | 'month';

function calendarDate(value: string): Date {
  const date = new Date(`${value}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new RangeError('Elegí una fecha válida.');
  }
  return date;
}

function dateString(date: Date): string { return date.toISOString().slice(0, 10); }

export function dashboardPeriodRange(preset: DashboardPreset, timezone: string, now: Date): DashboardRange {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const field = (name: string) => parts.find(part => part.type === name)?.value;
  const today = `${field('year')}-${field('month')}-${field('day')}`;
  const first = calendarDate(today);
  const last = calendarDate(today);
  if (preset === 'week') {
    first.setUTCDate(first.getUTCDate() - (first.getUTCDay() + 6) % 7);
    last.setTime(first.getTime()); last.setUTCDate(last.getUTCDate() + 6);
  } else if (preset === 'month') {
    first.setUTCDate(1); last.setUTCMonth(last.getUTCMonth() + 1, 0);
  }
  return { from: dateString(first), through: dateString(last) };
}

export function dashboardRangeFilters(range: DashboardRange, timezone: string): DashboardFilters {
  calendarDate(range.from);
  const end = calendarDate(range.through);
  if (range.from > range.through) throw new RangeError('La fecha Hasta debe ser igual o posterior a Desde.');
  end.setUTCDate(end.getUTCDate() + 1);
  return { from: startOfDayInTimezone(range.from, timezone), to: startOfDayInTimezone(dateString(end), timezone) };
}

export function formatDashboardAmount(value: string): string {
  const [whole = '0', fraction = '00'] = Money.from(value).toString().split('.');
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${fraction}`;
}

// Integer geometry keeps large monetary strings exact; no business totals are recomputed.
export function moneyChartWidths(values: readonly string[]): string[] {
  const units = values.map(value => {
    const cents = BigInt(Money.from(value).toString().replace('.', ''));
    return cents < 0n ? -cents : cents;
  });
  const maximum = units.reduce((max, value) => value > max ? value : max, 0n);
  return units.map(value => maximum === 0n ? '0' : (value * 1000n / maximum).toString());
}

export function dashboardRangeLabel(range: DashboardRange | null): string {
  if (!range) return 'Todo el historial';
  const format = (value: string) => new Intl.DateTimeFormat('es-AR', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' }).format(calendarDate(value));
  return range.from === range.through ? format(range.from) : `${format(range.from)} al ${format(range.through)}`;
}
