import React from 'react';
import { createRoot } from 'react-dom/client';
import '../../../../packages/ui/src/tokens.css';
import { OnlineOnlyBoundary } from '../../src/offline/online-only-boundary';
import { ApiClient } from '../../src/lib/api/client';
import { downloadReportCsv } from '../../src/features/insights/insights-api';

const root = document.getElementById('root');
if (!root) throw new Error('Root missing');
createRoot(root).render(<OnlineOnlyBoundary><main><h1>Administración</h1>
  <form aria-label="Compra"><label>Proveedor<input name="supplier" /></label><button type="button">Confirmar compra</button></form>
  <p>Reporte privado ya cargado</p></main></OnlineOnlyBoundary>);
const client = new ApiClient();
const harness = { async restrictedRequests() {
  const failures: string[] = [];
  for (const [path, method] of [['/organizations/settings', 'PATCH'], ['/users/invitations', 'POST'], ['/users/memberships/id', 'PATCH'],
    ['/suppliers', 'POST'], ['/purchases', 'POST'], ['/expenses', 'POST'],
    ['/inventory/adjustments', 'POST'], ['/sales/id/cancel', 'POST'], ['/cash-sessions/id/close', 'POST'],
    ['/reports/sales', 'GET'], ['/inventory/transfers', 'POST'], ['/catalog/items', 'POST'], ['/branches', 'POST'],
    ['/branches/id/cash-registers', 'POST'], ['/organizations/payment-methods/CASH', 'PATCH'], ['/customers/id', 'DELETE'],
    ['/catalog/categories', 'POST'], ['/catalog/categories/id', 'PATCH'], ['/catalog/categories/id/status', 'PATCH'],
    ['/catalog/categories/id', 'DELETE'], ['/catalog/items/id', 'PATCH'], ['/catalog/items/id/status', 'PATCH'],
    ['/catalog/items/id/structure', 'PATCH'], ['/catalog/items/id', 'DELETE']] as const) {
    try { await client.request(path, { method }); } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'OFFLINE_NOT_ALLOWED') failures.push(path);
    }
  }
  try { await downloadReportCsv('11111111-1111-4111-8111-111111111111', 'sales', {}); }
  catch (error) { if (error instanceof Error && 'code' in error && error.code === 'OFFLINE_NOT_ALLOWED') failures.push('csv'); }
  return failures;
} };
Object.assign(window, { restrictionsHarness: harness });
