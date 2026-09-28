'use client';

import { useEffect, useRef, useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useFieldArray, useForm } from 'react-hook-form';
import { z } from 'zod';

import { ErrorSummary } from '../../components/error-summary';
import { ApiProblemError } from '../../lib/api/client';
import { confirmPurchase, type PurchaseConfirmationInput, type PurchasePaymentInput } from './purchases-api';
import styles from '../identity/management.module.css';

const lineSchema = z.object({ itemId: z.string().min(1), quantity: z.string().regex(/^(?:0|[1-9]\d{0,16})(?:\.\d{1,3})?$/),
  unitCost: z.string().regex(/^(?:0|[1-9]\d{0,17})\.\d{2}$/) });
const formSchema = z.object({ supplierId: z.string().min(1), status: z.enum(['PENDING_PAYMENT', 'PAID']),
  method: z.string(), sessionId: z.string(), lines: z.array(lineSchema).min(1) });
type FormValues = z.infer<typeof formSchema>;

export interface PurchaseCreationProps {
  organizationId: string;
  branchId: string;
  role: 'OWNER' | 'ADMIN' | 'EMPLOYEE';
  suppliers: readonly { id: string; name: string }[];
  items: readonly { id: string; name: string; baseUnit: 'UNIT' | 'FRACTIONAL' }[];
  paymentMethods: readonly string[];
  sessions: readonly { id: string; deviceId: string; registerName: string }[];
  onConfirm?: typeof confirmPurchase;
}

function totalCents(lines: readonly { quantity: string; unitCost: string }[]): bigint | null {
  let total = 0n;
  for (const line of lines) {
    if (!/^(?:0|[1-9]\d*)(?:\.\d{1,3})?$/.test(line.quantity)
      || !/^(?:0|[1-9]\d*)\.\d{2}$/.test(line.unitCost)) return null;
    const [whole, fraction = ''] = line.quantity.split('.');
    const quantity = BigInt(whole ?? '0') * 1000n + BigInt(fraction.padEnd(3, '0'));
    const cents = BigInt(line.unitCost.replace('.', ''));
    total += (quantity * cents + 500n) / 1000n;
  }
  return total;
}

