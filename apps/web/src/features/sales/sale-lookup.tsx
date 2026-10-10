'use client';
import { OrganizationTime } from '../../components/organization-time';

import { useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { ErrorSummary } from '../../components/error-summary';
import { ApiProblemError } from '../../lib/api/client';
import { cancelSale, loadCheckoutContext, loadSaleDetail } from './sales-api';
import { ReceiptActions } from './receipt-actions';
import styles from './pos.module.css';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function SaleLookup({ organizationId, branchId, role }: {
  organizationId: string; branchId: string;
  role: 'OWNER' | 'ADMIN' | 'CASHIER' | 'EMPLOYEE';
}) {
  const [typedId, setTypedId] = useState('');
  const [id, setId] = useState('');
  const [reason, setReason] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [error, setError] = useState<ApiProblemError | null>(null);
  const [busy, setBusy] = useState(false);
  const key = useRef<string | null>(null);
  const queryClient = useQueryClient();
  const detail = useQuery({ queryKey: ['sale-detail', organizationId, id],
    queryFn: () => loadSaleDetail(organizationId, id), enabled: !!id, retry: false });
  const sale = detail.data?.branchId === branchId ? detail.data : null;
  const needsCash = sale?.payments.some((payment) => payment.method === 'CASH') ?? false;
  const sessions = useQuery({ queryKey: ['sale-checkout-context', organizationId, branchId],
    queryFn: () => loadCheckoutContext(organizationId, branchId),
    enabled: !!sale?.canCancel && needsCash });
  const selected = sessions.data?.sessions.find((session) => session.id === sessionId)
    ?? sessions.data?.sessions[0];
  const canCancel = (role === 'OWNER' || role === 'ADMIN') && !!sale?.canCancel;
  const problem = (cause: unknown) => cause instanceof ApiProblemError ? cause
    : new ApiProblemError({ status: 0, code: 'SALE_LOOKUP_FAILED',
      message: 'No pudimos completar la consulta. Intentá nuevamente.' });
  const search = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setError(null); setReason(''); key.current = null;
    if (!uuid.test(typedId.trim())) {
      setError(new ApiProblemError({ status: 400, code: 'SALE_ID_INVALID',
        message: 'Ingresá un ID de venta válido, como el del comprobante.' }));
      return;
    }
    setId(typedId.trim());
  };
  async function cancel() {
    if (!sale || !canCancel || !reason.trim() || (needsCash && !selected)) return;
    setBusy(true); setError(null);
    const currentKey = key.current ?? crypto.randomUUID(); key.current = currentKey;
    try {
      await cancelSale(organizationId, sale.id, { reason: reason.trim(),
        ...(needsCash && selected ? { cashSessionId: selected.id, deviceId: selected.deviceId } : {}) }, currentKey);
      key.current = null; setReason('');
      await queryClient.invalidateQueries({ queryKey: ['sale-detail', organizationId, sale.id] });
    } catch (cause) { setError(problem(cause)); }
    finally { setBusy(false); }
  }
  return <section className={styles.page}>
    <header><h1>Consultar venta</h1><p>Buscá una venta por el ID que figura en su comprobante.</p></header>
    <form className={styles.panel} onSubmit={search}>
      <label htmlFor="sale-id">ID de venta</label>
      <div className={styles.inlineFields}><input id="sale-id" value={typedId}
        onChange={(event) => setTypedId(event.target.value)} autoComplete="off" />
      <button type="submit">Consultar venta</button></div>
    </form>
    {detail.isPending && id ? <p role="status">Cargando venta…</p> : null}
    {detail.error ? <ErrorSummary error={problem(detail.error)} /> : null}
    {error ? <ErrorSummary error={error} /> : null}
    {detail.data && !sale ? <p role="alert">La venta corresponde a otra sucursal. Seleccioná esa sucursal para consultarla.</p> : null}
    {sale ? <section className={styles.panel} aria-labelledby="sale-detail-heading">
      <h2 id="sale-detail-heading">Venta {sale.id}</h2>
      <p><strong>Estado:</strong> {sale.status === 'CANCELLED' ? 'Anulada' : 'Confirmada'}</p>
      <p><strong>Total:</strong> {sale.total} {sale.currency}</p>
      <p><strong>Confirmada:</strong> <OrganizationTime value={sale.confirmedAt} /></p>
      <h3>Ítems</h3><ul className={styles.detailList}>{sale.items.map((item, index) => <li key={index}>
        {item.name} · {item.quantity} × {item.unitPrice} = {item.lineTotal}</li>)}</ul>
      <h3>Pagos originales</h3><ul className={styles.detailList}>{sale.payments.map((payment, index) =>
        <li key={index}>{payment.method}: {payment.amount}{payment.change !== '0.00'
          ? ` · Vuelto ${payment.change}` : ''}</li>)}</ul>
      {sale.cancellation ? <p role="status"><strong>Anulación:</strong> {sale.cancellation.reason}
        {' · '}<OrganizationTime value={sale.cancellation.cancelledAt} /></p> : null}
      <ReceiptActions organizationId={organizationId} saleId={sale.id} />
      {canCancel ? <div className={styles.cancellation}>
        <h3>Anular venta</h3>
        <label htmlFor="sale-cancel-reason">Motivo de anulación</label>
        <textarea id="sale-cancel-reason" maxLength={500} value={reason}
          onChange={(event) => { setReason(event.target.value); key.current = null; }} />
        {needsCash ? <><label htmlFor="sale-refund-session">Sesión para reintegrar efectivo</label>
          <select id="sale-refund-session" value={selected?.id ?? ''}
            onChange={(event) => { setSessionId(event.target.value); key.current = null; }}>
            {sessions.data?.sessions.map((session) => <option key={session.id} value={session.id}>
              {session.registerName}</option>)}</select>
          {sessions.data && !sessions.data.sessions.length ? <p role="alert">Abrí una sesión válida en esta sucursal antes de reintegrar efectivo.</p> : null}
          {sessions.error ? <ErrorSummary error={problem(sessions.error)} /> : null}</> : null}
        <button className={styles.danger} type="button" disabled={busy || !reason.trim() ||
          (needsCash && !selected)} onClick={() => void cancel()}>
          {busy ? 'Anulando…' : 'Anular venta'}</button>
      </div> : null}
    </section> : null}
  </section>;
}
