'use client';

import { useRef, useState, type FormEvent } from 'react';

import { ErrorSummary } from '../../components/error-summary';
import { ApiProblemError } from '../../lib/api/client';
import { cancelPurchase, loadPurchase, payPurchase, type PurchaseDetail } from './purchases-api';
import styles from '../identity/management.module.css';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function PurchaseLookup({ organizationId, branchId, role, paymentMethods, sessions,
  onLoad = loadPurchase, onPay = payPurchase, onCancel = cancelPurchase }: {
  organizationId: string; branchId: string; role: 'OWNER' | 'ADMIN' | 'EMPLOYEE';
  paymentMethods: readonly string[];
  sessions: readonly { id: string; deviceId: string; registerName: string }[];
  onLoad?: typeof loadPurchase; onPay?: typeof payPurchase; onCancel?: typeof cancelPurchase;
}) {
  const [typedId, setTypedId] = useState('');
  const [purchase, setPurchase] = useState<PurchaseDetail | null>(null);
  const [reason, setReason] = useState('');
  const [method, setMethod] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiProblemError | null>(null);
  const key = useRef<string | null>(null);
  const selectedSession = sessions.find((session) => session.id === sessionId);
  const needsCashOnCancel = purchase?.payment?.method === 'CASH';
  const owner = role === 'OWNER' || role === 'ADMIN';
  function problem(cause: unknown): ApiProblemError {
    return cause instanceof ApiProblemError ? cause : new ApiProblemError({ status: 0,
      code: 'PURCHASE_LOOKUP_FAILED', message: 'No pudimos completar la operación. Intentá nuevamente.' });
  }
  async function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(null); setPurchase(null); key.current = null;
    if (!uuid.test(typedId.trim())) {
      setError(new ApiProblemError({ status: 400, code: 'PURCHASE_ID_INVALID',
        message: 'Ingresá un ID de compra válido.' }));
      return;
    }
    setBusy(true);
    try {
      const result = await onLoad(organizationId, typedId.trim());
      if (result.branchId !== branchId) {
        setError(new ApiProblemError({ status: 403, code: 'PURCHASE_BRANCH_MISMATCH',
          message: 'La compra pertenece a otra sucursal. Seleccioná esa sucursal para consultarla.' }));
      } else setPurchase(result);
    } catch (cause) { setError(problem(cause)); }
    finally { setBusy(false); }
  }
  async function performPay() {
    if (!purchase || purchase.status !== 'PENDING_PAYMENT' || !owner || !method
      || method === 'CASH' && !selectedSession) return;
    setBusy(true); setError(null);
    const operationKey = key.current ?? crypto.randomUUID(); key.current = operationKey;
    try {
      await onPay(organizationId, purchase.id, { method, amount: purchase.total,
        ...(method === 'CASH' && selectedSession
          ? { cashSessionId: selectedSession.id, deviceId: selectedSession.deviceId } : {}) }, operationKey);
      setPurchase(await onLoad(organizationId, purchase.id)); key.current = null;
    } catch (cause) { setError(problem(cause)); }
    finally { setBusy(false); }
  }
  async function performCancel() {
    if (!purchase || !owner || purchase.status === 'CANCELLED' || !reason.trim()
      || needsCashOnCancel && !selectedSession) return;
    setBusy(true); setError(null);
    const operationKey = key.current ?? crypto.randomUUID(); key.current = operationKey;
    try {
      await onCancel(organizationId, purchase.id, { reason: reason.trim(),
        ...(needsCashOnCancel && selectedSession
          ? { cashSessionId: selectedSession.id, deviceId: selectedSession.deviceId } : {}) }, operationKey);
      setPurchase(await onLoad(organizationId, purchase.id)); key.current = null; setReason('');
    } catch (cause) { setError(problem(cause)); }
    finally { setBusy(false); }
  }
  return <section className={styles.page} aria-labelledby="purchase-lookup-heading">
    <header className={styles.heading}><h1 id="purchase-lookup-heading">Consultar compra</h1>
      <p>Consultá el documento histórico por su ID y completá las acciones disponibles.</p></header>
    <form className={styles.panel} onSubmit={(event) => void search(event)}>
      <label htmlFor="purchase-id">ID de compra</label><input id="purchase-id" value={typedId}
        onChange={(event) => setTypedId(event.target.value)} autoComplete="off" />
      <button type="submit" disabled={busy}>Consultar compra</button></form>
    <ErrorSummary error={error} />
    {purchase ? <section className={styles.panel} aria-label="Detalle de compra">
      <h2>Compra {purchase.id}</h2>
      <p><strong>Estado:</strong> {purchase.status === 'CANCELLED' ? 'Anulada'
        : purchase.status === 'PAID' ? 'Pagada' : 'Pendiente de pago'}</p>
      <p><strong>Proveedor:</strong> {purchase.supplierName}</p>
      <p><strong>Total:</strong> {purchase.total} {purchase.currency}</p>
      <p><strong>Confirmada:</strong> {new Date(purchase.confirmedAt).toLocaleString('es-AR')}</p>
      <h3>Productos y costos de esta compra</h3><ul className={styles.rows}>
        {purchase.items.map((item, index) => <li key={index}>{item.itemName} · {item.quantity} × {item.unitCost} = {item.lineTotal}</li>)}
      </ul>
      {purchase.payment ? <p><strong>Pago histórico:</strong> {purchase.payment.method} · {purchase.payment.amount}</p> : null}
      {purchase.cancellation ? <p role="status"><strong>Anulación:</strong> {purchase.cancellation.reason}
        {' · '}{new Date(purchase.cancellation.cancelledAt).toLocaleString('es-AR')}</p> : null}
      {owner && purchase.status === 'PENDING_PAYMENT' && purchase.total === '0.00'
        ? <p role="status">Esta recepción tiene total cero y no admite un pago. Si se confirmó por error, podés anularla.</p>
        : null}
      {owner && purchase.status === 'PENDING_PAYMENT' && purchase.total !== '0.00' ? <div className={styles.fields}>
        <div><label htmlFor="purchase-pay-method">Medio de pago</label><select id="purchase-pay-method"
          value={method} onChange={(event) => { setMethod(event.target.value); key.current = null; }}>
          <option value="">Seleccioná un medio</option>{paymentMethods.map((entry) => <option key={entry} value={entry}>{entry}</option>)}</select></div>
        {method === 'CASH' ? <div><label htmlFor="purchase-pay-session">Sesión de caja</label>
          <select id="purchase-pay-session" value={sessionId} onChange={(event) => { setSessionId(event.target.value); key.current = null; }}>
            <option value="">Seleccioná una sesión</option>{sessions.map((entry) => <option key={entry.id} value={entry.id}>{entry.registerName}</option>)}</select>
          {!sessions.length ? <p role="alert">Abrí una sesión válida en esta sucursal para pagar en efectivo.</p> : null}</div> : null}
        <div><p>Pago exacto: {purchase.total} {purchase.currency}</p><button type="button"
          disabled={busy || !method || method === 'CASH' && !selectedSession} onClick={() => void performPay()}>
          {busy ? 'Pagando…' : 'Pagar compra'}</button></div></div> : null}
      {owner && purchase.status !== 'CANCELLED' ? <div>
        <h3>Anulación total</h3><label htmlFor="purchase-cancel-reason">Motivo de anulación</label>
        <textarea id="purchase-cancel-reason" maxLength={500} value={reason}
          onChange={(event) => { setReason(event.target.value); key.current = null; }} />
        {needsCashOnCancel ? <><label htmlFor="purchase-return-session">Sesión para devolver efectivo</label>
          <select id="purchase-return-session" value={sessionId} onChange={(event) => { setSessionId(event.target.value); key.current = null; }}>
            <option value="">Seleccioná una sesión</option>{sessions.map((entry) => <option key={entry.id} value={entry.id}>{entry.registerName}</option>)}</select>
          {!sessions.length ? <p role="alert">Abrí una sesión válida antes de devolver efectivo.</p> : null}</> : null}
        <button type="button" disabled={busy || !reason.trim() || needsCashOnCancel && !selectedSession}
          onClick={() => void performCancel()}>{busy ? 'Anulando…' : 'Anular compra'}</button></div> : null}
    </section> : null}
  </section>;
}
