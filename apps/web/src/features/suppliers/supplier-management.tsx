'use client';

import { useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { ErrorSummary } from '../../components/error-summary';
import { ApiClient, ApiProblemError } from '../../lib/api/client';
import styles from '../identity/management.module.css';

export interface ManagedSupplier {
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

const supplierSchema = z.object({
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
  items: z.array(supplierSchema),
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

export async function loadSuppliers(organizationId: string, search?: string): Promise<ManagedSupplier[]> {
  const query = search ? `?search=${encodeURIComponent(search)}` : '';
  const result = await client.request(`/suppliers${query}`, {
    method: 'GET',
    organizationId,
    parse: (value) => listResponseSchema.parse(value),
  });
  return result?.items ?? [];
}

export async function createSupplier(
  organizationId: string,
  input: { name: string; taxId?: string | null; contact?: string | null; address?: string | null; notes?: string | null },
): Promise<ManagedSupplier> {
  const result = await client.request('/suppliers', {
    method: 'POST',
    organizationId,
    csrfToken: await csrfToken(),
    idempotencyKey: crypto.randomUUID(),
    body: input,
    parse: (value) => supplierSchema.parse(value),
  });
  if (!result) throw new Error('Empty supplier response');
  return result;
}

export async function editSupplier(
  organizationId: string,
  id: string,
  version: number,
  input: { name?: string; taxId?: string | null; contact?: string | null; address?: string | null; notes?: string | null },
): Promise<ManagedSupplier> {
  const result = await client.request(`/suppliers/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    organizationId,
    csrfToken: await csrfToken(),
    idempotencyKey: crypto.randomUUID(),
    ifMatch: String(version),
    body: input,
    parse: (value) => supplierSchema.parse(value),
  });
  if (!result) throw new Error('Empty supplier response');
  return result;
}

export async function changeSupplierStatus(
  organizationId: string,
  id: string,
  version: number,
  status: 'ACTIVE' | 'INACTIVE',
): Promise<ManagedSupplier> {
  const result = await client.request(`/suppliers/${encodeURIComponent(id)}/status`, {
    method: 'PATCH',
    organizationId,
    csrfToken: await csrfToken(),
    idempotencyKey: crypto.randomUUID(),
    ifMatch: String(version),
    body: { status },
    parse: (value) => supplierSchema.parse(value),
  });
  if (!result) throw new Error('Empty supplier status response');
  return result;
}

export async function deleteSupplier(
  organizationId: string,
  id: string,
  version: number,
): Promise<{ id: string; deleted: true }> {
  const result = await client.request(`/suppliers/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    organizationId,
    csrfToken: await csrfToken(),
    idempotencyKey: crypto.randomUUID(),
    ifMatch: String(version),
    parse: (value) => z.object({ id: z.string(), deleted: z.literal(true) }).parse(value),
  });
  if (!result) throw new Error('Empty delete supplier response');
  return result;
}

export function explainSupplierError(cause: unknown): ApiProblemError {
  if (cause instanceof ApiProblemError || (typeof cause === 'object' && cause !== null && 'code' in cause)) {
    const errorObj = cause as { code: string; status?: number; message?: string; traceId?: string };
    const code = errorObj.code;
    const status = errorObj.status ?? 409;
    let message = errorObj.message ?? 'Operación no permitida.';

    if (code === 'SUPPLIER_DELETE_BLOCKED_BY_HISTORY') {
      message = 'El proveedor posee referencias históricas y solo puede desactivarse.';
    } else if (code === 'SUPPLIER_NAME_CONFLICT') {
      message = 'Ya existe un proveedor con ese nombre en la organización.';
    } else if (code === 'SUPPLIER_TAX_ID_CONFLICT') {
      message = 'Ya existe un proveedor con esa identificación tributaria en la organización.';
    } else if (code === 'VERSION_CONFLICT') {
      message = 'El proveedor cambió desde que lo cargaste. Volvé a cargar antes de guardar.';
    } else if (code === 'SUPPLIER_CREATE_FORBIDDEN' || code === 'SUPPLIER_UPDATE_FORBIDDEN' || code === 'SUPPLIER_STATUS_FORBIDDEN' || code === 'SUPPLIER_DELETE_FORBIDDEN') {
      message = 'Tu rol no tiene permisos para administrar proveedores.';
    }
    return new ApiProblemError({ status, code, message, traceId: errorObj.traceId });
  }
  return new ApiProblemError({ status: 0, code: 'REQUEST_FAILED', message: 'No pudimos completar la operación. Intentá nuevamente.' });
}

export function SupplierManagement({
  organizationId,
  role,
  suppliers,
  onReload,
  onCreate = createSupplier,
  onEdit = editSupplier,
  onChangeStatus = changeSupplierStatus,
  onDelete = deleteSupplier,
}: {
  organizationId: string;
  role: Role;
  suppliers: ManagedSupplier[];
  onReload: () => void;
  onCreate?: typeof createSupplier;
  onEdit?: typeof editSupplier;
  onChangeStatus?: typeof changeSupplierStatus;
  onDelete?: typeof deleteSupplier;
}) {
  const [error, setError] = useState<ApiProblemError | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [filterText, setFilterText] = useState('');

  const canManage = role === 'OWNER' || role === 'ADMIN';

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
      setMessage('Proveedor creado con éxito.');
      onReload();
    } catch (cause) {
      setError(explainSupplierError(cause));
    } finally {
      setBusy(false);
    }
  }

  const filteredSuppliers = suppliers.filter((s) =>
    s.name.toLowerCase().includes(filterText.toLowerCase()) ||
    (s.taxId && s.taxId.toLowerCase().includes(filterText.toLowerCase())),
  );

  return (
    <section className={styles.page} aria-labelledby="suppliers-heading">
      <header className={styles.heading}>
        <h1 id="suppliers-heading">Proveedores</h1>
        <p>Registro y datos de contacto de proveedores para órdenes de compra y recepción de stock.</p>
      </header>
      <ErrorSummary error={error} />
      {message ? <p role="status">{message}</p> : null}

      {canManage ? (
        <form className={styles.panel} onSubmit={form.handleSubmit(submitCreate)} noValidate>
          <h2>Nuevo proveedor</h2>
          <div className={styles.fields}>
            <div>
              <label htmlFor="supplier-new-name">Nombre del proveedor nuevo</label>
              <input
                id="supplier-new-name"
                aria-invalid={!!form.formState.errors.name}
                {...form.register('name')}
              />
              {form.formState.errors.name ? <p role="alert">{form.formState.errors.name.message}</p> : null}
            </div>
            <div>
              <label htmlFor="supplier-new-taxid">CUIT/Identificación tributaria opcional</label>
              <input id="supplier-new-taxid" {...form.register('taxId')} />
            </div>
            <div>
              <label htmlFor="supplier-new-contact">Contacto</label>
              <input id="supplier-new-contact" {...form.register('contact')} />
            </div>
            <div>
              <label htmlFor="supplier-new-address">Dirección</label>
              <input id="supplier-new-address" {...form.register('address')} />
            </div>
            <div>
              <label htmlFor="supplier-new-notes">Notas internas</label>
              <input id="supplier-new-notes" {...form.register('notes')} />
            </div>
          </div>
          <button type="submit" disabled={busy}>{busy ? 'Creando…' : 'Crear proveedor'}</button>
        </form>
      ) : null}

      <section className={styles.panel} aria-labelledby="suppliers-list-heading">
        <h2 id="suppliers-list-heading">Listado de proveedores</h2>
        <div className={styles.fields}>
          <div>
            <label htmlFor="supplier-filter">Buscar proveedores</label>
            <input
              id="supplier-filter"
              type="search"
              placeholder="Filtrar por nombre o identificación…"
              value={filterText}
              onChange={(e) => setFilterText(e.target.value)}
            />
          </div>
        </div>

        {filteredSuppliers.length === 0 ? (
          <p>No se encontraron proveedores.</p>
        ) : (
          <ul className={styles.rows}>
            {filteredSuppliers.map((supplier) => (
              <li className={styles.row} key={supplier.id}>
                <div>
                  <strong>{supplier.name}</strong>
                  <span>
                    {supplier.status === 'ACTIVE' ? 'Activo' : 'Inactivo'}
                    {supplier.taxId ? ` · CUIT: ${supplier.taxId}` : ''}
                    {supplier.contact ? ` · Contacto: ${supplier.contact}` : ''}
                  </span>
                  {supplier.address ? <span>Dirección: {supplier.address}</span> : null}
                </div>
                <SupplierItemEditor
                  organizationId={organizationId}
                  supplier={supplier}
                  canManage={canManage}
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

function SupplierItemEditor({
  organizationId,
  supplier,
  canManage,
  onReload,
  onEdit,
  onChangeStatus,
  onDelete,
}: {
  organizationId: string;
  supplier: ManagedSupplier;
  canManage: boolean;
  onReload: () => void;
  onEdit: typeof editSupplier;
  onChangeStatus: typeof changeSupplierStatus;
  onDelete: typeof deleteSupplier;
}) {
  const [mode, setMode] = useState<'closed' | 'edit' | 'delete'>('closed');
  const [error, setError] = useState<ApiProblemError | null>(null);
  const [busy, setBusy] = useState(false);

  const editForm = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: supplier.name,
      taxId: supplier.taxId ?? '',
      contact: supplier.contact ?? '',
      address: supplier.address ?? '',
      notes: supplier.notes ?? '',
    },
  });

  async function saveEdit(values: FormValues) {
    setError(null);
    setBusy(true);
    try {
      await onEdit(organizationId, supplier.id, supplier.version, {
        name: values.name.trim(),
        taxId: values.taxId.trim() || null,
        contact: values.contact.trim() || null,
        address: values.address.trim() || null,
        notes: values.notes.trim() || null,
      });
      setMode('closed');
      onReload();
    } catch (cause) {
      setError(explainSupplierError(cause));
    } finally {
      setBusy(false);
    }
  }

  async function toggleStatus() {
    setError(null);
    setBusy(true);
    const nextStatus = supplier.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE';
    try {
      await onChangeStatus(organizationId, supplier.id, supplier.version, nextStatus);
      onReload();
    } catch (cause) {
      setError(explainSupplierError(cause));
    } finally {
      setBusy(false);
    }
  }

  async function confirmDelete() {
    setError(null);
    setBusy(true);
    try {
      await onDelete(organizationId, supplier.id, supplier.version);
      setMode('closed');
      onReload();
    } catch (cause) {
      setError(explainSupplierError(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <ErrorSummary error={error} />
      {canManage ? (
        <div className={styles.actions}>
          <button type="button" onClick={() => setMode(mode === 'edit' ? 'closed' : 'edit')}>
            Editar {supplier.name}
          </button>
          <button type="button" onClick={() => void toggleStatus()} disabled={busy}>
            {supplier.status === 'ACTIVE' ? `Desactivar ${supplier.name}` : `Activar ${supplier.name}`}
          </button>
          <button type="button" onClick={() => setMode(mode === 'delete' ? 'closed' : 'delete')}>
            Eliminar {supplier.name}
          </button>
        </div>
      ) : null}

      {mode === 'edit' ? (
        <form onSubmit={editForm.handleSubmit(saveEdit)} noValidate>
          <div className={styles.fields}>
            <div>
              <label htmlFor={`supplier-edit-name-${supplier.id}`}>Nombre de {supplier.name}</label>
              <input
                id={`supplier-edit-name-${supplier.id}`}
                aria-invalid={!!editForm.formState.errors.name}
                {...editForm.register('name')}
              />
              {editForm.formState.errors.name ? <p role="alert">Ingresá un nombre válido.</p> : null}
            </div>
            <div>
              <label htmlFor={`supplier-edit-taxid-${supplier.id}`}>CUIT/Identificación tributaria</label>
              <input id={`supplier-edit-taxid-${supplier.id}`} {...editForm.register('taxId')} />
            </div>
            <div>
              <label htmlFor={`supplier-edit-contact-${supplier.id}`}>Contacto</label>
              <input id={`supplier-edit-contact-${supplier.id}`} {...editForm.register('contact')} />
            </div>
            <div>
              <label htmlFor={`supplier-edit-address-${supplier.id}`}>Dirección</label>
              <input id={`supplier-edit-address-${supplier.id}`} {...editForm.register('address')} />
            </div>
            <div>
              <label htmlFor={`supplier-edit-notes-${supplier.id}`}>Notas internas</label>
              <input id={`supplier-edit-notes-${supplier.id}`} {...editForm.register('notes')} />
            </div>
          </div>
          <button type="submit" disabled={busy}>Guardar cambios de {supplier.name}</button>
        </form>
      ) : null}

      {mode === 'delete' ? (
        <div role="region" aria-label={`Confirmar eliminación de ${supplier.name}`}>
          <p>¿Confirmás eliminar definitivamente {supplier.name}?</p>
          <p>Solo se puede eliminar si no posee historial de compras o recepción previo. En caso contrario, se debe desactivar.</p>
          <div className={styles.actions}>
            <button type="button" onClick={() => void confirmDelete()} disabled={busy}>
              Confirmar eliminación de {supplier.name}
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
