'use client';

import { useState } from 'react';
import { z } from 'zod';
import { categoryIconSchema } from '@uconext/shared';

import { ErrorSummary } from '../../components/error-summary';
import { ApiClient, ApiProblemError } from '../../lib/api/client';
import styles from '../identity/management.module.css';
import catalogStyles from './catalog-read.module.css';
import { CatalogSearch, filterCatalogItems } from './components/catalog-search';
import { CatalogSort, sortCatalogItems, type CatalogOrder } from './components/catalog-sort';
import { CatalogGrouping, CatalogProductList } from './components/catalog-product-list';
import { CategoryIcon } from './components/category-icon';
import { CatalogStockSummary } from './catalog-stock-summary';
import { CatalogProductStockActions } from './catalog-product-stock-actions';
import productStyles from './catalog-item-management.module.css';
import type { StockItem } from '../inventory/inventory-api';

const itemSchema = z.object({ id: z.string(), name: z.string(), type: z.enum(['PRODUCT', 'SERVICE']), status: z.enum(['ACTIVE', 'INACTIVE']), trackInventory: z.boolean(), baseUnit: z.enum(['UNIT', 'FRACTIONAL']), price: z.string().nullable(), priceVersion: z.number().int(), sku: z.string().nullable(), barcode: z.string().nullable(), categoryId: z.string().nullable().optional() });
const catalogSchema = z.object({ items: z.array(itemSchema), categories: z.array(z.object({ id: z.string(), name: z.string(), icon: categoryIconSchema.optional() })) });
export type CatalogReadData = z.infer<typeof catalogSchema>;
const client = new ApiClient();

export async function loadCatalog(organizationId: string, branchId?: string): Promise<CatalogReadData> {
  const path = branchId ? `/catalog/items?mode=HISTORICAL&branchId=${encodeURIComponent(branchId)}` : '/catalog/items';
  const result = await client.request(path, { method: 'GET', organizationId, parse: (value) => catalogSchema.parse(value) });
  if (!result) throw new Error('Empty response');
  return result;
}

export function CatalogReadView({ role, data, branchId, branchName, stocks, stockFailed = false, organizationId, onReload, loadHistory }: {
  organizationId?: string;
  onReload?: () => void;
  role: 'OWNER' | 'ADMIN' | 'CASHIER' | 'EMPLOYEE';
  data: CatalogReadData;
  branchId?: string | null;
  branchName?: string | undefined;
  stocks?: readonly StockItem[] | undefined;
  stockFailed?: boolean;
  loadHistory: (branchId: string) => Promise<CatalogReadData>;
}) {
  const [historical, setHistorical] = useState<CatalogReadData | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiProblemError | null>(null);
  const [query, setQuery] = useState('');
  const [order, setOrder] = useState<CatalogOrder>('name-asc');
  const [grouped, setGrouped] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const items = (historical ?? data).items;
  const normalizedQuery = query.trim();
  const visible = sortCatalogItems(filterCatalogItems(items, query), order, !stockFailed && branchName ? stocks : undefined);
  async function showHistorical() {
    if (!branchId) return;
    setBusy(true); setError(null);
    try { setHistorical(await loadHistory(branchId)); }
    catch (cause) { setError(cause instanceof ApiProblemError ? cause : new ApiProblemError({ status: 0, code: 'CATALOG_LOAD_FAILED', message: 'No pudimos cargar los ítems inactivos. Intentá nuevamente.' })); }
    finally { setBusy(false); }
  }
  return <section className={styles.page} aria-labelledby="catalog-heading">
    <header className={styles.heading}><h1 id="catalog-heading">Catálogo</h1><p>Consultá ítems, precios vigentes y categorías.</p></header>
    {role === 'OWNER' || role === 'ADMIN' ? <nav className={catalogStyles.managementActions} aria-label="Administración del catálogo">
      <a className="uco-button uco-button--primary" href="/workspace/catalog/items">Administrar ítems</a>
      <a className="uco-button uco-button--secondary" href="/workspace/catalog/categories">Administrar categorías de catálogo</a>
    </nav> : null}
    <ErrorSummary error={error} />
    <div className={styles.panel}>
      <CatalogSearch query={query} onQueryChange={setQuery} total={items.length} matched={visible.length} />
      <CatalogSort value={order} onChange={setOrder} />
      <CatalogGrouping checked={grouped} onChange={setGrouped} />
      {role === 'EMPLOYEE' && branchId ? <button type="button" disabled={busy} onClick={() => void (historical ? setHistorical(null) : showHistorical())}>{historical ? 'Volver a ítems activos' : busy ? 'Cargando…' : 'Ver ítems inactivos de esta sucursal'}</button> : null}
      {historical ? <p role="status">Contexto histórico de la sucursal seleccionada. Los ítems inactivos no están disponibles para venta.</p> : null}
      {visible.length === 0 ? <p>{normalizedQuery && items.length ? 'No encontramos ítems con esa búsqueda. Probá con otro nombre, SKU o código de barras.' : 'No hay ítems para mostrar.'}</p> : <CatalogProductList items={visible} categories={(historical ?? data).categories} grouped={grouped} renderItem={item => <li className={styles.row} key={item.id}>
        <details className={productStyles.productDetails} open={expanded[item.id] ?? false}
          onToggle={event => { const open = event.currentTarget.open; setExpanded(current => ({ ...current, [item.id]: open })); }}>
          <summary className={productStyles.productSummary}>
            <strong>{item.name}</strong>
            <span>{item.price === null ? 'Sin precio vigente' : <>Precio vigente: <strong>{item.price}</strong></>}</span>
            <CatalogStockSummary item={item} branchName={branchName} stocks={stocks} failed={stockFailed} />
          <svg className={productStyles.expandIcon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m9 5 7 7-7 7" /></svg>
                  </summary>
          {expanded[item.id] ? <div className={productStyles.detailBody}>
            <p>{item.status === 'INACTIVE' ? 'Inactivo · solo consulta' : item.type === 'SERVICE' ? 'Servicio' : 'Producto'} · {item.baseUnit === 'UNIT' ? 'Unidad' : 'Fraccionable'}</p>
            {item.sku ? <p>SKU: {item.sku}</p> : null}
            {item.barcode ? <p>Código de barras: {item.barcode}</p> : null}
            {organizationId && onReload && item.status === 'ACTIVE' && item.trackInventory && !stockFailed ? stocks?.filter(stock => stock.itemId === item.id).map(stock =>
              <CatalogProductStockActions key={stock.itemId} organizationId={organizationId} role={role} stock={stock} onReload={onReload} />) : null}
          </div> : null}
        </details>
      </li>} />}
    </div>
    <section className={styles.panel} aria-label="Categorías"><h2>Categorías</h2>{data.categories.length ? <ul>{data.categories.map((category) => <li key={category.id}><CategoryIcon icon={category.icon} /> {category.name}</li>)}</ul> : <p>No hay categorías activas.</p>}</section>
  </section>;
}
