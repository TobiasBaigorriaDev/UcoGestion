'use client';

import { useEffect, useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { ErrorSummary } from '../../components/error-summary';
import { ApiClient, ApiProblemError } from '../../lib/api/client';
import styles from '../identity/management.module.css';

export interface ManagedCashRegister {
  readonly id: string;
  readonly branchId: string;
  readonly name: string;
  readonly status: 'ACTIVE' | 'INACTIVE';
  readonly version: number;
}

const registerSchema = z.object({
  id: z.string(),
  branchId: z.string(),
  name: z.string(),
  status: z.enum(['ACTIVE', 'INACTIVE']),
  version: z.number().int().positive(),
});

const listResponseSchema = z.object({
  cashRegisters: z.array(registerSchema),
});

const nameSchema = z.object({
  name: z.string().trim().min(1, 'El nombre es obligatorio.').max(255),
});

type NameValues = z.infer<typeof nameSchema>;
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

export async function loadCashRegisters(organizationId: string, branchId: string): Promise<ManagedCashRegister[]> {
  const result = await client.request(`/branches/${encodeURIComponent(branchId)}/cash-registers`, {
    method: 'GET',
    organizationId,
    parse: (value) => listResponseSchema.parse(value),
  });
  return result?.cashRegisters ?? [];
}

export async function createCashRegister(
  organizationId: string,
  branchId: string,
  name: string,
): Promise<ManagedCashRegister> {
  const result = await client.request(`/branches/${encodeURIComponent(branchId)}/cash-registers`, {
    method: 'POST',
    organizationId,
    csrfToken: await csrfToken(),
    idempotencyKey: crypto.randomUUID(),
    body: { name },
    parse: (value) => registerSchema.parse(value),
  });
  if (!result) throw new Error('Empty cash register response');
  return result;
}

export async function renameCashRegister(
  organizationId: string,
  branchId: string,
  registerId: string,
  version: number,
  name: string,
): Promise<ManagedCashRegister> {
  const result = await client.request(`/branches/${encodeURIComponent(branchId)}/cash-registers/${encodeURIComponent(registerId)}`, {
    method: 'PATCH',
    organizationId,
    csrfToken: await csrfToken(),
    idempotencyKey: crypto.randomUUID(),
    ifMatch: String(version),
    body: { name },
    parse: (value) => registerSchema.parse(value),
  });
  if (!result) throw new Error('Empty cash register response');
  return result;
}

export async function deactivateCashRegister(
  organizationId: string,
  branchId: string,
  registerId: string,
  version: number,
): Promise<ManagedCashRegister> {
  const result = await client.request(`/branches/${encodeURIComponent(branchId)}/cash-registers/${encodeURIComponent(registerId)}/deactivate`, {
    method: 'PATCH',
    organizationId,
    csrfToken: await csrfToken(),
    idempotencyKey: crypto.randomUUID(),
    ifMatch: String(version),
    parse: (value) => registerSchema.parse(value),
  });
  if (!result) throw new Error('Empty cash register response');
  return result;
}

export function explainCashRegisterError(cause: unknown): ApiProblemError {
  if (cause instanceof ApiProblemError || (typeof cause === 'object' && cause !== null && 'code' in cause)) {
    const errorObj = cause as { code: string; status?: number; message?: string; traceId?: string };
    const code = errorObj.code;
    const status = errorObj.status ?? 409;
    let message = errorObj.message ?? 'Operación no permitida.';

    if (code === 'CASH_REGISTER_NAME_CONFLICT') {
      message = 'Ya existe una caja con ese nombre en la sucursal.';
    } else if (code === 'CASH_REGISTER_VERSION_CONFLICT') {
      message = 'La caja cambió desde que la cargaste. Volvé a cargar para ver los cambios actuales.';
    } else if (code === 'CASH_REGISTER_BRANCH_FORBIDDEN') {
      message = 'No tenés permisos para administrar cajas en esta sucursal.';
    } else if (code === 'CASH_REGISTER_MANAGEMENT_FORBIDDEN') {
      message = 'Solo los roles OWNER y ADMIN pueden administrar cajas.';
    } else if (code === 'CASH_REGISTER_NAME_INVALID') {
      message = 'El nombre de la caja es obligatorio.';
    }
    return new ApiProblemError({ status, code, message, traceId: errorObj.traceId });
  }
  return new ApiProblemError({ status: 0, code: 'REQUEST_FAILED', message: 'No pudimos completar la operación. Intentá nuevamente.' });
}

export function CashRegisterManagement({
  organizationId,
  role,
  branches,
  selectedBranchId,
  cashRegisters,
  onReload,
  onBranchChange,
  onCreate = createCashRegister,
  onRename = renameCashRegister,
  onDeactivate = deactivateCashRegister,
}: {
  organizationId: string;
  role: Role;
  branches: Array<{ id: string; name: string }>;
  selectedBranchId?: string;
  cashRegisters: ManagedCashRegister[];
  onReload: () => void;
  onBranchChange?: (branchId: string) => void;
  onCreate?: typeof createCashRegister;
  onRename?: typeof renameCashRegister;
  onDeactivate?: typeof deactivateCashRegister;
}) {
  const [activeBranchId, setActiveBranchId] = useState<string>(selectedBranchId ?? branches[0]?.id ?? '');
  const [error, setError] = useState<ApiProblemError | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (selectedBranchId) {
      setActiveBranchId(selectedBranchId);
    }
  }, [selectedBranchId]);

  const canManage = role === 'OWNER' || role === 'ADMIN';

  const form = useForm<NameValues>({
    resolver: zodResolver(nameSchema),
    defaultValues: { name: '' },
  });

  async function submitCreate(values: NameValues) {
    if (!activeBranchId) return;
    setError(null);
    setMessage('');
    setBusy(true);
    try {
      await onCreate(organizationId, activeBranchId, values.name.trim());
      form.reset();
      setMessage('Caja creada con éxito.');
      onReload();
    } catch (cause) {
      setError(explainCashRegisterError(cause));
    } finally {
      setBusy(false);
    }
  }

  const branchRegisters = cashRegisters.filter((r) => r.branchId === activeBranchId);

  return (
    <section className={styles.page} aria-labelledby="cash-registers-heading">
      <header className={styles.heading}>
        <h1 id="cash-registers-heading">Cajas de la sucursal</h1>
        <p>Configuración de cajas registradoras y puntos de cobro por sucursal.</p>
      </header>
      <ErrorSummary error={error} />
      {message ? <p role="status">{message}</p> : null}

      {branches.length > 1 ? (
        <div className={styles.panel}>
          <label htmlFor="branch-select">Sucursal activa</label>
          <select
            id="branch-select"
            value={activeBranchId}
            onChange={(e) => {
              setActiveBranchId(e.target.value);
              onBranchChange?.(e.target.value);
            }}
          >
            {branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      {canManage && activeBranchId ? (
        <form className={styles.panel} onSubmit={form.handleSubmit(submitCreate)} noValidate>
          <h2>Nueva caja</h2>
          <div className={styles.fields}>
            <div>
              <label htmlFor="register-new-name">Nombre de la caja nueva</label>
              <input
                id="register-new-name"
                aria-invalid={!!form.formState.errors.name}
                {...form.register('name')}
              />
              {form.formState.errors.name ? <p role="alert">{form.formState.errors.name.message}</p> : null}
            </div>
          </div>
          <button type="submit" disabled={busy}>{busy ? 'Creando…' : 'Crear caja'}</button>
        </form>
      ) : null}

      <section className={styles.panel} aria-labelledby="registers-list-heading">
        <h2 id="registers-list-heading">Cajas registradas</h2>
        {branchRegisters.length === 0 ? (
          <p>No hay cajas configuradas en esta sucursal.</p>
        ) : (
          <ul className={styles.rows}>
            {branchRegisters.map((register) => (
              <li className={styles.row} key={register.id}>
                <div>
                  <strong>{register.name}</strong>
                  <span>{register.status === 'ACTIVE' ? 'Activa' : 'Inactiva'}</span>
                </div>
                <CashRegisterItemEditor
                  organizationId={organizationId}
                  branchId={activeBranchId}
                  register={register}
                  canManage={canManage}
                  onReload={onReload}
                  onRename={onRename}
                  onDeactivate={onDeactivate}
                />
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}

function CashRegisterItemEditor({
  organizationId,
  branchId,
  register,
  canManage,
  onReload,
  onRename,
  onDeactivate,
}: {
  organizationId: string;
  branchId: string;
  register: ManagedCashRegister;
  canManage: boolean;
  onReload: () => void;
  onRename: typeof renameCashRegister;
  onDeactivate: typeof deactivateCashRegister;
}) {
  const [mode, setMode] = useState<'closed' | 'rename' | 'deactivate'>('closed');
  const [error, setError] = useState<ApiProblemError | null>(null);
  const [busy, setBusy] = useState(false);

  const renameForm = useForm<NameValues>({
    resolver: zodResolver(nameSchema),
    defaultValues: { name: register.name },
  });

  async function saveRename(values: NameValues) {
    setError(null);
    setBusy(true);
    try {
      await onRename(organizationId, branchId, register.id, register.version, values.name.trim());
      setMode('closed');
      onReload();
    } catch (cause) {
      setError(explainCashRegisterError(cause));
    } finally {
      setBusy(false);
    }
  }

  async function confirmDeactivate() {
    setError(null);
    setBusy(true);
    try {
      await onDeactivate(organizationId, branchId, register.id, register.version);
      setMode('closed');
      onReload();
    } catch (cause) {
      setError(explainCashRegisterError(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <ErrorSummary error={error} />
      {canManage ? (
        <div className={styles.actions}>
          <button type="button" onClick={() => setMode(mode === 'rename' ? 'closed' : 'rename')}>
            Renombrar {register.name}
          </button>
          {register.status === 'ACTIVE' ? (
            <button type="button" onClick={() => setMode(mode === 'deactivate' ? 'closed' : 'deactivate')}>
              Desactivar {register.name}
            </button>
          ) : null}
        </div>
      ) : null}

      {mode === 'rename' ? (
        <form onSubmit={renameForm.handleSubmit(saveRename)} noValidate>
          <div className={styles.fields}>
            <div>
              <label htmlFor={`register-rename-${register.id}`}>Nombre nuevo de {register.name}</label>
              <input
                id={`register-rename-${register.id}`}
                aria-invalid={!!renameForm.formState.errors.name}
                {...renameForm.register('name')}
              />
              {renameForm.formState.errors.name ? <p role="alert">Ingresá un nombre válido.</p> : null}
            </div>
          </div>
          <button type="submit" disabled={busy}>Guardar nombre de {register.name}</button>
        </form>
      ) : null}

      {mode === 'deactivate' ? (
        <div role="region" aria-label={`Confirmar desactivación de ${register.name}`}>
          <p>¿Confirmás desactivar la caja {register.name}? No se podrán abrir nuevas sesiones en esta caja.</p>
          <div className={styles.actions}>
            <button type="button" onClick={() => void confirmDeactivate()} disabled={busy}>
              Confirmar desactivación de {register.name}
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
