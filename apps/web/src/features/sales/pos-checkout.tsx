'use client';

import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import { ErrorSummary } from '../../components/error-summary';
import { ApiProblemError } from '../../lib/api/client';
import type { CatalogReadData } from '../catalog/catalog-read';
import type { CartLine } from './pos-cart';
import { paymentBalance, type PosPayment } from './pos-payment-rules';
import { confirmSale, loadCheckoutContext, quoteSale, type SaleConfirmation,
  type SaleDiscount } from './sales-api';
import styles from './pos.module.css';

export function PosCheckout({ organizationId, branchId, role, lines, items = [], onConfirmed }: {
  organizationId: string; branchId: string; role: 'OWNER' | 'ADMIN' | 'CASHIER' | 'EMPLOYEE';
  lines: readonly CartLine[]; items?: CatalogReadData['items'];
  onConfirmed: (sale: SaleConfirmation) => void;
}) {
  const [discountKind, setDiscountKind] = useState<'PERCENTAGE' | 'FIXED'>('PERCENTAGE');
  const [discountValue, setDiscountValue] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [payments, setPayments] = useState<PosPayment[]>([]);
  const [error, setError] = useState<ApiProblemError | null>(null);
  const [priceChange, setPriceChange] = useState<{ previousKey: string; currentTotal: string } | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const operation = useRef<{ key: string; id: string } | null>(null);
  const discount: SaleDiscount | undefined = discountValue.trim() && ['OWNER', 'ADMIN'].includes(role)
    ? { kind: discountKind, value: discountValue.trim() } : undefined;
  const context = useQuery({ queryKey: ['sale-checkout-context', organizationId, branchId],
    queryFn: () => loadCheckoutContext(organizationId, branchId) });
  const quote = useQuery({ queryKey: ['sale-quote', organizationId, branchId, lines, discount],
    queryFn: () => quoteSale(organizationId, branchId, lines, discount), enabled: lines.length > 0,
    retry: false, staleTime: 0 });
  const total = quote.data?.quote.total ?? null;
  const balance = total === null ? null : paymentBalance(total, total === '0.00' ? [] : payments);
  const selected = context.data?.sessions.find((session) => session.id === sessionId)
    ?? context.data?.sessions[0];
  const resetAttempt = () => { operation.current = null; setPriceChange(null); setAccepted(false); setError(null); };
  useEffect(() => { resetAttempt(); }, [lines, discountKind, discountValue]);
  const updatePayments = (next: PosPayment[]) => {
    setPayments(next); operation.current = null; setAccepted(false); setError(null);
  };
  async function submit() {
    if (!quote.data || !selected || !balance?.valid || (priceChange && !accepted)) return;
    setBusy(true); setError(null);
    const current = operation.current ?? { key: crypto.randomUUID(), id: crypto.randomUUID() };
    operation.current = current;
    try {
      const sale = await confirmSale(organizationId, { branchId, cashSessionId: selected.id,
        deviceId: selected.deviceId, clientOperationId: current.id, lines,
        ...(discount ? { discount } : {}), payments: total === '0.00' ? [] : payments,
        quoteFingerprint: quote.data.quoteFingerprint,
        ...(priceChange && accepted ? { previousKey: priceChange.previousKey,
          acceptedPriceChange: true as const } : {}) }, current.key);
      operation.current = null; setPriceChange(null); setAccepted(false);
      onConfirmed(sale);
    } catch (cause) {
      const problem = cause instanceof ApiProblemError ? cause : new ApiProblemError({ status: 0,
        code: 'SALE_CONFIRM_FAILED', message: 'No pudimos confirmar la venta. Intentá nuevamente.' });
      if (problem.code === 'PRICE_CHANGED') {
        setPriceChange({ previousKey: current.key, currentTotal: problem.currentTotal ?? '—' });
        setAccepted(false); operation.current = null;
        await quote.refetch();
      }
      setError(problem);
    } finally { setBusy(false); }
  }
  return <section className={styles.panel} aria-labelledby="pos-checkout-heading">
    <h2 id="pos-checkout-heading">Cobro</h2>
    {!lines.length ? <p>Agregá productos al carrito para continuar.</p> : null}
    {quote.isPending && lines.length ? <p role="status">Consultando precios vigentes…</p> : null}
    {quote.error ? <ErrorSummary error={quote.error instanceof ApiProblemError ? quote.error : new ApiProblemError({ status: 0, code: 'QUOTE_FAILED', message: 'No pudimos calcular el total. Reintentá.' })} /> : null}
    {context.error ? <ErrorSummary error={context.error instanceof ApiProblemError ? context.error : new ApiProblemError({ status: 0, code: 'CONTEXT_FAILED', message: 'No pudimos cargar las cajas disponibles.' })} /> : null}
    {quote.data ? <div className={styles.totals} aria-live="polite">
      <ul className={styles.quoteLines} aria-label="Importes por ítem">
        {quote.data.quote.lines.map((line, index) => <li key={`${line.itemId}:${index}`}>
          <span>{items.find((item) => item.id === line.itemId)?.name ?? 'Ítem'} · {line.quantity} × {line.unitPrice}</span>
          <strong>{line.lineTotal} {quote.data.quote.currency}</strong>
        </li>)}
      </ul>
      <span>Subtotal <strong>{quote.data.quote.subtotal} {quote.data.quote.currency}</strong></span>
      <span>Descuento <strong>{quote.data.quote.discount}</strong></span>
      <span>Total <strong>{quote.data.quote.total} {quote.data.quote.currency}</strong></span>
    </div> : null}
    {role === 'OWNER' || role === 'ADMIN' ? <div className={styles.inlineFields}>
      <div><label htmlFor="discount-kind">Tipo de descuento</label><select id="discount-kind" value={discountKind}
        onChange={(event) => { setDiscountKind(event.target.value as 'PERCENTAGE' | 'FIXED'); resetAttempt(); }}>
        <option value="PERCENTAGE">Porcentaje</option><option value="FIXED">Importe fijo</option></select></div>
      <div><label htmlFor="discount-value">Descuento global</label><input id="discount-value" inputMode="decimal"
        value={discountValue} onChange={(event) => { setDiscountValue(event.target.value); resetAttempt(); }} /></div>
    </div> : null}
    <div><label htmlFor="checkout-session">Sesión de caja abierta</label><select id="checkout-session"
      value={selected?.id ?? ''} onChange={(event) => { setSessionId(event.target.value); resetAttempt(); }}>
      {context.data?.sessions.map((session) => <option key={session.id} value={session.id}>{session.registerName}</option>)}
    </select></div>
    {context.data && !context.data.sessions.length ? <p role="alert">No hay una sesión de caja abierta. Abrí una caja antes de vender.</p> : null}
    {total && total !== '0.00' ? <div className={styles.payments}>
      <h3>Pagos</h3>
      {payments.map((payment, index) => <div key={index} className={styles.paymentRow}>
        <div><label htmlFor={`method-${index}`}>Medio de pago {index + 1}</label><select id={`method-${index}`}
          value={payment.method} onChange={(event) => updatePayments(payments.map((entry, position) =>
            position === index ? { method: event.target.value, appliedAmount: entry.appliedAmount } : entry))}>
          {context.data?.paymentMethods.map((method) => <option key={method} value={method}>{method}</option>)}
        </select></div>
        <div><label htmlFor={`applied-${index}`}>Importe aplicado {index + 1}</label><input id={`applied-${index}`}
          inputMode="decimal" value={payment.appliedAmount} onChange={(event) => updatePayments(payments.map((entry, position) =>
            position === index ? { ...entry, appliedAmount: event.target.value } : entry))} /></div>
        {payment.method === 'CASH' ? <div><label htmlFor={`received-${index}`}>Efectivo recibido {index + 1}</label>
          <input id={`received-${index}`} inputMode="decimal" value={payment.receivedAmount ?? ''}
            onChange={(event) => updatePayments(payments.map((entry, position) => position === index
              ? { ...entry, receivedAmount: event.target.value || undefined } : entry))} /></div> : null}
        <button type="button" onClick={() => updatePayments(payments.filter((_, position) => position !== index))}
          aria-label={`Quitar pago ${index + 1}`}>Quitar</button>
      </div>)}
      <button type="button" disabled={!context.data?.paymentMethods.length} onClick={() => updatePayments([...payments,
        { method: context.data?.paymentMethods[0] ?? 'CASH', appliedAmount: payments.length ? '0.00' : total }])}>
        Agregar pago</button>
      <p aria-live="polite">Vuelto: {balance?.change ?? '0.00'} {quote.data?.quote.currency}</p>
      {balance && !balance.valid ? <p role="alert" className={styles.error}>{balance.reason}</p> : null}
    </div> : total === '0.00' ? <p>Venta sin cargo: se confirma sin pagos.</p> : null}
    {error ? <ErrorSummary error={error} /> : null}
    {priceChange ? <div className={styles.priceChange} role="group" aria-label="Precio actualizado">
      <p>El precio cambió. Nuevo total del servidor: <strong>{priceChange.currentTotal} {quote.data?.quote.currency}</strong>. Ajustá los pagos para cubrirlo y aceptá el nuevo importe antes de reintentar.</p>
      <label><input type="checkbox" checked={accepted} onChange={(event) => setAccepted(event.target.checked)} /> Acepto el precio actualizado</label>
    </div> : null}
    <button className={`${styles.primary} ${styles.checkoutAction}`} type="button" disabled={busy || !selected || !quote.data ||
      !balance?.valid || !!quote.error || (!!priceChange && !accepted)} onClick={() => void submit()}>
      {busy ? 'Confirmando…' : 'Confirmar venta'}</button>
  </section>;
}
