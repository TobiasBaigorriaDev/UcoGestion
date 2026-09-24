'use client';

import { useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { ErrorSummary } from '../../components/error-summary';
import { ApiClient, ApiProblemError } from '../../lib/api/client';
import styles from '../identity/management.module.css';

const categorySchema = z.object({ id: z.string(), name: z.string(), status: z.enum(['ACTIVE', 'INACTIVE']), version: z.number().int().positive() });
const categoriesSchema = z.object({ categories: z.array(categorySchema) });
const nameSchema = z.object({ name: z.string().trim().min(1).max(255) });
export type ManagedCategory = z.infer<typeof categorySchema>;
const client = new ApiClient();

async function csrfToken(): Promise<string> {
  const result = await client.request('/auth/csrf', { method: 'GET', parse: (value) => z.object({ csrfToken: z.string() }).parse(value) });
  if (!result) throw new Error('CSRF unavailable');
  return result.csrfToken;
}

export async function loadManagedCategories(organizationId: string): Promise<ManagedCategory[]> {
  const result = await client.request('/catalog/categories', { method: 'GET', organizationId, parse: (value) => categoriesSchema.parse(value) });
  if (!result) throw new Error('Empty categories response');
  return result.categories;
}

export async function createCatalogCategory(organizationId: string, name: string): Promise<ManagedCategory> {
  const result = await client.request('/catalog/categories', { method: 'POST', organizationId,
    csrfToken: await csrfToken(), idempotencyKey: crypto.randomUUID(), body: { name }, parse: (value) => categorySchema.parse(value) });
  if (!result) throw new Error('Empty category response');
  return result;
}

export async function changeCatalogCategoryStatus(organizationId: string, id: string, version: number, status: 'ACTIVE' | 'INACTIVE'): Promise<ManagedCategory> {
  const result = await client.request(`/catalog/categories/${encodeURIComponent(id)}/status`, { method: 'PATCH', organizationId,
    csrfToken: await csrfToken(), ifMatch: String(version), idempotencyKey: crypto.randomUUID(), body: { status }, parse: (value) => categorySchema.parse(value) });
  if (!result) throw new Error('Empty category response');
  return result;
}

export async function deleteCatalogCategory(organizationId: string, id: string, version: number): Promise<{ id: string; deleted: true }> {
  const result = await client.request(`/catalog/categories/${encodeURIComponent(id)}`, { method: 'DELETE', organizationId,
    csrfToken: await csrfToken(), ifMatch: String(version), idempotencyKey: crypto.randomUUID(),
    parse: (value) => z.object({ id: z.string(), deleted: z.literal(true) }).parse(value) });
  if (!result) throw new Error('Empty category response');
  return result;
}

function explainError(cause: unknown): ApiProblemError {
  if (cause instanceof ApiProblemError) {
    const message = cause.code === 'CATEGORY_DELETE_BLOCKED_BY_HISTORY'
      ? 'Esta categoría tiene historial confirmado. Podés desactivarla, pero no eliminarla.'
      : cause.code === 'CATEGORY_DELETE_BLOCKED_BY_OFFLINE_EXPOSURE' || cause.code === 'CATEGORY_DELETE_BARRIER_NOT_INTEGRATED'
        ? 'Esta categoría pudo estar en operaciones offline pendientes. Sincronizá los dispositivos y confirmá el checkpoint; mientras tanto podés desactivarla.'
        : cause.code === 'VERSION_CONFLICT'
          ? 'La categoría cambió desde que la cargaste. Volvé a cargarla antes de intentar nuevamente.'
          : cause.message;
    return new ApiProblemError({ status: cause.status, code: cause.code, message, traceId: cause.traceId });
  }
  return new ApiProblemError({ status: 0, code: 'REQUEST_FAILED', message: 'No pudimos completar la operación. Intentá nuevamente.' });
}

export function CatalogCategoryManagement({ organizationId, categories, onReload,
  onCreate = createCatalogCategory, onChangeStatus = changeCatalogCategoryStatus, onDelete = deleteCatalogCategory, kind = 'catalog',
}: {
  organizationId: string;
  categories: ManagedCategory[];
  onReload: () => void;
  onCreate?: typeof createCatalogCategory;
  onChangeStatus?: typeof changeCatalogCategoryStatus;
  onDelete?: typeof deleteCatalogCategory;
  kind?: 'catalog' | 'expense';
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiProblemError | null>(null);
  const [message, setMessage] = useState('');
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const { register, handleSubmit, reset, formState: { errors } } = useForm<z.infer<typeof nameSchema>>({
    resolver: zodResolver(nameSchema), defaultValues: { name: '' },
  });
  async function perform(operation: () => Promise<unknown>, success: string) {
    setError(null); setMessage(''); setBusy(true);
    try { await operation(); setMessage(success); setConfirmId(null); onReload(); }
    catch (cause) { setError(explainError(cause)); }
    finally { setBusy(false); }
  }
  const expense = kind === 'expense';
  return <section className={styles.page} aria-labelledby="category-heading">
    <header className={styles.heading}><h1 id="category-heading">{expense ? 'Categorías de gasto' : 'Categorías de catálogo'}</h1><p>{expense ? 'Clasificá los gastos. Solo las categorías activas pueden usarse en gastos nuevos.' : 'Organizá productos y servicios. Una categoría es opcional para cada ítem.'}</p></header>
    <ErrorSummary error={error} />
    {message ? <p role="status">{message}</p> : null}
    <form className={styles.panel} onSubmit={handleSubmit(({ name }) => perform(async () => {
      await onCreate(organizationId, name.trim()); reset();
    }, 'Categoría creada.'))} noValidate>
      <h2>Nueva categoría</h2>
      <label htmlFor="category-name">Nombre de la categoría</label>
      <input id="category-name" aria-invalid={!!errors.name} {...register('name')} />
      {errors.name ? <p role="alert">Ingresá un nombre de hasta 255 caracteres.</p> : null}
      <button type="submit" disabled={busy}>{busy ? 'Guardando…' : 'Crear categoría'}</button>
    </form>
    <section className={styles.panel} aria-labelledby="category-list-heading">
      <h2 id="category-list-heading">Categorías de la organización</h2>
      {categories.length === 0 ? <p>No hay categorías. Podés crear una arriba.</p> : <ul className={styles.rows}>{categories.map((category) => <li className={styles.row} key={category.id}>
        <div className={styles.memberTitle}><strong>{category.name}</strong><span>{category.status === 'ACTIVE' ? 'Activa' : 'Inactiva'}</span></div>
        <div className={styles.actions}>
          <button type="button" disabled={busy} onClick={() => void perform(() => onChangeStatus(organizationId, category.id, category.version, category.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE'), category.status === 'ACTIVE' ? 'Categoría desactivada.' : 'Categoría activada.')}>
            {category.status === 'ACTIVE' ? `Desactivar ${category.name}` : `Activar ${category.name}`}
          </button>
          <button type="button" disabled={busy} onClick={() => setConfirmId(category.id)}>Eliminar {category.name}</button>
        </div>
        {confirmId === category.id ? <div className={styles.actions} role="group" aria-label={`Confirmar eliminación de ${category.name}`}>
          <p>La eliminación es definitiva y solo se permite sin historial ni operaciones offline pendientes.</p>
          <button type="button" disabled={busy} onClick={() => void perform(() => onDelete(organizationId, category.id, category.version), 'Categoría eliminada.')}>Confirmar eliminación de {category.name}</button>
          <button type="button" disabled={busy} onClick={() => setConfirmId(null)}>Cancelar</button>
        </div> : null}
      </li>)}</ul>}
    </section>
  </section>;
}
