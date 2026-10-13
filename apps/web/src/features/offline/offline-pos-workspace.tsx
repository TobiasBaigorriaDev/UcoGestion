'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { offlineSaleQuoteSchema, saleCodeFromId } from '@uconext/shared';
import type { OfflinePosActions, OfflinePosWorkspaceData, OfflineReceipt } from '../../offline/offline-pos-actions';
import { observeRetirement } from '../../offline/identity-retirement-events';
import { PosCart, type CartLine } from '../sales/pos-cart';
import { paymentBalance, type PosPayment } from '../sales/pos-payment-rules';
import { SaleConfirmation } from '../sales/sale-confirmation';
import { ReceiptActions } from '../sales/receipt-actions';
import { OfflineReceiptActions } from '../sales/offline-receipt-actions';
import styles from '../sales/pos.module.css';

export function OfflinePosWorkspace({ controller, expired }: { controller: OfflinePosActions; expired: boolean }) {
  const [data, setData] = useState<OfflinePosWorkspaceData | null>(null);
  const [lines, setLines] = useState<readonly CartLine[]>([]);
  const [paymentInput, setPaymentInput] = useState<{ draftId: string; rows: PosPayment[] } | null>(null);
  const [registerId, setRegisterId] = useState('');
  const [opening, setOpening] = useState('0.00');
  const [revision, setRevision] = useState(0);
  const [sale, setSale] = useState<{ id: string; total: string } | null>(null);
  const [receipt, setReceipt] = useState<OfflineReceipt | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const running = useRef(false);
  const refresh = useCallback(async () => {
    const current = generation.current;
    const next = await controller.workspace();
    if (current === generation.current) setData(next);
    return next;
  }, [controller]);
  useEffect(() => {
    let live = true;
    const retire = () => { generation.current++; setData(null); setSale(null); setReceipt(null); setLines([]); setPaymentInput(null); setError(''); };
    const load = () => { void refresh().catch(() => { if (live) retire(); }); };
    const stop = observeRetirement(retire);
    load(); window.addEventListener('uco:delivery-state', load);
    return () => { live = false; generation.current++; stop(); window.removeEventListener('uco:delivery-state', load); };
  }, [refresh]);
  const draft = data?.draft ?? null;
  const quote = draft ? offlineSaleQuoteSchema.parse(draft.quote) : null;
  const payments: PosPayment[] = paymentInput?.draftId === draft?.id ? paymentInput?.rows ?? []
    : quote && quote.total !== '0.00' ? [{ method: data?.configuration.paymentMethods[0] ?? 'CASH', appliedAmount: quote.total }] : [];
  function setPayments(update: (current: PosPayment[]) => PosPayment[]) {
    if (draft) setPaymentInput({ draftId: draft.id, rows: update(payments) });
  }
  useEffect(() => {
    if (sale && data && !data.pendingSaleIds.includes(sale.id)) setReceipt(null);
  }, [sale, data]);
  async function run(operation: () => Promise<void>) {
    if (running.current) return;
    const current = generation.current;
    running.current = true; setBusy(true); setError('');
    try { await operation(); }
    catch (cause) {
      if (current === generation.current) setError(cause instanceof Error ? cause.message : 'No pudimos completar la operación. Reintentá con los mismos datos.');
    } finally { running.current = false; if (current === generation.current) setBusy(false); }
  }
  async function confirm() {
    if (!draft) return;
    const current = generation.current;
    const result = await controller.confirm({ draftId: draft.id, payments });
    if (current !== generation.current) return;
    setSale(result); setReceipt(null); setLines([]); setRevision(value => value + 1);
    const next = await refresh();
    if (current !== generation.current) return;
    if (next.pendingSaleIds.includes(result.id)) {
      const local = await controller.receipt(result.id);
      if (current === generation.current) setReceipt(local);
    }
  }
  async function viewReceipt(id: string) {
    const current = generation.current;
    const local = await controller.receipt(id);
    if (current !== generation.current) return;
    if (!local) { await refresh(); return; }
    setSale({ id: local.saleId, total: local.total }); setReceipt(local);
  }
  if (!data) return <p role="status">Desbloqueá tu identidad para operar y ver tus comprobantes locales.</p>;
  const canCreate = !expired && data.canCreate;
  const pendingSync = !!sale && data.pendingSaleIds.includes(sale.id);
  const balance = quote ? paymentBalance(quote.total, payments) : null;
  return <section className={styles.page} aria-label="Operación POS offline">
    {sale ? <SaleConfirmation saleId={sale.id} total={sale.total} pendingSync={pendingSync}>
      {receipt ? <OfflineReceiptActions key={receipt.saleId} receipt={receipt} /> : !pendingSync
        ? <ReceiptActions organizationId={data.organizationId} saleId={sale.id} /> : null}
    </SaleConfirmation> : null}
    {error ? <p role="alert" className={styles.error}>{error}</p> : null}
    {data.pendingSaleIds.length ? <section className={styles.panel} aria-label="Comprobantes pendientes">
      <h2>Comprobantes de ventas pendientes</h2>
      <ul>{data.pendingSaleIds.map(id => <li key={id}>
        <span className={styles.saleId}>{saleCodeFromId(id)}</span>{' '}
        <button type="button" disabled={busy} onClick={() => void run(() => viewReceipt(id))}>Ver comprobante de venta pendiente</button>
      </li>)}</ul>
    </section> : null}
    {!canCreate ? <p role="status">La autorización no permite nuevas operaciones. Tus pendientes siguen protegidos.</p>
      : !data.session ? <form className={styles.panel} onSubmit={event => { event.preventDefault(); void run(async () => {
        await controller.open({ cashRegisterId: registerId || data.configuration.cashRegisters[0]?.id || '', openingCash: opening }); await refresh();
      }); }}>
        <h2>Abrir caja sin conexión</h2>
        <label htmlFor="local-register">Caja</label><select id="local-register" value={registerId || data.configuration.cashRegisters[0]?.id || ''}
          onChange={event => setRegisterId(event.target.value)}>{data.configuration.cashRegisters.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select>
        <label htmlFor="local-opening">Efectivo inicial</label><input id="local-opening" inputMode="decimal" value={opening} onChange={event => setOpening(event.target.value)} />
        <button type="submit" disabled={busy || !data.configuration.cashRegisters.length}>Abrir caja sin conexión</button>
      </form> : draft && quote ? <section className={styles.panel} aria-label="Cobro offline">
        <h2>Cobro sin conexión</h2><p>Consumidor final · Total: {quote.total} {quote.currency}</p>
        <ul>{quote.lines.map((line, index) => <li key={index}>{line.itemName} · {line.quantity} × {line.unitPrice}</li>)}</ul>
        {payments.map((payment, index) => <div key={index} className={styles.paymentRow}>
          <div><label htmlFor={`local-method-${index}`}>Medio de pago {index + 1}</label>
            <select id={`local-method-${index}`} value={payment.method} disabled={busy} onChange={event => setPayments(current => current.map((row, position) => position === index
              ? { method: event.target.value, appliedAmount: row.appliedAmount } : row))}>
              {data.configuration.paymentMethods.map(method => <option key={method}>{method}</option>)}</select></div>
          <div><label htmlFor={`local-applied-${index}`}>Importe aplicado {index + 1}</label><input id={`local-applied-${index}`} inputMode="decimal" value={payment.appliedAmount} disabled={busy}
            onChange={event => setPayments(current => current.map((row, position) => position === index ? { ...row, appliedAmount: event.target.value } : row))} /></div>
          {payment.method === 'CASH' ? <div><label htmlFor={`local-received-${index}`}>Efectivo recibido {index + 1}</label><input id={`local-received-${index}`} inputMode="decimal" value={payment.receivedAmount ?? ''} disabled={busy}
            onChange={event => setPayments(current => current.map((row, position) => position === index ? { ...row, receivedAmount: event.target.value || undefined } : row))} /></div> : null}
          <button type="button" disabled={busy} aria-label={`Quitar pago ${index + 1}`} onClick={() => setPayments(current => current.filter((_, position) => position !== index))}>Quitar</button>
        </div>)}
        {quote.total !== '0.00' ? <button type="button" disabled={busy} onClick={() => setPayments(current => [...current, { method: data.configuration.paymentMethods[0] ?? 'CASH', appliedAmount: '0.00' }])}>Agregar pago</button> : <p>Venta sin cargo: se confirma sin pagos.</p>}
        <p aria-live="polite">Vuelto: {balance?.change ?? '0.00'} {quote.currency}</p>
        {balance && !balance.valid ? <p role="status">{balance.reason}</p> : null}
        <button type="button" className={styles.primary} disabled={busy || !balance?.valid} onClick={() => void run(confirm)}>{busy ? 'Confirmando…' : 'Confirmar venta sin conexión'}</button>
      </section> : <>
        <PosCart key={revision} items={data.configuration.items.map(item => ({ ...item, status: 'ACTIVE' as const }))} onLinesChange={setLines} />
        <div className={styles.panel}><p>Venta a consumidor final con el catálogo sincronizado.</p>
          <button type="button" disabled={busy || !lines.length} onClick={() => void run(async () => {
            await controller.prepare({ sessionId: data.session?.id, lines }); await refresh();
          })}>Preparar cobro sin conexión</button></div>
      </>}
  </section>;
}
