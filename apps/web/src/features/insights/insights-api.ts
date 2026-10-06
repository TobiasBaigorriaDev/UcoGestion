import { z } from 'zod';
import { requireBusinessOnline } from '../../lib/api/online-only';

import { ApiClient } from '../../lib/api/client';

const client = new ApiClient();
const amount = z.string();
const branchIds = z.array(z.string());
const sales = z.object({ net: amount, count: z.number(), averageTicket: amount });
const session = z.object({ id: z.string(), branchId: z.string(), status: z.string(), expectedCash: amount });
const dashboardSchema = z.discriminatedUnion('role', [
  z.object({ role: z.enum(['OWNER', 'ADMIN']), branchIds, sales,
    expenses: z.object({ net: amount }), purchases: z.object({ net: amount }),
    operatingResult: z.object({ amount, label: z.string() }),
    paymentMethods: z.array(z.object({ method: z.string(), total: amount })),
    topItems: z.array(z.object({ itemId: z.string(), name: z.string(), quantity: amount, total: amount })),
    lowStock: z.array(z.object({ branchId: z.string(), itemId: z.string(), name: z.string(), quantity: amount, minimum: amount })),
    cashSessions: z.array(session.extend({ ownerUserId: z.string() })),
    cashSummary: z.array(z.object({ branchId: z.string(), status: z.string(), count: z.number(), expectedCash: amount })) }),
  z.object({ role: z.literal('CASHIER'), branchIds, sales, cashSessions: z.array(session) }),
  z.object({ role: z.literal('EMPLOYEE'), branchIds,
    catalog: z.array(z.object({ itemId: z.string(), name: z.string(), type: z.string(), status: z.string() })),
    inventory: z.array(z.object({ branchId: z.string(), itemId: z.string(), quantity: amount })) }),
]);
export type DashboardData = z.infer<typeof dashboardSchema>;
export type DashboardFilters = { branchId?: string; from?: string; to?: string };

export function startOfDayInTimezone(date: string, timezone: string): string {
  const target = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(target)) throw new Error('Invalid date');
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric',
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23' });
  let instant = target;
  for (let attempt = 0; attempt < 3; attempt++) {
    const fields = Object.fromEntries(formatter.formatToParts(new Date(instant))
      .filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]));
    const { year, month, day, hour, minute, second } = fields;
    if (year === undefined || month === undefined || day === undefined || hour === undefined ||
      minute === undefined || second === undefined) throw new Error('Invalid timezone');
    const wallTime = Date.UTC(year, month - 1, day, hour, minute, second);
    instant += target - wallTime;
  }
  return new Date(instant).toISOString();
}

export function queryString(filters: Record<string, string | undefined>): string {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(filters)) if (value) params.set(name, value);
  return params.size ? `?${params.toString()}` : '';
}

export async function loadDashboard(organizationId: string, filters: DashboardFilters): Promise<DashboardData> {
  const result = await client.request(`/dashboard${queryString(filters)}`, { method: 'GET', organizationId,
    parse: (value) => dashboardSchema.parse(value) });
  if (!result) throw new Error('Dashboard unavailable');
  return result;
}

const auditEventSchema = z.object({ id: z.string(), actorUserId: z.string(), branchId: z.string().nullable(),
  entityType: z.string(), entityId: z.string(), action: z.string(), occurredAt: z.string() });
const auditPageSchema = z.object({ items: z.array(auditEventSchema), nextCursor: z.string().nullable() });
export type AuditPage = z.infer<typeof auditPageSchema>;
export type AuditFilters = { branchId?: string; action?: string; actorUserId?: string; cursor?: string };
export async function loadAudit(organizationId: string, filters: AuditFilters): Promise<AuditPage> {
  const result = await client.request(`/audit${queryString({ ...filters, limit: '30' })}`, { method: 'GET', organizationId,
    parse: (value) => auditPageSchema.parse(value) });
  if (!result) throw new Error('Audit unavailable');
  return result;
}

export const reportDatasets = ['sales', 'inventory', 'inventory-movements', 'cash', 'purchases', 'expenses'] as const;
export type ReportDataset = typeof reportDatasets[number];
export type ReportFilters = { branchId?: string; from?: string; to?: string; status?: string; lowStock?: string; cursor?: string };
const reportPageSchema = z.object({ dataset: z.enum(reportDatasets),
  items: z.array(z.object({ id: z.string(), branchId: z.string() }).catchall(z.unknown())),
  nextCursor: z.string().nullable(), net: z.string().optional() });
export type ReportPage = z.infer<typeof reportPageSchema>;
export async function loadReport(organizationId: string, dataset: ReportDataset, filters: ReportFilters): Promise<ReportPage> {
  const result = await client.request(`/reports/${dataset}${queryString({ ...filters, limit: '30' })}`,
    { method: 'GET', organizationId, parse: (value) => reportPageSchema.parse(value) });
  if (!result) throw new Error('Report unavailable');
  return result;
}

const exportSchema = z.object({ id: z.string(), status: z.string(), url: z.string().optional(), errorCode: z.string().optional() });
export type ReportExport = z.infer<typeof exportSchema>;
export async function queueReportExport(organizationId: string, dataset: ReportDataset,
  filters: Omit<ReportFilters, 'cursor'>, key: string): Promise<ReportExport> {
  const csrf = await client.request('/auth/csrf', { method: 'GET', parse: (value) => z.object({ csrfToken: z.string() }).parse(value) });
  if (!csrf) throw new Error('CSRF unavailable');
  const body = Object.fromEntries(Object.entries(filters).filter(([, value]) => value)
    .map(([name, value]) => [name, name === 'lowStock' ? value === 'true' : value]));
  const result = await client.request(`/reports/${dataset}/exports`, { method: 'POST', organizationId,
    csrfToken: csrf.csrfToken, idempotencyKey: key, body, parse: (value) => exportSchema.parse(value) });
  if (!result) throw new Error('Export unavailable');
  return result;
}
export async function loadReportExport(organizationId: string, id: string): Promise<ReportExport> {
  const result = await client.request(`/reports/exports/${encodeURIComponent(id)}`,
    { method: 'GET', organizationId, parse: (value) => exportSchema.parse(value) });
  if (!result) throw new Error('Export unavailable');
  return result;
}

export async function downloadReportCsv(organizationId: string, dataset: ReportDataset,
  filters: Omit<ReportFilters, 'cursor'>): Promise<void> {
  requireBusinessOnline();
  const response = await fetch(`/api/v1/reports/${dataset}/csv${queryString(filters)}`, {
    credentials: 'include', cache: 'no-store', headers: { 'X-Organization-Id': organizationId, Accept: 'text/csv' },
  });
  if (!response.ok) throw new Error('No pudimos descargar el CSV. Revisá los filtros e intentá nuevamente.');
  const url = URL.createObjectURL(await response.blob());
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = `${dataset}.csv`; document.body.append(anchor); anchor.click(); anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
