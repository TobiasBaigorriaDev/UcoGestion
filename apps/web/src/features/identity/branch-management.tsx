'use client';

import { useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { ErrorSummary } from '../../components/error-summary';
import { ApiClient, ApiProblemError } from '../../lib/api/client';
import styles from './management.module.css';

const branchSchema = z.object({ id: z.string(), name: z.string(), status: z.enum(['ACTIVE', 'INACTIVE']), version: z.number().int() });
const dataSchema = z.object({ actorRole: z.enum(['OWNER', 'ADMIN', 'CASHIER', 'EMPLOYEE']), branches: z.array(branchSchema) });
const createSchema = z.object({ name: z.string().trim().min(1).max(255) });
export type BranchManagementData = z.infer<typeof dataSchema>;
const client = new ApiClient();

export async function loadBranches(organizationId: string): Promise<BranchManagementData> {
  const result = await client.request('/branches', { method: 'GET', organizationId, parse: (value) => dataSchema.parse(value) });
  if (!result) throw new Error('Empty branch response');
  return result;
}
export async function createBranch(organizationId: string, name: string) {
  const csrf = await client.request('/auth/csrf', { method: 'GET', parse: (value) => z.object({ csrfToken: z.string() }).parse(value) });
  if (!csrf) throw new Error('CSRF unavailable');
  const result = await client.request('/branches', { method: 'POST', organizationId, csrfToken: csrf.csrfToken, idempotencyKey: crypto.randomUUID(), body: { name }, parse: (value) => branchSchema.parse(value) });
  if (!result) throw new Error('Empty branch response');
  return result;
}

export function BranchManagement({ organizationId, data, onCreate = createBranch, onReload }: {
  organizationId: string; data: BranchManagementData; onCreate?: typeof createBranch; onReload: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiProblemError | null>(null);
  const [message, setMessage] = useState('');
  const { register, handleSubmit, reset, formState: { errors } } = useForm<z.infer<typeof createSchema>>({ resolver: zodResolver(createSchema), defaultValues: { name: '' } });
  async function submit({ name }: { name: string }) {
    setError(null); setMessage(''); setBusy(true);
    try {
      const created = await onCreate(organizationId, name.trim());
      setMessage(`Sucursal ${created.name} creada. Ya podés seleccionarla en el encabezado.`);
      reset(); onReload();
    } catch (cause) {
      setError(cause instanceof ApiProblemError ? cause : new ApiProblemError({ status: 0, code: 'REQUEST_FAILED', message: 'No pudimos crear la sucursal. Intentá nuevamente.' }));
    } finally { setBusy(false); }
  }
  return <section className={styles.page} aria-labelledby="branches-heading">
    <header className={styles.heading}><h1 id="branches-heading">Sucursales</h1><p>Consultá las sucursales disponibles en tu alcance de trabajo.</p></header>
    <ErrorSummary error={error} />
    {message ? <p role="status">{message}</p> : null}
    {data.actorRole === 'OWNER' ? <form className={styles.panel} onSubmit={handleSubmit(submit)} noValidate>
      <h2>Agregar sucursal</h2><label htmlFor="branch-name">Nombre de la sucursal</label><div className={styles.fields}><div><input id="branch-name" aria-invalid={!!errors.name} {...register('name')} />{errors.name ? <p role="alert">Ingresá un nombre de hasta 255 caracteres.</p> : null}</div></div>
      <button type="submit" disabled={busy}>{busy ? 'Creando…' : 'Crear sucursal'}</button>
    </form> : null}
    <section className={styles.panel} aria-labelledby="branch-list-heading"><h2 id="branch-list-heading">Sucursales disponibles</h2>
      {data.branches.length === 0 ? <p>No hay sucursales disponibles para tu usuario.</p> : <ul className={styles.rows}>{data.branches.map((branch) => <li className={styles.row} key={branch.id}><strong>{branch.name}</strong><span>{branch.status === 'ACTIVE' ? 'Activa' : 'Inactiva'}</span></li>)}</ul>}
    </section>
  </section>;
}
