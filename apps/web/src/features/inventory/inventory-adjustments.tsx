'use client';

import { useState } from 'react';

import { ErrorSummary } from '../../components/error-summary';
import { ApiProblemError } from '../../lib/api/client';
import { compensateAdjustment, confirmAdjustment, type Adjustment, type StockItem } from './inventory-api';
import styles from '../identity/management.module.css';

const reasons = [
  ['CONTEO_FISICO', 'Conteo físico'], ['ROTURA', 'Rotura'], ['PERDIDA', 'Pérdida'],
  ['VENCIMIENTO', 'Vencimiento'], ['CORRECCION', 'Corrección'], ['OTRO', 'Otro'],
] as const;
const reasonLabels: Record<string, string> = Object.fromEntries([
  ['INVENTARIO_INICIAL', 'Inventario inicial'], ...reasons,
]);
const decimal = /^(?:0|[1-9]\d{0,16})(?:\.\d{1,3})?$/;
type Role = 'OWNER' | 'ADMIN' | 'EMPLOYEE' | 'CASHIER';

export function InventoryAdjustments({ organizationId, branchId, role, stocks, adjustments, nextCursor,
  onReload, onLoadMore, onLoadMoreStocks, onConfirm = confirmAdjustment, onCompensate = compensateAdjustment }: {
  organizationId: string; branchId: string; role: Role; stocks: StockItem[]; adjustments: Adjustment[];
  nextCursor: string | null; onReload: () => void; onLoadMore?: () => void; onLoadMoreStocks?: () => void;
  onConfirm?: typeof confirmAdjustment; onCompensate?: typeof compensateAdjustment;
}) {
  const [itemId, setItemId] = useState(stocks[0]?.itemId ?? '');
  const [direction, setDirection] = useState<'INCREASE' | 'DECREASE'>('INCREASE');
  const [quantity, setQuantity] = useState('');
  const [reason, setReason] = useState<string>('CONTEO_FISICO');
  const [observation, setObservation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiProblemError | null>(null);
  const [message, setMessage] = useState('');
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const selected = stocks.find((stock) => stock.itemId === itemId);
  const quantityError = error?.fieldErrors.quantity;
  const itemError = error?.fieldErrors.itemId;
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setError(null); setMessage('');
    if (!selected || !decimal.test(quantity) || /^0(?:\.0+)?$/.test(quantity)
      || (selected.baseUnit === 'UNIT' && quantity.includes('.'))) {
      const field = selected ? 'quantity' : 'itemId';
      const fieldMessage = !selected ? 'Seleccioná un producto.' : selected.baseUnit === 'UNIT'
        ? 'La cantidad debe ser entera y mayor que cero.'
        : 'Ingresá una cantidad mayor que cero con hasta tres decimales.';
      setError(new ApiProblemError({ status: 400, code: 'INVALID_QUANTITY',
        message: fieldMessage, fieldErrors: { [field]: fieldMessage } })); return;
    }
    setBusy(true);
    try {
      await onConfirm(organizationId, { branchId, itemId, direction, quantity, reason,
        observation: observation.trim() || null });
      setMessage('Ajuste confirmado. El historial y el stock se actualizarán.');
      setQuantity(''); setObservation(''); onReload();
    } catch (cause) {
      const issue = problem(cause);
      setError(issue.code === 'INSUFFICIENT_STOCK' ? new ApiProblemError({ status: issue.status,
        code: issue.code, message: issue.message, traceId: issue.traceId,
        fieldErrors: { quantity: issue.message } }) : issue);
    }
    finally { setBusy(false); }
  }
  async function compensate(id: string) {
    setBusy(true); setError(null); setMessage('');
    try { await onCompensate(organizationId, id, null); setMessage('Ajuste compensatorio confirmado.'); setConfirmId(null); onReload(); }
    catch (cause) { setError(problem(cause)); }
    finally { setBusy(false); }
  }
  return <section className={styles.page} aria-labelledby="adjustment-heading">
    <header className={styles.heading}><h1 id="adjustment-heading">Ajustes de inventario</h1>
      <p>Registrá cambios con motivo. Los ajustes confirmados se corrigen con una compensación.</p></header>
    <p><a href="/workspace/inventory">Volver al stock</a></p>
    <ErrorSummary error={error} fieldIds={{ itemId: 'adjustment-item', quantity: 'adjustment-quantity' }}
      fieldLabels={{ itemId: 'Producto', quantity: 'Cantidad' }} />{message ? <p role="status">{message}</p> : null}
    {role === 'CASHIER' ? <p role="alert">Tu rol puede consultar stock, pero no confirmar ajustes.</p> :
      <form className={styles.panel} onSubmit={(event) => void submit(event)} noValidate>
        <h2>Nuevo ajuste</h2><div className={styles.fields}>
          <div><label htmlFor="adjustment-item">Producto</label><select id="adjustment-item" value={itemId}
            aria-invalid={!!itemError} aria-describedby={itemError ? 'adjustment-item-error' : undefined}
            onChange={(event) => setItemId(event.target.value)} required>
            {stocks.map((stock) => <option key={stock.itemId} value={stock.itemId}>{stock.itemName}</option>)}</select>
            {itemError ? <p id="adjustment-item-error">{itemError}</p> : null}</div>
          <div><label htmlFor="adjustment-direction">Tipo de ajuste</label><select id="adjustment-direction"
            value={direction} onChange={(event) => setDirection(event.target.value as 'INCREASE' | 'DECREASE')}>
            <option value="INCREASE">Ingreso</option><option value="DECREASE">Egreso</option></select></div>
          <div><label htmlFor="adjustment-quantity">Cantidad</label><input id="adjustment-quantity"
            type="text" inputMode="decimal" value={quantity} onChange={(event) => setQuantity(event.target.value)}
            aria-invalid={!!quantityError} aria-describedby={quantityError ? 'adjustment-quantity-error' : undefined} />
            {quantityError ? <p id="adjustment-quantity-error">{quantityError}</p> : null}
            <span>{selected?.baseUnit === 'UNIT' ? 'Unidades enteras.' : 'Hasta tres decimales.'}</span></div>
          <div><label htmlFor="adjustment-reason">Motivo</label><select id="adjustment-reason" value={reason}
            onChange={(event) => setReason(event.target.value)}>
            {(role === 'OWNER' || role === 'ADMIN' ? [['INVENTARIO_INICIAL', 'Inventario inicial'] as const, ...reasons] : reasons)
              .map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
          <div><label htmlFor="adjustment-observation">Observación (opcional)</label><input id="adjustment-observation"
            value={observation} maxLength={2000} onChange={(event) => setObservation(event.target.value)} /></div>
        </div><button type="submit" disabled={busy || !stocks.length}>{busy ? 'Confirmando…' : 'Confirmar ajuste'}</button>
        {onLoadMoreStocks ? <button type="button" onClick={onLoadMoreStocks}>Cargar más productos</button> : null}
      </form>}
    <section className={styles.panel} aria-label="Ajustes confirmados"><h2>Historial de ajustes</h2>
      {adjustments.length === 0 ? <p>No hay ajustes confirmados en esta sucursal.</p> :
        <ul className={styles.rows}>{adjustments.map((adjustment) => <li className={styles.row} key={adjustment.id}>
          <strong>{adjustment.itemName}</strong><span>{adjustment.direction === 'INCREASE' ? 'Ingreso' : 'Egreso'} de {adjustment.quantity} · {reasonLabels[adjustment.reason] ?? adjustment.reason}</span>
          <span>{adjustment.compensatedBy ? 'Compensado' : adjustment.compensates ? 'Compensación confirmada' : 'Confirmado'}</span>
          {adjustment.observation ? <p>{adjustment.observation}</p> : null}
          {role !== 'CASHIER' && !adjustment.compensatedBy && !adjustment.compensates ?
            confirmId === adjustment.id ? <div><p>Se creará un ajuste compensatorio. El original seguirá en el historial.</p>
              <div className={styles.actions}><button type="button" disabled={busy} onClick={() => void compensate(adjustment.id)}>Confirmar compensación de {adjustment.itemName}</button>
                <button type="button" onClick={() => setConfirmId(null)}>Cancelar</button></div></div>
              : <button type="button" disabled={busy} onClick={() => setConfirmId(adjustment.id)}>Compensar ajuste de {adjustment.itemName}</button> : null}
        </li>)}</ul>}
      {nextCursor && onLoadMore ? <button type="button" onClick={onLoadMore}>Cargar más ajustes</button> : null}
    </section>
  </section>;
}

function problem(cause: unknown): ApiProblemError {
  return cause instanceof ApiProblemError ? cause : new ApiProblemError({ status: 0,
    code: 'ADJUSTMENT_FAILED', message: 'No pudimos confirmar la operación. Intentá nuevamente.' });
}
