import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import axe from 'axe-core';

import { ReportsWorkspace } from '../src/features/insights/reports-workspace';
import type { ReportDataset, ReportFilters } from '../src/features/insights/insights-api';

afterEach(cleanup);
describe('reportes por rol', () => {
  it('muestra categorías de gastos juntas en un gráfico con colores y valores accesibles', async () => {
    const load = vi.fn().mockResolvedValue({ dataset: 'expenses', items: [
      { id: 'e1', branchId: 'b', occurredAt: '2026-10-12T13:00:00Z', categoryId: 'light', categoryName: 'Luz', amount: '1500.00', currencyCode: 'ARS', status: 'CONFIRMED' },
      { id: 'e2', branchId: 'b', occurredAt: '2026-10-12T14:00:00Z', categoryId: 'rent', categoryName: 'Alquiler', amount: '3000.00', currencyCode: 'ARS', status: 'CONFIRMED' },
    ], nextCursor: null });
    const { container } = render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ReportsWorkspace organizationId="o1" role="OWNER" timezone="UTC" branches={[]} load={load} now={new Date('2026-10-12T15:00:00Z')} />
    </QueryClientProvider>);
    await userEvent.selectOptions(screen.getByLabelText('Tipo de reporte'), 'expenses');
    const chart = await screen.findByRole('region', { name: 'Gastos por categoría · ARS' });
    expect(chart.querySelectorAll('polyline')).toHaveLength(2);
    const lines = [...chart.querySelectorAll('polyline')];
    expect(lines[0]?.getAttribute('stroke')).not.toBe(lines[1]?.getAttribute('stroke'));
    const legend = within(chart).getByRole('list', { name: 'Categorías del gráfico' });
    expect(within(legend).getByText('Luz')).toBeDefined();
    expect(within(legend).getByText('Alquiler')).toBeDefined();
    await userEvent.click(within(chart).getByText('Ver valores por hora'));
    expect(within(chart).getByRole('columnheader', { name: 'Luz' })).toBeDefined();
    expect(within(chart).getByText('1.500,00 ARS')).toBeDefined();
    expect(within(chart).getByText('3.000,00 ARS')).toBeDefined();
    expect((await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })).violations).toEqual([]);
  });
  it('ofrece solo datasets autorizados y permite filtrar', async () => {
    const load = vi.fn().mockResolvedValue({ dataset: 'inventory', items: [], nextCursor: null });
    const { container } = render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ReportsWorkspace organizationId="o1" role="EMPLOYEE" timezone="America/Argentina/Buenos_Aires" branches={[]} load={load} />
    </QueryClientProvider>);
    expect(await screen.findByText('Sin registros para los filtros elegidos.')).toBeDefined();
    expect(screen.queryByRole('option', { name: 'Ventas' })).toBeNull();
    await userEvent.selectOptions(screen.getByLabelText('Tipo de reporte'), 'inventory-movements');
    expect(load).toHaveBeenCalledWith('o1', 'inventory-movements', expect.any(Object));
    expect((await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })).violations).toEqual([]);
  });

  it('anuncia el estado de una exportación PDF y ofrece su descarga al estar lista', async () => {
    const queueExport = vi.fn().mockResolvedValue({ id: 'export-1', status: 'QUEUED' });
    const loadExport = vi.fn().mockResolvedValue({ id: 'export-1', status: 'READY', url: 'https://example.test/file.pdf' });
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ReportsWorkspace organizationId="o1" role="OWNER" timezone="America/Argentina/Buenos_Aires" branches={[]}
        load={vi.fn().mockResolvedValue({ dataset: 'sales', items: [], nextCursor: null })}
        queueExport={queueExport} loadExport={loadExport} />
    </QueryClientProvider>);
    await screen.findByText('Sin registros para los filtros elegidos.');
    await userEvent.click(screen.getByRole('button', { name: 'Generar PDF' }));
    expect(await screen.findByRole('link', { name: 'Descargar PDF listo' })).toHaveProperty('href', 'https://example.test/file.pdf');
    expect(queueExport).toHaveBeenCalledWith('o1', 'sales', expect.objectContaining({ from: expect.any(String), to: expect.any(String) }), expect.any(String));
    expect(loadExport).toHaveBeenCalledWith('o1', 'export-1');
  });

  it('aplica presets locales y fechas personalizadas inclusivas a lectura y exportación', async () => {
    const load = vi.fn().mockResolvedValue({ dataset: 'sales', items: [], nextCursor: null });
    const downloadCsv = vi.fn().mockResolvedValue(undefined);
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ReportsWorkspace organizationId="o1" role="OWNER" timezone="America/Argentina/Buenos_Aires"
        branches={[]} load={load} downloadCsv={downloadCsv} now={new Date('2026-10-12T01:00:00Z')} />
    </QueryClientProvider>);
    await screen.findByText('Sin registros para los filtros elegidos.');
    expect(load).toHaveBeenCalledWith('o1', 'sales', { from: '2026-10-11', to: '2026-10-12' });
    await userEvent.click(screen.getByRole('button', { name: 'Esta semana' }));
    expect(load).toHaveBeenCalledWith('o1', 'sales', { from: '2026-10-05', to: '2026-10-12' });
    await userEvent.click(screen.getByRole('button', { name: 'Este mes' }));
    expect(load).toHaveBeenCalledWith('o1', 'sales', { from: '2026-10-01', to: '2026-11-01' });
    await userEvent.click(screen.getByRole('button', { name: 'Personalizado' }));
    await userEvent.clear(screen.getByLabelText('Desde'));
    await userEvent.type(screen.getByLabelText('Desde'), '2026-09-01');
    await userEvent.clear(screen.getByLabelText('Hasta'));
    await userEvent.type(screen.getByLabelText('Hasta'), '2026-09-01');
    await userEvent.click(screen.getByRole('button', { name: 'Aplicar filtros' }));
    await userEvent.click(screen.getByRole('button', { name: 'Descargar CSV' }));
    expect(downloadCsv).toHaveBeenCalledWith('o1', 'sales', { from: '2026-09-01', to: '2026-09-02' });
  });

  it('grafica todas las páginas, excluye anuladas y expone valores por hora accesibles', async () => {
    const load = vi.fn(async (_org: string, _dataset: ReportDataset, filters: ReportFilters) => ({ dataset: 'sales' as const,
      items: filters.cursor ? [{ id: 's2', branchId: 'b', occurredAt: '2026-10-12T13:00:00Z', total: '0.20', currencyCode: 'ARS', status: 'CONFIRMED' }]
        : [{ id: 's1', branchId: 'b', occurredAt: '2026-10-12T13:00:00Z', total: '0.10', currencyCode: 'ARS', status: 'CONFIRMED' },
          { id: 's3', branchId: 'b', occurredAt: '2026-10-12T13:00:00Z', total: '999.00', currencyCode: 'ARS', status: 'CANCELLED' }],
      nextCursor: filters.cursor ? null : 'next' }));
    const { container } = render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ReportsWorkspace organizationId="o1" role="OWNER" timezone="America/Argentina/Buenos_Aires"
        branches={[{ id: 'b', name: 'Centro' }]} load={load} now={new Date('2026-10-12T15:00:00Z')} />
    </QueryClientProvider>);
    const chart = await screen.findByRole('region', { name: 'Importe neto · ARS' });
    expect(within(chart).getByText('0,30 ARS')).toBeDefined();
    expect(within(chart).queryByText('999,00 ARS')).toBeNull();
    expect(container.querySelectorAll('svg polyline')).toHaveLength(2);
    expect(within(chart).getAllByRole('row', { hidden: true })).toHaveLength(14);
    expect((await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })).violations).toEqual([]);
  });

  it('conserva el listado cuando falla una página de gráficos y permite reintentar', async () => {
    let fail = true;
    const load = vi.fn(async (_org: string, _dataset: ReportDataset, filters: ReportFilters) => {
      if (filters.cursor && fail) throw new Error('No pudimos cargar el período completo.');
      return { dataset: 'sales' as const, items: [{ id: filters.cursor ? 's2' : 's1', branchId: 'b',
        occurredAt: '2026-10-12T13:00:00Z', total: '1.00', currencyCode: 'ARS', status: 'CONFIRMED' }],
        nextCursor: filters.cursor ? null : 'next' };
    });
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ReportsWorkspace organizationId="o1" role="CASHIER" timezone="UTC" branches={[{ id: 'b', name: 'Centro' }]}
        load={load} now={new Date('2026-10-12T15:00:00Z')} />
    </QueryClientProvider>);
    await screen.findByText('No pudimos cargar el período completo.');
    expect(screen.getByRole('table')).toBeDefined();
    expect(screen.queryByRole('region', { name: 'Importe neto · ARS' })).toBeNull();
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: 'Reintentar gráficos' }));
    expect(await screen.findByRole('region', { name: 'Importe neto · ARS' })).toBeDefined();
  });
});
