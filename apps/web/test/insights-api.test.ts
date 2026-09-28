import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadReport, queueReportExport, startOfDayInTimezone } from '../src/features/insights/insights-api';

afterEach(() => vi.unstubAllGlobals());
describe('contratos de reportes', () => {
  it('interpreta el inicio del día en la zona horaria de la organización', () => {
    expect(startOfDayInTimezone('2026-01-01', 'America/Argentina/Buenos_Aires'))
      .toBe('2026-01-01T03:00:00.000Z');
  });
  it('envía el scope y los filtros del dataset autorizado', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ dataset: 'sales', items: [], nextCursor: null, net: '0.00' }),
      { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetcher);
    await loadReport('org-1', 'sales', { branchId: 'branch-1', from: '2026-01-01', to: '2026-02-01' });
    const [url, options] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/reports/sales?');
    expect(url).toContain('from=2026-01-01');
    expect(options.headers).toBeInstanceOf(Headers);
    expect((options.headers as Headers).get('X-Organization-Id')).toBe('org-1');
  });

  it('solicita PDF con CSRF, idempotencia y lowStock booleano', async () => {
    const json = (value: unknown) => new Response(JSON.stringify(value),
      { status: 200, headers: { 'content-type': 'application/json' } });
    const fetcher = vi.fn().mockResolvedValueOnce(json({ csrfToken: 'csrf' }))
      .mockResolvedValueOnce(json({ id: 'export-1', status: 'QUEUED' }));
    vi.stubGlobal('fetch', fetcher);
    await queueReportExport('org-1', 'inventory', { lowStock: 'false' }, 'key-1');
    const [url, options] = fetcher.mock.calls[1] as [string, RequestInit];
    expect(url).toBe('/api/v1/reports/inventory/exports');
    expect((options.headers as Headers).get('Idempotency-Key')).toBe('key-1');
    expect((options.headers as Headers).get('X-CSRF-Token')).toBe('csrf');
    expect(JSON.parse(options.body as string)).toEqual({ lowStock: false });
  });
});
