'use client';

import { useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { ErrorSummary } from '../../components/error-summary';
import { ApiClient, ApiProblemError } from '../../lib/api/client';
import styles from '../identity/management.module.css';

export interface ManagedCustomer {
  readonly id: string;
  readonly name: string;
  readonly taxId: string | null;
  readonly contact: string | null;
  readonly address: string | null;
  readonly notes: string | null;
  readonly status: 'ACTIVE' | 'INACTIVE';
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

const customerSchema = z.object({
  id: z.string(),
  name: z.string(),
  taxId: z.string().nullable(),
  contact: z.string().nullable(),
  address: z.string().nullable(),
  notes: z.string().nullable(),
  status: z.enum(['ACTIVE', 'INACTIVE']),
  version: z.number().int().positive(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const listResponseSchema = z.object({
  items: z.array(customerSchema),
  nextCursor: z.string().nullable(),
});

const formSchema = z.object({
  name: z.string().trim().min(1, 'El nombre es obligatorio.').max(255),
  taxId: z.string().trim().max(64),
  contact: z.string().trim().max(1000),
  address: z.string().trim().max(1000),
  notes: z.string().trim().max(1000),
});

type FormValues = z.infer<typeof formSchema>;
export type Role = 'OWNER' | 'ADMIN' | 'CASHIER' | 'EMPLOYEE';

const client = new ApiClient();

async function csrfToken(): Promise<string> {
  const result = await client.request('/auth/csrf', {
    method: 'GET',
    parse: (value) => z.object({ csrfToken: z.string() }).parse(value),
  });
  if (!result) throw new Error('CSRF unavailable');
  return result.csrfToken;
}

export async function loadCustomers(organizationId: string, search?: string): Promise<ManagedCustomer[]> {
  const query = search ? `?search=${encodeURIComponent(search)}` : '';
  const result = await client.request(`/customers${query}`, {
    method: 'GET',
    organizationId,
    parse: (value) => listResponseSchema.parse(value),
  });
  return result?.items ?? [];
}

export async function createCustomer(
  organizationId: string,
  input: { name: string; taxId?: string | null; contact?: string | null; address?: string | null; notes?: string | null },
): Promise<ManagedCustomer> {
  const result = await client.request('/customers', {
    method: 'POST',
    organizationId,
    csrfToken: await csrfToken(),
    idempotencyKey: crypto.randomUUID(),
    body: input,
    parse: (value) => customerSchema.parse(value),
  });
  if (!result) throw new Error('Empty customer response');
  return result;
}

export async function editCustomer(
  organizationId: string,
  id: string,
  version: number,
  input: { name?: string; taxId?: string | null; contact?: string | null; address?: string | null; notes?: string | null },
): Promise<ManagedCustomer> {
  const result = await client.request(`/customers/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    organizationId,
    csrfToken: await csrfToken(),
    idempotencyKey: crypto.randomUUID(),
    ifMatch: String(version),
    body: input,
    parse: (value) => customerSchema.parse(value),
  });
  if (!result) throw new Error('Empty customer response');
  return result;
}

export async function changeCustomerStatus(
  organizationId: string,
  id: string,
  version: number,
  status: 'ACTIVE' | 'INACTIVE',
): Promise<ManagedCustomer> {
  const result = await client.request(`/customers/${encodeURIComponent(id)}/status`, {
    method: 'PATCH',
    organizationId,
    csrfToken: await csrfToken(),
    idempotencyKey: crypto.randomUUID(),
    ifMatch: String(version),
    body: { status },
    parse: (value) => customerSchema.parse(value),
  });
  if (!result) throw new Error('Empty customer status response');
  return result;
}

export async function deleteCustomer(
  organizationId: string,
  id: string,
  version: number,
): Promise<{ id: string; deleted: true }> {
  const result = await client.request(`/customers/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    organizationId,
    csrfToken: await csrfToken(),
    idempotencyKey: crypto.randomUUID(),
    ifMatch: String(version),
    parse: (value) => z.object({ id: z.string(), deleted: z.literal(true) }).parse(value),
  });
  if (!result) throw new Error('Empty delete customer response');
  return result;
}

export function explainCustomerError(cause: unknown): ApiProblemError {
  if (cause instanceof ApiProblemError || (typeof cause === 'object' && cause !== null && 'code' in cause)) {
    const errorObj = cause as { code: string; status?: number; message?: string; traceId?: string };
    const code = errorObj.code;
    const status = errorObj.status ?? 409;
    let message = errorObj.message ?? 'Operación no permitida.';

    if (code === 'CUSTOMER_DELETE_BLOCKED_BY_HISTORY') {
      message = 'El cliente posee referencias históricas y solo puede desactivarse.';
    } else if (code === 'CUSTOMER_NAME_CONFLICT') {
      message = 'Ya existe un cliente con ese nombre en la organización.';
    } else if (code === 'CUSTOMER_TAX_ID_CONFLICT') {
      message = 'Ya existe un cliente con esa identificación tributaria en la organización.';
    } else if (code === 'VERSION_CONFLICT') {
      message = 'El cliente cambió desde que lo cargaste. Volvé a cargar antes de guardar.';
    } else if (code === 'CUSTOMER_CREATE_FORBIDDEN' || code === 'CUSTOMER_UPDATE_FORBIDDEN' || code === 'CUSTOMER_STATUS_FORBIDDEN' || code === 'CUSTOMER_DELETE_FORBIDDEN') {
      message = 'Tu rol no tiene permisos para realizar esta acción sobre clientes.';
    }
    return new ApiProblemError({ status, code, message, traceId: errorObj.traceId });
  }
  return new ApiProblemError({ status: 0, code: 'REQUEST_FAILED', message: 'No pudimos completar la operación. Intentá nuevamente.' });
}

export function CustomerManagement({
  organizationId,
  role,
  customers,
  onReload,
  onCreate = createCustomer,
  onEdit = editCustomer,
  onChangeStatus = changeCustomerStatus,
  onDelete = deleteCustomer,
}: {
  organizationId: string;
  role: Role;
  customers: ManagedCustomer[];
  onReload: () => void;
  onCreate?: typeof createCustomer;
  onEdit?: typeof editCustomer;
  onChangeStatus?: typeof changeCustomerStatus;
  onDelete?: typeof deleteCustomer;
}) {
  const [error, setError] = useState<ApiProblemError | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [filterText, setFilterText] = useState('');

  const canCreate = role === 'OWNER' || role === 'ADMIN' || role === 'CASHIER';
  const canEdit = role === 'OWNER' || role === 'ADMIN' || role === 'CASHIER';
  const canManageStatus = role === 'OWNER' || role === 'ADMIN';
  const canDelete = role === 'OWNER' || role === 'ADMIN';

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { name: '', taxId: '', contact: '', address: '', notes: '' },
  });

  async function submitCreate(values: FormValues) {
    setError(null);
    setMessage('');
    setBusy(true);
    try {
      await onCreate(organizationId, {
        name: values.name.trim(),
        taxId: values.taxId.trim() || null,
        contact: values.contact.trim() || null,
        address: values.address.trim() || null,
        notes: values.notes.trim() || null,
      });
      form.reset();
      setMessage('Cliente creado con éxito.');
      onReload();
    } catch (cause) {
      setError(explainCustomerError(cause));
    } finally {
      setBusy(false);
    }
  }

  const filteredCustomers = customers.filter((c) =>
    c.name.toLowerCase().includes(filterText.toLowerCase()) ||
    (c.taxId && c.taxId.toLowerCase().includes(filterText.toLowerCase())),
  );

  return (
    <section className={styles.page} aria-labelledby="customers-heading">
      <header className={styles.heading}>
        <h1 id="customers-heading">Clientes</h1>
        <p>Administración de clientes y datos fiscales para ventas y cuenta corriente.</p>
      </header>
      <ErrorSummary error={error} />
      {message ? <p role="status">{message}</p> : null}

      {canCreate ? (
        <form className={styles.panel} onSubmit={form.handleSubmit(submitCreate)} noValidate>
          <h2>Nuevo cliente</h2>
          <div className={styles.fields}>
            <div>
              <label htmlFor="customer-new-name">Nombre del cliente nuevo</label>
              <input
                id="customer-new-name"
                aria-invalid={!!form.formState.errors.name}
                {...form.register('name')}
              />
              {form.formState.errors.name ? <p role="alert">{form.formState.errors.name.message}</p> : null}
            </div>
            <div>
              <label htmlFor="customer-new-taxid">CUIT/Identificación tributaria opcional</label>
              <input id="customer-new-taxid" {...form.register('taxId')} />
            </div>
            <div>
              <label htmlFor="customer-new-contact">Contacto</label>
              <input id="customer-new-contact" {...form.register('contact')} />
            </div>
            <div>
              <label htmlFor="customer-new-address">Dirección</label>
              <input id="customer-new-address" {...form.register('address')} />
            </div>
            <div>
              <label htmlFor="customer-new-notes">Notas internas</label>
              <input id="customer-new-notes" {...form.register('notes')} />
            </div>
          </div>
          <button type="submit" disabled={busy}>{busy ? 'Creando…' : 'Crear cliente'}</button>
        </form>
      ) : null}

      <section className={styles.panel} aria-labelledby="customers-list-heading">
        <h2 id="customers-list-heading">Listado de clientes</h2>
        <div className={styles.fields}>
          <div>
            <label htmlFor="customer-filter">Buscar clientes</label>
            <input
              id="customer-filter"
              type="search"
              placeholder="Filtrar por nombre o identificación…"
              value={filterText}
              onChange={(e) => setFilterText(e.target.value)}
            />
          </div>
        </div>

        {filteredCustomers.length === 0 ? (
          <p>No se encontraron clientes.</p>
        ) : (
          <ul className={styles.rows}>
            {filteredCustomers.map((customer) => (
              <li className={styles.row} key={customer.id}>
                <div>
                  <strong>{customer.name}</strong>
                  <span>
                    {customer.status === 'ACTIVE' ? 'Activo' : 'Inactivo'}
                    {customer.taxId ? ` · CUIT: ${customer.taxId}` : ''}
                    {customer.contact ? ` · Contacto: ${customer.contact}` : ''}
                  </span>
                  {customer.address ? <span>Dirección: {customer.address}</span> : null}
                </div>
                <CustomerItemEditor
                  organizationId={organizationId}
                  customer={customer}
                  canEdit={canEdit}
                  canManageStatus={canManageStatus}
                  canDelete={canDelete}
                  onReload={onReload}
                  onEdit={onEdit}
                  onChangeStatus={onChangeStatus}
                  onDelete={onDelete}
                />
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}

function CustomerItemEditor({
  organizationId,
  customer,
  canEdit,
  canManageStatus,
  canDelete,
  onReload,
  onEdit,
  onChangeStatus,
  onDelete,
}: {
  organizationId: string;
  customer: ManagedCustomer;
  canEdit: boolean;
  canManageStatus: boolean;
  canDelete: boolean;
  onReload: () => void;
  onEdit: typeof editCustomer;
  onChangeStatus: typeof changeCustomerStatus;
  onDelete: typeof deleteCustomer;
}) {
  const [mode, setMode] = useState<'closed' | 'edit' | 'delete'>('closed');
  const [error, setError] = useState<ApiProblemError | null>(null);
  const [busy, setBusy] = useState(false);

  const editForm = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: customer.name,
      taxId: customer.taxId ?? '',
      contact: customer.contact ?? '',
      address: customer.address ?? '',
      notes: customer.notes ?? '',
    },
  });

  async function saveEdit(values: FormValues) {
    setError(null);
    setBusy(true);
    try {
      await onEdit(organizationId, customer.id, customer.version, {
        name: values.name.trim(),
        taxId: values.taxId.trim() || null,
        contact: values.contact.trim() || null,
        address: values.address.trim() || null,
        notes: values.notes.trim() || null,
      });
      setMode('closed');
      onReload();
    } catch (cause) {
      setError(explainCustomerError(cause));
    } finally {
      setBusy(false);
    }
  }

  async function toggleStatus() {
    setError(null);
    setBusy(true);
    const nextStatus = customer.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE';
    try {
      await onChangeStatus(organizationId, customer.id, customer.version, nextStatus);
      onReload();
    } catch (cause) {
      setError(explainCustomerError(cause));
    } finally {
      setBusy(false);
    }
  }

  async function confirmDelete() {
    setError(null);
    setBusy(true);
    try {
      await onDelete(organizationId, customer.id, customer.version);
      setMode('closed');
      onReload();
    } catch (cause) {
      setError(explainCustomerError(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <ErrorSummary error={error} />
      <div className={styles.actions}>
        {canEdit ? (
          <button type="button" onClick={() => setMode(mode === 'edit' ? 'closed' : 'edit')}>
            Editar {customer.name}
          </button>
        ) : null}
        {canManageStatus ? (
          <button type="button" onClick={() => void toggleStatus()} disabled={busy}>
            {customer.status === 'ACTIVE' ? `Desactivar ${customer.name}` : `Activar ${customer.name}`}
          </button>
        ) : null}
        {canDelete ? (
          <button type="button" onClick={() => setMode(mode === 'delete' ? 'closed' : 'delete')}>
            Eliminar {customer.name}
          </button>
        ) : null}
      </div>

      {mode === 'edit' ? (
        <form onSubmit={editForm.handleSubmit(saveEdit)} noValidate>
          <div className={styles.fields}>
            <div>
              <label htmlFor={`customer-edit-name-${customer.id}`}>Nombre de {customer.name}</label>
              <input
                id={`customer-edit-name-${customer.id}`}
                aria-invalid={!!editForm.formState.errors.name}
                {...editForm.register('name')}
              />
              {editForm.formState.errors.name ? <p role="alert">Ingresá un nombre válido.</p> : null}
            </div>
            <div>
              <label htmlFor={`customer-edit-taxid-${customer.id}`}>CUIT/Identificación tributaria</label>
              <input id={`customer-edit-taxid-${customer.id}`} {...editForm.register('taxId')} />
            </div>
            <div>
              <label htmlFor={`customer-edit-contact-${customer.id}`}>Contacto</label>
              <input id={`customer-edit-contact-${customer.id}`} {...editForm.register('contact')} />
            </div>
            <div>
              <label htmlFor={`customer-edit-address-${customer.id}`}>Dirección</label>
              <input id={`customer-edit-address-${customer.id}`} {...editForm.register('address')} />
            </div>
            <div>
              <label htmlFor={`customer-edit-notes-${customer.id}`}>Notas internas</label>
              <input id={`customer-edit-notes-${customer.id}`} {...editForm.register('notes')} />
            </div>
          </div>
          <button type="submit" disabled={busy}>Guardar cambios de {customer.name}</button>
        </form>
      ) : null}

      {mode === 'delete' ? (
        <div role="region" aria-label={`Confirmar eliminación de ${customer.name}`}>
          <p>¿Confirmás eliminar definitivamente {customer.name}?</p>
          <p>Solo se puede eliminar si no posee historial comercial previo. En caso contrario, se debe desactivar.</p>
          <div className={styles.actions}>
            <button type="button" onClick={() => void confirmDelete()} disabled={busy}>
              Confirmar eliminación de {customer.name}
            </button>
            <button type="button" onClick={() => setMode('closed')} disabled={busy}>
              Cancelar
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
