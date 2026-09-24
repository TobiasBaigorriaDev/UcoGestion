'use client';

import { useState } from 'react';
import { z } from 'zod';

import { ApiClient } from '../../lib/api/client';
import { CatalogCategoryManagement, type ManagedCategory } from '../catalog/catalog-category-management';
import styles from '../identity/management.module.css';

const categorySchema = z.object({ id: z.string(), name: z.string(), status: z.enum(['ACTIVE', 'INACTIVE']), version: z.number().int().positive() });
const client = new ApiClient();

async function csrfToken(): Promise<string> {
  const result = await client.request('/auth/csrf', { method: 'GET', parse: (value) => z.object({ csrfToken: z.string() }).parse(value) });
  if (!result) throw new Error('CSRF unavailable');
  return result.csrfToken;
}

export async function loadExpenseCategories(organizationId: string): Promise<ManagedCategory[]> {
  const result = await client.request('/expense-categories', { method: 'GET', organizationId,
    parse: (value) => z.object({ categories: z.array(categorySchema) }).parse(value) });
  if (!result) throw new Error('Empty expense categories response');
  return result.categories;
}

export async function createExpenseCategory(organizationId: string, name: string): Promise<ManagedCategory> {
  const result = await client.request('/expense-categories', { method: 'POST', organizationId,
    csrfToken: await csrfToken(), idempotencyKey: crypto.randomUUID(), body: { name },
    parse: (value) => categorySchema.parse(value) });
  if (!result) throw new Error('Empty expense category response');
  return result;
}

export async function changeExpenseCategoryStatus(organizationId: string, id: string, version: number,
  status: 'ACTIVE' | 'INACTIVE'): Promise<ManagedCategory> {
  const result = await client.request(`/expense-categories/${encodeURIComponent(id)}/status`, { method: 'PATCH', organizationId,
    csrfToken: await csrfToken(), idempotencyKey: crypto.randomUUID(), ifMatch: String(version), body: { status },
    parse: (value) => categorySchema.parse(value) });
  if (!result) throw new Error('Empty expense category response');
  return result;
}

export async function deleteExpenseCategory(organizationId: string, id: string, version: number): Promise<{ id: string; deleted: true }> {
  const result = await client.request(`/expense-categories/${encodeURIComponent(id)}`, { method: 'DELETE', organizationId,
    csrfToken: await csrfToken(), idempotencyKey: crypto.randomUUID(), ifMatch: String(version),
    parse: (value) => z.object({ id: z.string(), deleted: z.literal(true) }).parse(value) });
  if (!result) throw new Error('Empty expense category response');
  return result;
}

export function ExpenseCategoryManagement({ organizationId, categories, onReload,
  onCreate = createExpenseCategory, onChangeStatus = changeExpenseCategoryStatus, onDelete = deleteExpenseCategory,
}: {
  organizationId: string;
  categories: ManagedCategory[];
  onReload: () => void;
  onCreate?: typeof createExpenseCategory;
  onChangeStatus?: typeof changeExpenseCategoryStatus;
  onDelete?: typeof deleteExpenseCategory;
}) {
  const [selectedId, setSelectedId] = useState('');
  const active = categories.filter((category) => category.status === 'ACTIVE');
  return <div className={styles.page}>
    <CatalogCategoryManagement kind="expense" organizationId={organizationId} categories={categories}
      onReload={onReload} onCreate={onCreate} onChangeStatus={onChangeStatus} onDelete={onDelete} />
    <section className={styles.panel} aria-labelledby="expense-category-selection-heading">
      <h2 id="expense-category-selection-heading">Selección para gastos nuevos</h2>
      <label htmlFor="expense-category-active">Categoría activa para un gasto nuevo</label>
      <select id="expense-category-active" value={active.some((category) => category.id === selectedId) ? selectedId : ''}
        onChange={(event) => setSelectedId(event.target.value)}>
        <option value="">Seleccioná una categoría</option>
        {active.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
      </select>
      {active.length === 0 ? <p role="status">Activá o creá una categoría antes de registrar gastos.</p>
        : <p>Las categorías inactivas quedan visibles en el historial, pero no pueden asignarse a gastos nuevos.</p>}
    </section>
  </div>;
}
