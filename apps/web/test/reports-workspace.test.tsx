import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import axe from 'axe-core';

import { ReportsWorkspace } from '../src/features/insights/reports-workspace';

afterEach(cleanup);
describe('reportes por rol', () => {
  it('ofrece solo datasets autorizados y permite filtrar', async () => {
    const load = vi.fn().mockResolvedValue({ dataset: 'inventory', items: [], nextCursor: null });
    const { container } = render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ReportsWorkspace organizationId="o1" role="EMPLOYEE" timezone="America/Argentina/Buenos_Aires" branches={[]} load={load} />
    </QueryClientProvider>);
    expect(await screen.findByText('Sin registros para los filtros elegidos.')).toBeDefined();
    expect(screen.queryByRole('option', { name: 'Ventas' })).toBeNull();
    await userEvent.selectOptions(screen.getByLabelText('Dataset'), 'inventory-movements');
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
    expect(queueExport).toHaveBeenCalledWith('o1', 'sales', {}, expect.any(String));
    expect(loadExport).toHaveBeenCalledWith('o1', 'export-1');
  });
});
