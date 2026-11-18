'use client';

import { formatStockQuantity } from '../../lib/format-stock-quantity';

import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { subtractMoney } from '@uconext/shared';

import { ErrorSummary } from '../../components/error-summary';
import { ApiProblemError } from '../../lib/api/client';
import type { CatalogReadData } from '../catalog/catalog-read';
import type { CartLine } from './pos-cart';
import { accountPaymentBalance, normalizePayments, paymentBalance, type PosPayment } from './pos-payment-rules';
import { formatMoney, paymentMethodLabel } from '../../lib/format';
import { loadCustomers } from '../customers/customer-management';
import { formatAccountAmount, loadCustomerAccount } from '../customers/customer-account-api';
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
  const [customerId, setCustomerId] = useState('');
  const [onAccount, setOnAccount] = useState(false);
  const queryClient = useQueryClient();
  const [error, setError] = useState<ApiProblemError | null>(null);
  const [priceChange, setPriceChange] = useState<{ previousKey: string; currentTotal: string } | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const operation = useRef<{ key: string; input: Parameters<typeof confirmSale>[1] } | null>(null);
  const discount: SaleDiscount | undefined = discountValue.trim() && ['OWNER', 'ADMIN'].includes(role)
    ? { kind: discountKind, value: discountValue.trim() } : undefined;
  const context = useQuery({ queryKey: ['sale-checkout-context', organizationId, branchId],
    queryFn: () => loadCheckoutContext(organizationId, branchId) });
  const quote = useQuery({ queryKey: ['sale-quote', organizationId, branchId, lines, discount],
    queryFn: () => quoteSale(organizationId, branchId, lines, discount), enabled: lines.length > 0,
    retry: false, staleTime: 0 });
  const total = quote.data?.quote.total ?? null;
  const normalized = normalizePayments(payments);
  const creditBalance = total !== null && onAccount ? accountPaymentBalance(total, total === '0.00' ? [] : normalized) : null;
  const balance = creditBalance ?? (total === null ? null : paymentBalance(total, total === '0.00' ? [] : normalized));
  const customers = useQuery({ queryKey: ['customers', organizationId], queryFn: () => loadCustomers(organizationId), enabled: role !== 'EMPLOYEE' });
  const account = useQuery({ queryKey: ['customer-account', organizationId, customerId, branchId],
    queryFn: () => loadCustomerAccount(organizationId, customerId, branchId), enabled: onAccount && !!customerId, retry: false });
  const deferred = creditBalance?.deferred ?? '0.00';
  const exceedsLimit = !!account.data && subtractMoney(account.data.available, deferred).startsWith('-');
  const creditReady = recovering || !onAccount || (!!customerId && !!account.data && !account.error && !exceedsLimit);
  const selected = context.data?.sessions.find((session) => session.id === sessionId)
    ?? context.data?.sessions[0];
  const resetAttempt = () => { operation.current = null; setRecovering(false); setPriceChange(null); setAccepted(false); setError(null); };
  useEffect(() => { resetAttempt(); }, [lines, discountKind, discountValue, organizationId, branchId]);
  const updatePayments = (next: PosPayment[]) => {
    setPayments(next); operation.current = null; setRecovering(false); setAccepted(false); setError(null);
  };
  async function submit() {
    if (!quote.data || !selected || !balance?.valid || !creditReady || (priceChange && !accepted)) return;
    setBusy(true); setError(null);
    const current = operation.current ?? { key: crypto.randomUUID(), input: { branchId, cashSessionId: selected.id,
      deviceId: selected.deviceId, clientOperationId: crypto.randomUUID(), lines,
      ...(discount ? { discount } : {}), payments: total === '0.00' ? [] : normalized,
      ...(customerId ? { customerId } : {}), ...(onAccount ? { onAccount: true } : {}),
      quoteFingerprint: quote.data.quoteFingerprint,
      ...(priceChange && accepted ? { previousKey: priceChange.previousKey, acceptedPriceChange: true as const } : {}) } };
    operation.current = current;
    try {
      const sale = await confirmSale(organizationId, current.input, current.key);
      operation.current = null; setRecovering(false); setPriceChange(null); setAccepted(false);
      await queryClient.invalidateQueries({ queryKey: ['customer-account', organizationId] });
      await queryClient.invalidateQueries({ queryKey: ['customers', organizationId] });
      onConfirmed(sale);
    } catch (cause) {
      const problem = cause instanceof ApiProblemError ? cause : new ApiProblemError({ status: 0,
        code: 'SALE_CONFIRM_FAILED', message: 'No pudimos confirmar la venta. Intentá nuevamente.' });
      setRecovering(problem.status === 0 || problem.code === 'INVALID_RESPONSE');
      if (problem.code === 'PRICE_CHANGED') {
        setPriceChange({ previousKey: current.key, currentTotal: problem.currentTotal ?? '—' });
        setAccepted(false); operation.current = null;
        await quote.refetch();
      }
      setError(problem);
    } finally { setBusy(false); }
  }
  const currency = quote.data?.quote.currency ?? 'ARS';
  const money = (value: string) => formatMoney(value, currency);
  const methods = context.data?.paymentMethods ?? [];
  const sessions = context.data?.sessions ?? [];
  const optionsOpen = !!customerId || onAccount || !!discountValue.trim();
  const payAll = (method: string) => { if (total) updatePayments([{ method, appliedAmount: total }]); };
  return <section className={`${styles.panel} ${styles.checkout}`} aria-labelledby="pos-checkout-heading">
    <h2 id="pos-checkout-heading">Cobro</h2>
    {context.error ? <ErrorSummary error={context.error instanceof ApiProblemError ? context.error : new ApiProblemError({ status: 0, code: 'CONTEXT_FAILED', message: 'No pudimos cargar las cajas disponibles.' })} /> : null}
    {sessions.length > 1 ? <div className={styles.field}><label htmlFor="checkout-session">Caja</label><select id="checkout-session"
      value={selected?.id ?? ''} onChange={(event) => { setSessionId(event.target.value); resetAttempt(); }}>
      {sessions.map((session) => <option key={session.id} value={session.id}>{session.registerName}</option>)}
    </select></div> : selected ? <p className={styles.register}>Caja: <strong>{selected.registerName}</strong></p> : null}
    {context.data && !sessions.length ? <p role="alert" className={styles.warning}>No hay una caja abierta. Abrí un turno antes de vender.{' '}
      <a href="/workspace/cash-sessions">Abrir turno de caja</a></p> : null}
    {!lines.length ? <p className={styles.empty}>Agregá productos al carrito para cobrar.</p> : null}
    {quote.isPending && lines.length ? <p role="status">Calculando el total…</p> : null}
    {quote.error ? <ErrorSummary error={quote.error instanceof ApiProblemError ? quote.error : new ApiProblemError({ status: 0, code: 'QUOTE_FAILED', message: 'No pudimos calcular el total. Reintentá.' })} /> : null}
    {quote.data ? <div className={styles.totals} aria-live="polite">
      <p className={styles.grandTotal}><span>Total</span><strong data-total>{money(quote.data.quote.total)}</strong></p>
      <details className={styles.breakdown}><summary>Ver detalle</summary>
        <ul className={styles.quoteLines} aria-label="Importes por ítem">
          {quote.data.quote.lines.map((line, index) => <li key={`${line.itemId}:${index}`}>
            <span>{items.find((item) => item.id === line.itemId)?.name ?? 'Ítem'} · {formatStockQuantity(line.quantity)} × {money(line.unitPrice)}</span>
            <strong>{money(line.lineTotal)}</strong>
          </li>)}
        </ul>
        <p>Subtotal <strong>{money(quote.data.quote.subtotal)}</strong></p>
        <p>Descuento <strong>{money(quote.data.quote.discount)}</strong></p>
      </details>
    </div> : null}
    {total && total !== '0.00' ? <div className={styles.payments}>
      <h3>¿Cómo paga?</h3>
      <div className={styles.methodButtons} role="group" aria-label="Cobrar el total con un medio">
        {methods.map((method) => <button key={method} type="button" aria-label={`Cobrar todo con ${paymentMethodLabel(method)}`}
          aria-pressed={payments.length === 1 && payments[0]?.method === method} onClick={() => payAll(method)}>
          {paymentMethodLabel(method)}</button>)}
      </div>
      {payments.map((payment, index) => <div key={index} className={styles.paymentRow}>
        <div><label htmlFor={`method-${index}`}>Medio de pago {index + 1}</label><select id={`method-${index}`}
          value={payment.method} onChange={(event) => updatePayments(payments.map((entry, position) =>
            position === index ? { method: event.target.value, appliedAmount: entry.appliedAmount } : entry))}>
          {methods.map((method) => <option key={method} value={method}>{paymentMethodLabel(method)}</option>)}
        </select></div>
        <div><label htmlFor={`applied-${index}`}>Importe aplicado {index + 1}</label><input id={`applied-${index}`}
          inputMode="decimal" value={payment.appliedAmount} onChange={(event) => updatePayments(payments.map((entry, position) =>
            position === index ? { ...entry, appliedAmount: event.target.value } : entry))} /></div>
        {payment.method === 'CASH' ? <div><label htmlFor={`received-${index}`}>Efectivo recibido {index + 1}</label>
          <input id={`received-${index}`} inputMode="decimal" value={payment.receivedAmount ?? ''} placeholder="Ej.: 5.000"
            onChange={(event) => updatePayments(payments.map((entry, position) => position === index
              ? { ...entry, receivedAmount: event.target.value || undefined } : entry))} /></div> : null}
        <button type="button" className={styles.remove} onClick={() => updatePayments(payments.filter((_, position) => position !== index))}
          aria-label={`Quitar pago ${index + 1}`}>Quitar</button>
      </div>)}
      <button type="button" className={styles.secondary} disabled={!methods.length} onClick={() => updatePayments([...payments,
        { method: methods[0] ?? 'CASH', appliedAmount: payments.length ? '0.00' : total }])}>
        Agregar pago</button>
      <p aria-live="polite" className={styles.change}>Vuelto: {money(balance?.change ?? '0.00')}</p>
      {balance && !balance.valid && payments.length ? <p role="alert" className={styles.error}>{balance.reason}</p> : null}
    </div> : total === '0.00' ? <p>Venta sin cargo: se confirma sin pagos.</p> : null}
    {role !== 'EMPLOYEE' ? <details className={styles.options} open={optionsOpen || undefined}>
      <summary>Cliente, fiado o descuento</summary>
      {role === 'OWNER' || role === 'ADMIN' ? <div className={styles.inlineFields}>
        <div><label htmlFor="discount-kind">Tipo de descuento</label><select id="discount-kind" value={discountKind}
          onChange={(event) => { setDiscountKind(event.target.value as 'PERCENTAGE' | 'FIXED'); resetAttempt(); }}>
          <option value="PERCENTAGE">Porcentaje</option><option value="FIXED">Importe fijo</option></select></div>
        <div><label htmlFor="discount-value">Descuento global</label><input id="discount-value" inputMode="decimal"
          value={discountValue} onChange={(event) => { setDiscountValue(event.target.value); resetAttempt(); }} /></div>
      </div> : null}
      <div className={styles.field}><label htmlFor="checkout-customer">Cliente de la venta</label>
        <select id="checkout-customer" value={customerId} disabled={busy} onChange={event => { setCustomerId(event.target.value); resetAttempt(); }}>
          <option value="">Consumidor final</option>
          {customers.data?.filter(customer => customer.status === 'ACTIVE').map(customer => <option key={customer.id} value={customer.id}>{customer.name}</option>)}
        </select>
        {customers.isPending ? <p role="status">Cargando clientes…</p> : null}
        {customers.error ? <p role="alert">No pudimos cargar clientes. <button type="button" onClick={() => void customers.refetch()}>Reintentar clientes</button></p> : null}
      </div>
      {total && total !== '0.00' ? <><label className={styles.accountToggle}><input type="checkbox" checked={onAccount} disabled={busy}
        onChange={event => { setOnAccount(event.target.checked); resetAttempt(); }} /> A cuenta del cliente</label>
        {onAccount ? <div className={styles.accountSummary} aria-live="polite">
          <p>Podés cobrar una parte o dejar toda la compra fiada. Requiere conexión.</p>
          {!customerId ? <p>Elegí un cliente para usar su cuenta.</p> : account.isPending ? <p role="status">Consultando crédito…</p> : null}
          {account.error ? <p role="alert">No pudimos consultar la cuenta. <button type="button" onClick={() => void account.refetch()}>Reintentar cuenta</button></p> : null}
          {account.data ? <><p>Deuda actual: <strong>{formatAccountAmount(account.data.balance, account.data.currency)}</strong></p>
            <p>Crédito disponible: <strong>{formatAccountAmount(account.data.available, account.data.currency)}</strong></p>
            <p>A cuenta en esta venta: <strong>{formatAccountAmount(deferred, account.data.currency)}</strong></p></> : null}
          {exceedsLimit && !recovering ? <p role="alert">La compra supera el crédito disponible. Cobrá una parte o pedí que modifiquen el tope.</p> : null}
        </div> : null}</> : null}
    </details> : null}
    {error ? <ErrorSummary error={error} /> : null}
    {recovering ? <p>Reintentá para recuperar el resultado de esta venta. Se conservaron los datos originales.</p> : null}
    {priceChange ? <div className={styles.priceChange} role="group" aria-label="Precio actualizado">
      <p>El precio cambió. Nuevo total del servidor: <strong>{/^\d+\.\d{2}$/.test(priceChange.currentTotal) ? money(priceChange.currentTotal) : priceChange.currentTotal}</strong>. Ajustá los pagos para cubrirlo y aceptá el nuevo importe antes de reintentar.</p>
      <label><input type="checkbox" checked={accepted} onChange={(event) => setAccepted(event.target.checked)} /> Acepto el precio actualizado</label>
    </div> : null}
    <div className={styles.confirmBar}>
      {quote.data ? <p className={styles.confirmTotal} aria-hidden="true">{money(quote.data.quote.total)}</p> : null}
      <button className={`${styles.primary} ${styles.checkoutAction}`} type="button" disabled={busy || !selected || !quote.data ||
        !balance?.valid || !creditReady || !!quote.error || (!!priceChange && !accepted)} onClick={() => void submit()}>
        {busy ? 'Confirmando…' : 'Confirmar venta'}</button>
    </div>
  </section>;
}
