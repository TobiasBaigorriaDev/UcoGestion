'use client';

import { useState } from 'react';
import { z } from 'zod';

import { ErrorSummary } from '../../components/error-summary';
import { ApiClient, ApiProblemError } from '../../lib/api/client';
import styles from '../identity/management.module.css';

export const paymentMethods = ['CASH', 'DEBIT_CARD', 'CREDIT_CARD', 'TRANSFER', 'QR'] as const;
export type PaymentMethod = typeof paymentMethods[number];

export interface ManagedPaymentMethod {
  readonly method: PaymentMethod;
  readonly enabled: boolean;
}

export type Role = 'OWNER' | 'ADMIN' | 'CASHIER' | 'EMPLOYEE';

export const paymentMethodLabels: Record<PaymentMethod, string> = {
  CASH: 'Efectivo',
  DEBIT_CARD: 'Tarjeta de Débito',
  CREDIT_CARD: 'Tarjeta de Crédito',
  TRANSFER: 'Transferencia',
  QR: 'QR / Billetera digital',
};

export const paymentMethodDescriptions: Record<PaymentMethod, string> = {
  CASH: 'Cobros en efectivo y control de caja registradora.',
  DEBIT_CARD: 'Pagos mediante tarjeta de débito.',
  CREDIT_CARD: 'Pagos con tarjeta de crédito.',
  TRANSFER: 'Transferencias bancarias directas y CBU/CVU/Alias.',
  QR: 'Cobros digitales con código QR y billeteras virtuales.',
};

const responseSchema = z.object({
  paymentMethods: z.array(
    z.object({
      method: z.enum(paymentMethods),
      enabled: z.boolean(),
    }),
  ),
});

const itemSchema = z.object({
  method: z.enum(paymentMethods),
  enabled: z.boolean(),
});

const client = new ApiClient();

async function csrfToken(): Promise<string> {
  const result = await client.request('/auth/csrf', {
    method: 'GET',
    parse: (value) => z.object({ csrfToken: z.string() }).parse(value),
  });
  if (!result) throw new Error('CSRF unavailable');
  return result.csrfToken;
}

export async function loadPaymentMethods(organizationId: string): Promise<ManagedPaymentMethod[]> {
  const result = await client.request('/organizations/payment-methods', {
    method: 'GET',
    organizationId,
    parse: (value) => responseSchema.parse(value),
  });
  return result?.paymentMethods ?? [];
}

export async function setPaymentMethodEnabled(
  organizationId: string,
  method: PaymentMethod,
  enabled: boolean,
): Promise<ManagedPaymentMethod> {
  const result = await client.request(`/organizations/payment-methods/${encodeURIComponent(method)}`, {
    method: 'PATCH',
    organizationId,
    csrfToken: await csrfToken(),
    body: { enabled },
    parse: (value) => itemSchema.parse(value),
  });
  if (!result) throw new Error('Empty payment method response');
  return result;
}

export function PaymentMethodsManagement({
  organizationId,
  role,
  methods,
  onReload,
  onToggle = setPaymentMethodEnabled,
}: {
  organizationId: string;
  role: Role;
  methods: ManagedPaymentMethod[];
  onReload: () => void;
  onToggle?: typeof setPaymentMethodEnabled;
}) {
  const [error, setError] = useState<ApiProblemError | null>(null);
  const [message, setMessage] = useState('');
  const [busyMethod, setBusyMethod] = useState<PaymentMethod | null>(null);

  const canManage = role === 'OWNER' || role === 'ADMIN';

  async function handleToggle(method: PaymentMethod, currentEnabled: boolean) {
    setError(null);
    setMessage('');
    setBusyMethod(method);
    const nextEnabled = !currentEnabled;
    try {
      await onToggle(organizationId, method, nextEnabled);
      setMessage(
        `Medio de pago ${paymentMethodLabels[method]} ${nextEnabled ? 'habilitado' : 'deshabilitado'}.`,
      );
      onReload();
    } catch (cause) {
      setError(
        cause instanceof ApiProblemError
          ? cause
          : new ApiProblemError({
              status: 0,
              code: 'REQUEST_FAILED',
              message: 'No pudimos actualizar el medio de pago. Intentá nuevamente.',
            }),
      );
    } finally {
      setBusyMethod(null);
    }
  }

  return (
    <section className={styles.page} aria-labelledby="payment-methods-heading">
      <header className={styles.heading}>
        <h1 id="payment-methods-heading">Medios de pago</h1>
        <p>Habilitá o deshabilitá los medios de pago disponibles para las operaciones de cobro en mostrador.</p>
      </header>
      <ErrorSummary error={error} />
      {message ? <p role="status">{message}</p> : null}

      <section className={styles.panel} aria-labelledby="methods-list-heading">
        <h2 id="methods-list-heading">Medios de pago configurados</h2>
        <ul className={styles.rows}>
          {methods.map(({ method, enabled }) => {
            const label = paymentMethodLabels[method] ?? method;
            const desc = paymentMethodDescriptions[method] ?? '';
            const isBusy = busyMethod === method;

            return (
              <li className={styles.row} key={method}>
                <div>
                  <strong>{label}</strong>
                  <span>{desc}</span>
                  <span>{enabled ? 'Habilitado' : 'Deshabilitado'}</span>
                </div>
                {canManage ? (
                  <div className={styles.actions}>
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => void handleToggle(method, enabled)}
                    >
                      {isBusy
                        ? 'Guardando…'
                        : enabled
                          ? `Deshabilitar ${label}`
                          : `Habilitar ${label}`}
                    </button>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      </section>
    </section>
  );
}
