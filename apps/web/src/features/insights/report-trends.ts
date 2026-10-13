import { sumMoney } from '@uconext/shared';
import type { DashboardRange } from './dashboard-presentation';
import type { ReportDataset, ReportFilters, ReportPage } from './insights-api';

export function reportRangeFilters(range: DashboardRange): Pick<ReportFilters, 'from' | 'to'> {
  const end = new Date(`${range.through}T00:00:00Z`);
  if (!range.from || !Number.isFinite(end.getTime()) || range.from > range.through) {
    throw new RangeError('La fecha Hasta debe ser igual o posterior a Desde.');
  }
  end.setUTCDate(end.getUTCDate() + 1);
  return { from: range.from, to: end.toISOString().slice(0, 10) };
}

export function reportChartRange(filters: ReportFilters): DashboardRange | null {
  if (!filters.from || !filters.to) return null;
  const length = (Date.parse(filters.to) - Date.parse(filters.from)) / 86_400_000;
  if (length < 1 || length > 31 || !Number.isFinite(length)) return null;
  return { from: filters.from, through: new Date(Date.parse(filters.to) - 86_400_000).toISOString().slice(0, 10) };
}

export async function loadReportChartRows(load: (organization: string, dataset: ReportDataset,
  filters: ReportFilters) => Promise<ReportPage>, organization: string, dataset: ReportDataset,
  filters: ReportFilters, signal: AbortSignal): Promise<ReportPage['items']> {
  const rows: ReportPage['items'] = [];
  const cursors = new Set<string>();
  let cursor: string | null = null;
  do {
    signal.throwIfAborted();
    const page = await load(organization, dataset, { ...filters, ...(cursor ? { cursor } : {}) });
    signal.throwIfAborted();
    rows.push(...page.items);
    cursor = page.nextCursor;
    if (cursor && (cursors.has(cursor) || cursors.size >= 199)) {
      throw new Error('El período tiene demasiados registros para graficar. Acotá las fechas o la sucursal.');
    }
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return rows;
}

function localBucket(instant: Date, timezone: string, hourly: boolean): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(instant);
  const part = (key: string) => parts.find(value => value.type === key)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}${hourly ? `T${part('hour')}:00` : ''}`;
}

export function buildReportTrends(rows: ReportPage['items'], dataset: ReportDataset,
  range: DashboardRange, timezone: string, now: Date) {
  const hourly = range.from === range.through;
  const current = localBucket(now, timezone, hourly);
  const labels: string[] = [];
  if (hourly) {
    for (let hour = 0; hour < 24; hour++) {
      const label = `${range.from}T${String(hour).padStart(2, '0')}:00`;
      if (label <= current) labels.push(label);
    }
  } else {
    for (let day = Date.parse(range.from); day <= Date.parse(range.through); day += 86_400_000) {
      const label = new Date(day).toISOString().slice(0, 10);
      if (label <= current) labels.push(label);
    }
  }
  const monetary = ['sales', 'purchases', 'expenses'].includes(dataset);
  const buckets = new Map(labels.map(label => [label, { count: 0n, amounts: new Map<string, string[]>() }]));
  const categories = new Map<string, { id: string; name: string; currency: string; buckets: Map<string, string[]> }>();
  const seen = new Set<string>();
  for (const row of rows) {
    const key = `${row.branchId}:${row.id}`;
    if (seen.has(key) || row.status === 'CANCELLED') continue;
    seen.add(key);
    const timestamp = dataset === 'cash' ? row.openedAt : row.occurredAt;
    if (typeof timestamp !== 'string') throw new Error('El reporte no contiene una fecha válida.');
    const date = new Date(timestamp);
    if (!Number.isFinite(date.getTime())) throw new Error('El reporte no contiene una fecha válida.');
    const bucket = buckets.get(localBucket(date, timezone, hourly));
    if (!bucket) continue;
    bucket.count++;
    if (monetary) {
      const amount = dataset === 'expenses' ? row.amount : row.total;
      if (typeof amount !== 'string' || typeof row.currencyCode !== 'string') {
        throw new Error('El reporte no contiene un importe o una moneda válida.');
      }
      const amounts = bucket.amounts.get(row.currencyCode) ?? [];
      amounts.push(amount);
      bucket.amounts.set(row.currencyCode, amounts);
      if (dataset === 'expenses') {
        const id = typeof row.categoryId === 'string' ? row.categoryId : 'unavailable';
        const name = typeof row.categoryName === 'string' ? row.categoryName : 'Categoría no disponible';
        const key = JSON.stringify([row.currencyCode, id]);
        const category = categories.get(key) ?? { id, name, currency: row.currencyCode, buckets: new Map<string, string[]>() };
        const label = localBucket(date, timezone, hourly);
        category.buckets.set(label, [...(category.buckets.get(label) ?? []), amount]);
        categories.set(key, category);
      }
    }
  }
  const currencies = [...new Set([...buckets.values()].flatMap(bucket => [...bucket.amounts.keys()]))].sort();
  return { labels, counts: [...buckets.values()].map(bucket => String(bucket.count)),
    categories: [...categories.values()].sort((left, right) => left.currency.localeCompare(right.currency)
      || left.name.localeCompare(right.name, 'es') || left.id.localeCompare(right.id)).map(category => ({
      id: category.id, name: category.name, currency: category.currency,
      values: labels.map(label => sumMoney(category.buckets.get(label) ?? [])),
    })),
    amounts: currencies.map(currency => ({ currency,
      values: [...buckets.values()].map(bucket => sumMoney(bucket.amounts.get(currency) ?? [])) })) };
}