export function PurchaseCreation({ organizationId, branchId, role, suppliers, items,
  paymentMethods, sessions, onConfirm = confirmPurchase }: PurchaseCreationProps) {
  const [error, setError] = useState<ApiProblemError | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const key = useRef<string | null>(null);
  const form = useForm<FormValues>({ resolver: zodResolver(formSchema),
    defaultValues: { supplierId: '', status: 'PENDING_PAYMENT', method: '', sessionId: '',
      lines: [{ itemId: '', quantity: '', unitCost: '' }] } });
  const { fields, append, remove } = useFieldArray({ control: form.control, name: 'lines' });
  useEffect(() => {
    const subscription = form.watch(() => { key.current = null; });
    return () => subscription.unsubscribe();
  }, [form]);
  const values = form.watch();
  const total = totalCents(values.lines ?? []);
  const totalText = total === null ? '—' : `${(total / 100n).toString()}.${(total % 100n).toString().padStart(2, '0')}`;
  const paid = role !== 'EMPLOYEE' && values.status === 'PAID';
  const needsPayment = paid && total !== 0n;
  const method = values.method;
  const selectedSession = sessions.find((session) => session.id === values.sessionId);
  const canSubmit = suppliers.length > 0 && items.length > 0 && total !== null
    && (!needsPayment || !!method && (method !== 'CASH' || !!selectedSession));

  async function submit(data: FormValues) {
    if (!canSubmit || total === null) return;
    const invalidUnit = data.lines.some((line) => items.find((item) => item.id === line.itemId)?.baseUnit === 'UNIT'
      && !/^[1-9]\d*$/.test(line.quantity));
    if (invalidUnit || data.lines.some((line) =>
      !/^(?:0|[1-9]\d*)(?:\.\d{1,3})?$/.test(line.quantity)
      || BigInt(line.quantity.replace('.', '')) === 0n)) {
      setError(new ApiProblemError({ status: 400, code: 'PURCHASE_QUANTITY_INVALID',
        message: 'Usá cantidades positivas y enteras para productos por unidad.' }));
      return;
    }
    const operationKey = key.current ?? crypto.randomUUID(); key.current = operationKey;
    const input: PurchaseConfirmationInput = { branchId, supplierId: data.supplierId,
      clientOperationId: operationKey, lines: data.lines };
    const payment: PurchasePaymentInput | null = needsPayment ? { method: data.method, amount: totalText,
      ...(data.method === 'CASH' && selectedSession
        ? { cashSessionId: selectedSession.id, deviceId: selectedSession.deviceId } : {}) } : null;
    setError(null); setSuccess(null);
    try {
      const result = await onConfirm(organizationId, input, paid ? 'PAID' : 'PENDING_PAYMENT', payment, operationKey);
      setSuccess(`${result.status === 'PAID' ? 'Compra pagada' : 'Recepción pendiente de pago'} · ${result.id}`);
      key.current = null;
      form.reset();
    } catch (cause) {
      setError(cause instanceof ApiProblemError ? cause : new ApiProblemError({ status: 0,
        code: 'PURCHASE_CONFIRM_FAILED', message: 'No pudimos confirmar la compra. Revisá los datos e intentá nuevamente.' }));
    }
  }

  return <section className={styles.page} aria-labelledby="purchase-create-heading">
    <header className={styles.heading}><h1 id="purchase-create-heading">Nueva compra</h1>
      <p>{role === 'EMPLOYEE' ? 'Registrá la mercadería recibida. El pago quedará pendiente.'
        : 'Registrá productos, costos y el estado inicial del pago.'}</p></header>
    <form className={styles.panel} onSubmit={form.handleSubmit((data) => void submit(data))}>
      <h2>Datos de la compra</h2>
      <div className={styles.fields}><div><label htmlFor="purchase-supplier">Proveedor</label>
        <select id="purchase-supplier" {...form.register('supplierId')}><option value="">Seleccioná un proveedor</option>
          {suppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.name}</option>)}</select>
        {form.formState.errors.supplierId ? <p role="alert">Seleccioná un proveedor.</p> : null}</div>
        {role !== 'EMPLOYEE' ? <div><label htmlFor="purchase-status">Estado al confirmar</label>
          <select id="purchase-status" {...form.register('status')}><option value="PENDING_PAYMENT">Pendiente de pago</option>
            <option value="PAID">Pagada</option></select></div> : null}</div>
      <h2>Productos recibidos</h2>
      {fields.map((field, index) => <fieldset key={field.id}><legend>Producto {index + 1}</legend>
        <div className={styles.fields}><div><label htmlFor={`purchase-item-${index}`}>Producto</label>
          <select id={`purchase-item-${index}`} {...form.register(`lines.${index}.itemId`)}>
            <option value="">Seleccioná un producto</option>
            {items.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></div>
          <div><label htmlFor={`purchase-quantity-${index}`}>Cantidad</label>
            <input id={`purchase-quantity-${index}`} inputMode="decimal" {...form.register(`lines.${index}.quantity`)} /></div>
          <div><label htmlFor={`purchase-cost-${index}`}>Costo unitario</label>
            <input id={`purchase-cost-${index}`} inputMode="decimal" {...form.register(`lines.${index}.unitCost`)} /></div></div>
        {fields.length > 1 ? <button type="button" onClick={() => remove(index)}>Quitar producto</button> : null}
      </fieldset>)}
      <button type="button" onClick={() => append({ itemId: '', quantity: '', unitCost: '' })}>Agregar producto</button>
      <p aria-live="polite"><strong>Total estimado:</strong> {totalText}</p>
      {needsPayment ? <fieldset><legend>Pago total</legend><div className={styles.fields}>
        <div><label htmlFor="purchase-method">Medio de pago</label><select id="purchase-method" {...form.register('method')}>
          <option value="">Seleccioná un medio</option>{paymentMethods.map((entry) =>
            <option key={entry} value={entry}>{entry}</option>)}</select></div>
        {method === 'CASH' ? <div><label htmlFor="purchase-session">Sesión de caja</label>
          <select id="purchase-session" {...form.register('sessionId')}><option value="">Seleccioná una sesión</option>
            {sessions.map((session) => <option key={session.id} value={session.id}>{session.registerName}</option>)}</select>
          {!sessions.length ? <p role="alert">Abrí una sesión válida en esta sucursal para pagar en efectivo.</p> : null}</div> : null}</div></fieldset> : null}
      <ErrorSummary error={error} />
      {success ? <p role="status">{success}</p> : null}
      <button type="submit" disabled={!canSubmit || form.formState.isSubmitting}>
        {form.formState.isSubmitting ? 'Confirmando…' : role === 'EMPLOYEE' ? 'Confirmar recepción' : 'Confirmar compra'}</button>
    </form>
  </section>;
}
