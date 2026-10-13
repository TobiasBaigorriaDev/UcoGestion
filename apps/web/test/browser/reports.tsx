import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '../../../../packages/ui/src/tokens.css';
import { ReportsWorkspace } from '../../src/features/insights/reports-workspace';

const root = document.getElementById('root');
if (!root) throw new Error('Missing root');
createRoot(root).render(<QueryClientProvider client={new QueryClient()}>
  <main style={{ maxWidth: 1280, margin: '0 auto', padding: 24 }}>
    <ReportsWorkspace organizationId="preview" role="OWNER" timezone="America/Argentina/Buenos_Aires"
      branches={[{ id: 'b1', name: 'Sucursal Centro' }, { id: 'b2', name: 'Sucursal Tunuyán' }]}
      load={async (_organization, dataset, filters) => ({ dataset, net: '315000.00', nextCursor: null,
        items: Array.from({ length: 8 }, (_, index) => ({ id: `r${index}`, branchId: 'b1',
          occurredAt: `${filters.from ?? '2026-10-12'}T${String(index + 10).padStart(2, '0')}:30:00-03:00`,
          openedAt: `${filters.from ?? '2026-10-12'}T10:00:00-03:00`,
          status: index === 3 ? 'CANCELLED' : 'CONFIRMED', total: '45000.00', amount: '45000.00',
          categoryId: ['light', 'rent', 'water'][index % 3], categoryName: ['Luz', 'Alquiler', 'Agua'][index % 3],
          currencyCode: 'ARS', name: 'Yerba mate', quantity: '24.000', minimum: '5.000', lowStock: false,
          itemName: 'Yerba mate', delta: '2.000', effectKind: 'PURCHASE', expectedCash: '45000.00', difference: '0.00' })) })} />
  </main>
</QueryClientProvider>);
