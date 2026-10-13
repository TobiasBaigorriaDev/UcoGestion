'use client';
import { OrganizationTime } from '../../components/organization-time';

import { useEffect, useRef, useState, type FormEvent } from 'react';

import { ErrorSummary } from '../../components/error-summary';
import { ApiProblemError } from '../../lib/api/client';
import { formatDashboardAmount } from '../insights/dashboard-presentation';
import { cancelPurchase, loadPurchase, payPurchase, type PurchaseDetail } from './purchases-api';
import styles from '../identity/management.module.css';
import workspaceStyles from './purchase-workspace.module.css';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function PurchaseLookup({ organizationId, branchId, role, paymentMethods, sessions,
  selectedId, onChanged, onLoad = loadPurchase, onPay = payPurchase, onCancel = cancelPurchase }: {
  organizationId: string; branchId: string; role: 'OWNER' | 'ADMIN' | 'EMPLOYEE';
  paymentMethods: readonly string[];
  sessions: readonly { id: string; deviceId: string; registerName: string }[];
  selectedId?: string | null; onChanged?: () => void;
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
  const detailRegion = useRef<HTMLElement>(null);
  const selectedSession = sessions.find((session) => session.id === sessionId);
  const needsCashOnCancel = purchase?.payment?.method === 'CASH';
  const owner = role === 'OWNER' || role === 'ADMIN';
  const canOperate = owner && purchase?.branchId === branchId;
  useEffect(() => { if (purchase?.id) detailRegion.current?.focus(); }, [purchase?.id]);
  useEffect(() => {
    setReason(''); setMethod(''); setSessionId(''); key.current = null;
    if (!selectedId) { setPurchase(null); setTypedId(''); return; }
    let active = true;
    setTypedId(selectedId); setPurchase(null); setError(null); setBusy(true);
    void onLoad(organizationId, selectedId).then(result => {
      if (active) setPurchase(result);
    }).catch(cause => { if (active) setError(cause instanceof ApiProblemError ? cause
      : new ApiProblemError({ status: 0, code: 'PURCHASE_LOOKUP_FAILED',
        message: 'No pudimos cargar la compra. Intentá nuevamente.' }));
    }).finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [organizationId, selectedId, onLoad]);
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
      if (result.branchId !== branchId && !owner) {
        setError(new ApiProblemError({ status: 403, code: 'PURCHASE_BRANCH_MISMATCH',
          message: 'La compra pertenece a otra sucursal. Seleccioná esa sucursal para consultarla.' }));
      } else setPurchase(result);
    } catch (cause) { setError(problem(cause)); }
    finally { setBusy(false); }
  }
  async function performPay() {
    if (!purchase || purchase.status !== 'PENDING_PAYMENT' || !canOperate || !method
      || method === 'CASH' && !selectedSession) return;
    setBusy(true); setError(null);
    const operationKey = key.current ?? crypto.randomUUID(); key.current = operationKey;
    try {
      await onPay(organizationId, purchase.id, { method, amount: purchase.total,
        ...(method === 'CASH' && selectedSession
          ? { cashSessionId: selectedSession.id, deviceId: selectedSession.deviceId } : {}) }, operationKey);
      onChanged?.();
      setPurchase(await onLoad(organizationId, purchase.id)); key.current = null;
    } catch (cause) { setError(problem(cause)); }
    finally { setBusy(false); }
  }
  async function performCancel() {
    if (!purchase || !canOperate || purchase.status === 'CANCELLED' || !reason.trim()
      || needsCashOnCancel && !selectedSession) return;
    setBusy(true); setError(null);
    const operationKey = key.current ?? crypto.randomUUID(); key.current = operationKey;
    try {
      await onCancel(organizationId, purchase.id, { reason: reason.trim(),
        ...(needsCashOnCancel && selectedSession
          ? { cashSessionId: selectedSession.id, deviceId: selectedSession.deviceId } : {}) }, operationKey);
      onChanged?.();
      setPurchase(await onLoad(organizationId, purchase.id)); key.current = null; setReason('');
    } catch (cause) { setError(problem(cause)); }
    finally { setBusy(false); }
  }
  return <section className={styles.page} aria-labelledby="purchase-lookup-heading">
    <header className={styles.heading}><h2 id="purchase-lookup-heading">Consultar compra</h2>
      <p>Consultá el documento histórico por su ID y completá las acciones disponibles.</p></header>
    <form className={styles.panel} onSubmit={(event) => void search(event)}>
      <label htmlFor="purchase-id">ID de compra</label><input id="purchase-id" value={typedId}
        onChange={(event) => setTypedId(event.target.value)} autoComplete="off" />
      <button type="submit" disabled={busy}>Consultar compra</button></form>
    <ErrorSummary error={error} />
    {purchase ? <section ref={detailRegion} tabIndex={-1}
      className={`${styles.panel} ${workspaceStyles.purchaseDetail}`} aria-label="Detalle de compra">
      <header className={workspaceStyles.detailHeader}>
        <div><h2>Detalle de compra</h2><p className={workspaceStyles.purchaseId}>ID {purchase.id}</p></div>
        <span className={workspaceStyles.statusBadge} data-status={purchase.status}>
          {purchase.status === 'CANCELLED' ? 'Anulada'
            : purchase.status === 'PAID' ? 'Pagada' : 'Pendiente de pago'}
        </span>
      </header>
      <dl className={workspaceStyles.detailSummary}>
        <div><dt>Proveedor</dt><dd>{purchase.supplierName}</dd></div>
        <div><dt>Confirmada</dt><dd><OrganizationTime value={purchase.confirmedAt} /></dd></div>
        <div className={workspaceStyles.totalSummary}><dt>Total de la compra</dt>
          <dd>{formatDashboardAmount(purchase.total)} <small>{purchase.currency}</small></dd></div>
      </dl>
      {owner && purchase.branchId !== branchId ? <p role="status" className={workspaceStyles.detailNotice}>Seleccioná la sucursal de esta compra para pagarla o anularla.</p> : null}
      <section className={workspaceStyles.detailSection} aria-labelledby="purchase-items-heading">
        <h3 id="purchase-items-heading">Productos y costos de esta compra</h3>
        <ul className={workspaceStyles.itemList} aria-label="Productos de la compra">
          {purchase.items.map((item, index) => <li key={index}>
            <strong>{item.itemName}</strong>
            <span>{item.quantity} × {formatDashboardAmount(item.unitCost)} {purchase.currency}</span>
            <span className={workspaceStyles.lineTotal}>{formatDashboardAmount(item.lineTotal)} {purchase.currency}</span>
          </li>)}
        </ul>
      </section>
      {purchase.payment ? <section className={workspaceStyles.detailSection} aria-label="Pago histórico">
        <h3>Pago histórico</h3><dl className={workspaceStyles.paymentSummary}>
          <div><dt>Medio</dt><dd>{purchase.payment.method}</dd></div>
          <div><dt>Importe</dt><dd>{formatDashboardAmount(purchase.payment.amount)} {purchase.currency}</dd></div>
        </dl></section> : null}
      {purchase.cancellation ? <section className={workspaceStyles.detailSection} aria-label="Anulación registrada">
        <h3>Anulación registrada</h3><p role="status">{purchase.cancellation.reason}</p>
        <p><OrganizationTime value={purchase.cancellation.cancelledAt} /></p>
      </section> : null}
      {canOperate && purchase.status === 'PENDING_PAYMENT' && purchase.total === '0.00'
        ? <p role="status">Esta recepción tiene total cero y no admite un pago. Si se confirmó por error, podés anularla.</p>
        : null}
      {canOperate && purchase.status === 'PENDING_PAYMENT' && purchase.total !== '0.00' ? <section className={workspaceStyles.detailSection} aria-labelledby="purchase-pay-heading">
        <h3 id="purchase-pay-heading">Registrar pago</h3><div className={styles.fields}>
        <div><label htmlFor="purchase-pay-method">Medio de pago</label><select id="purchase-pay-method"
          value={method} onChange={(event) => { setMethod(event.target.value); key.current = null; }}>
          <option value="">Seleccioná un medio</option>{paymentMethods.map((entry) => <option key={entry} value={entry}>{entry}</option>)}</select></div>
        {method === 'CASH' ? <div><label htmlFor="purchase-pay-session">Sesión de caja</label>
          <select id="purchase-pay-session" value={sessionId} onChange={(event) => { setSessionId(event.target.value); key.current = null; }}>
            <option value="">Seleccioná una sesión</option>{sessions.map((entry) => <option key={entry.id} value={entry.id}>{entry.registerName}</option>)}</select>
          {!sessions.length ? <p role="alert">Abrí una sesión válida en esta sucursal para pagar en efectivo.</p> : null}</div> : null}
        <div><p>Pago exacto: {formatDashboardAmount(purchase.total)} {purchase.currency}</p><button type="button"
          disabled={busy || !method || method === 'CASH' && !selectedSession} onClick={() => void performPay()}>
          {busy ? 'Pagando…' : 'Pagar compra'}</button></div></div></section> : null}
      {canOperate && purchase.status !== 'CANCELLED' ? <section className={`${workspaceStyles.detailSection} ${workspaceStyles.cancelSection}`}>
        <h3>Anulación total</h3><label htmlFor="purchase-cancel-reason">Motivo de anulación</label>
        <textarea id="purchase-cancel-reason" className={workspaceStyles.cancelReason}
          maxLength={500} value={reason}
          onChange={(event) => { setReason(event.target.value); key.current = null; }} />
        {needsCashOnCancel ? <><label htmlFor="purchase-return-session">Sesión para devolver efectivo</label>
          <select id="purchase-return-session" value={sessionId} onChange={(event) => { setSessionId(event.target.value); key.current = null; }}>
            <option value="">Seleccioná una sesión</option>{sessions.map((entry) => <option key={entry.id} value={entry.id}>{entry.registerName}</option>)}</select>
          {!sessions.length ? <p role="alert">Abrí una sesión válida antes de devolver efectivo.</p> : null}</> : null}
        <button type="button" disabled={busy || !reason.trim() || needsCashOnCancel && !selectedSession}
          onClick={() => void performCancel()}>{busy ? 'Anulando…' : 'Anular compra'}</button></section> : null}
    </section> : null}
  </section>;
}
