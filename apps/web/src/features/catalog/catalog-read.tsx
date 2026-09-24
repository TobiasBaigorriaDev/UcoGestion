'use client';

import { useState } from 'react';
import { z } from 'zod';

import { ErrorSummary } from '../../components/error-summary';
import { ApiClient, ApiProblemError } from '../../lib/api/client';
import styles from '../identity/management.module.css';

const itemSchema = z.object({ id: z.string(), name: z.string(), type: z.enum(['PRODUCT', 'SERVICE']), status: z.enum(['ACTIVE', 'INACTIVE']), baseUnit: z.enum(['UNIT', 'FRACTIONAL']), price: z.string().nullable(), priceVersion: z.number().int(), sku: z.string().nullable(), barcode: z.string().nullable() });
const catalogSchema = z.object({ items: z.array(itemSchema), categories: z.array(z.object({ id: z.string(), name: z.string() })) });
export type CatalogReadData = z.infer<typeof catalogSchema>;
const client = new ApiClient();

export async function loadCatalog(organizationId: string, branchId?: string): Promise<CatalogReadData> {
  const path = branchId ? `/catalog/items?mode=HISTORICAL&branchId=${encodeURIComponent(branchId)}` : '/catalog/items';
  const result = await client.request(path, { method: 'GET', organizationId, parse: (value) => catalogSchema.parse(value) });
  if (!result) throw new Error('Empty response');
  return result;
}

export function CatalogReadView({ role, data, branchId, loadHistory }: {
  role: 'OWNER' | 'ADMIN' | 'CASHIER' | 'EMPLOYEE';
  data: CatalogReadData;
  branchId?: string | null;
  loadHistory: (branchId: string) => Promise<CatalogReadData>;
}) {
  const [historical, setHistorical] = useState<CatalogReadData | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiProblemError | null>(null);
  const [query, setQuery] = useState('');
  const visible = (historical ?? data).items.filter((item) => item.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()) || item.sku?.toLocaleLowerCase().includes(query.toLocaleLowerCase()) || item.barcode?.includes(query));
  async function showHistorical() {
    if (!branchId) return;
    setBusy(true); setError(null);
    try { setHistorical(await loadHistory(branchId)); }
    catch (cause) { setError(cause instanceof ApiProblemError ? cause : new ApiProblemError({ status: 0, code: 'CATALOG_LOAD_FAILED', message: 'No pudimos cargar los ítems inactivos. Intentá nuevamente.' })); }
    finally { setBusy(false); }
  }
  return <section className={styles.page} aria-labelledby="catalog-heading">
    <header className={styles.heading}><h1 id="catalog-heading">Catálogo</h1><p>Consultá ítems, precios vigentes y categorías.</p></header>
    {role === 'OWNER' || role === 'ADMIN' ? <p><a href="/workspace/catalog/items">Administrar ítems</a> · <a href="/workspace/catalog/categories">Administrar categorías de catálogo</a></p> : null}
    <ErrorSummary error={error} />
    <div className={styles.panel}>
      <label htmlFor="catalog-search">Buscar por nombre, SKU o código de barras</label>
      <input id="catalog-search" type="search" value={query} onChange={(event) => setQuery(event.target.value)} />
      {role === 'EMPLOYEE' && branchId ? <button type="button" disabled={busy} onClick={() => void (historical ? setHistorical(null) : showHistorical())}>{historical ? 'Volver a ítems activos' : busy ? 'Cargando…' : 'Ver ítems inactivos de esta sucursal'}</button> : null}
      {historical ? <p role="status">Contexto histórico de la sucursal seleccionada. Los ítems inactivos no están disponibles para venta.</p> : null}
      {visible.length === 0 ? <p>No hay ítems para mostrar.</p> : <ul className={styles.rows}>{visible.map((item) => <li className={styles.row} key={item.id}><div className={styles.memberTitle}><strong>{item.name}</strong><span>{item.status === 'INACTIVE' ? 'Inactivo · solo consulta' : item.type === 'SERVICE' ? 'Servicio' : 'Producto'}</span></div><div>{item.price === null ? 'Sin precio vigente' : <><span>Precio vigente: </span><strong>{item.price}</strong></>}</div>{item.sku ? <p>SKU: {item.sku}</p> : null}</li>)}</ul>}
    </div>
    <section className={styles.panel} aria-label="Categorías"><h2>Categorías</h2>{data.categories.length ? <ul>{data.categories.map((category) => <li key={category.id}>{category.name}</li>)}</ul> : <p>No hay categorías activas.</p>}</section>
  </section>;
}
