'use client';

import { formatStockQuantity } from '../../lib/format-stock-quantity';

import { useContext, useState } from 'react';
import { OrganizationTimezone } from '../../components/organization-time';

import { ErrorSummary } from '../../components/error-summary';
import { ApiProblemError } from '../../lib/api/client';
import { compensateAdjustment, confirmAdjustment, type Adjustment, type StockItem } from './inventory-api';
import styles from '../identity/management.module.css';
import adjustmentStyles from './inventory-adjustments.module.css';
import { EntityAction } from '../../components/entity-action';

const reasons = [
  ['CONTEO_FISICO', 'Conteo físico'], ['ROTURA', 'Rotura'], ['PERDIDA', 'Pérdida'],
  ['VENCIMIENTO', 'Vencimiento'], ['CORRECCION', 'Corrección'], ['OTRO', 'Otro'],
] as const;
const reasonLabels: Record<string, string> = Object.fromEntries([
  ['INVENTARIO_INICIAL', 'Inventario inicial'], ...reasons,
]);
const decimal = /^(?:0|[1-9]\d{0,16})(?:\.\d{1,3})?$/;
type Role = 'OWNER' | 'ADMIN' | 'EMPLOYEE' | 'CASHIER';

export function InventoryAdjustments({ timezone, compact = false, historyOnly = false, organizationId, branchId, role, stocks, adjustments, nextCursor,
  onReload, onLoadMore, onLoadMoreStocks, onConfirm = confirmAdjustment, onCompensate = compensateAdjustment }: {
  timezone?: string; compact?: boolean; historyOnly?: boolean; organizationId: string; branchId: string; role: Role; stocks: StockItem[]; adjustments: Adjustment[];
  nextCursor: string | null; onReload: () => void; onLoadMore?: () => void; onLoadMoreStocks?: () => void;
  onConfirm?: typeof confirmAdjustment; onCompensate?: typeof compensateAdjustment;
}) {
  const contextTimezone = useContext(OrganizationTimezone);
  const [search, setSearch] = useState('');
  const visibleAdjustments = adjustments.filter((adjustment) =>
    adjustment.itemName.toLocaleLowerCase('es').includes(search.trim().toLocaleLowerCase('es')));
  const [itemId, setItemId] = useState(stocks[0]?.itemId ?? '');
  const [direction, setDirection] = useState<'INCREASE' | 'DECREASE'>('INCREASE');
  const [quantity, setQuantity] = useState('');
  const [reason, setReason] = useState<string>('CONTEO_FISICO');
  const [observation, setObservation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiProblemError | null>(null);
  const [message, setMessage] = useState('');
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const fieldPrefix = compact ? `adjustment-${stocks[0]?.itemId ?? 'product'}` : 'adjustment';
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
  return <section className={styles.page} aria-label={compact ? "Cambiar stock" : undefined} aria-labelledby={compact ? undefined : "adjustment-heading"}>
    {!compact ? <><header className={styles.heading}><h1 id="adjustment-heading">{historyOnly ? "Historial de ajustes" : "Ajustes de inventario"}</h1>
      <p>Registrá cambios con motivo. Si te equivocaste, revertí el ajuste: queda registrado como un movimiento nuevo.</p></header>
    </> : null}
    <ErrorSummary error={error} fieldIds={{ itemId: `${fieldPrefix}-item`, quantity: `${fieldPrefix}-quantity` }}
      fieldLabels={{ itemId: 'Producto', quantity: 'Cantidad' }} />{message ? <p role="status">{message}</p> : null}
    {historyOnly ? null : role === 'CASHIER' ? <p role="alert">Tu rol puede consultar stock, pero no confirmar ajustes.</p> :
      <form className={compact ? styles.page : styles.panel} onSubmit={(event) => void submit(event)} noValidate>
        <h2>Nuevo ajuste</h2><div className={compact ? adjustmentStyles.verticalFields : styles.fields}>
          {!compact ? <div><label htmlFor={`${fieldPrefix}-item`}>Producto</label><select id={`${fieldPrefix}-item`} value={itemId}
            aria-invalid={!!itemError} aria-describedby={itemError ? `${fieldPrefix}-item-error` : undefined}
            onChange={(event) => setItemId(event.target.value)} required>
            {stocks.map((stock) => <option key={stock.itemId} value={stock.itemId}>{stock.itemName}</option>)}</select>
            {itemError ? <p id={`${fieldPrefix}-item-error`}>{itemError}</p> : null}</div> : null}
          <div><label htmlFor={`${fieldPrefix}-direction`}>Tipo de ajuste</label><select id={`${fieldPrefix}-direction`}
            value={direction} onChange={(event) => setDirection(event.target.value as 'INCREASE' | 'DECREASE')}>
            <option value="INCREASE">Ingreso</option><option value="DECREASE">Egreso</option></select></div>
          <div><label htmlFor={`${fieldPrefix}-quantity`}>Cantidad</label><input id={`${fieldPrefix}-quantity`}
            type="text" inputMode="decimal" value={quantity} onChange={(event) => setQuantity(event.target.value)}
            aria-invalid={!!quantityError} aria-describedby={quantityError ? `${fieldPrefix}-quantity-error` : undefined} />
            {quantityError ? <p id={`${fieldPrefix}-quantity-error`}>{quantityError}</p> : null}
            <span>{selected?.baseUnit === 'UNIT' ? 'Unidades enteras.' : 'Hasta tres decimales.'}</span></div>
          <div><label htmlFor={`${fieldPrefix}-reason`}>Motivo</label><select id={`${fieldPrefix}-reason`} value={reason}
            onChange={(event) => setReason(event.target.value)}>
            {(role === 'OWNER' || role === 'ADMIN' ? [['INVENTARIO_INICIAL', 'Inventario inicial'] as const, ...reasons] : reasons)
              .map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
          <div><label htmlFor={`${fieldPrefix}-observation`}>Observación (opcional)</label><input id={`${fieldPrefix}-observation`}
            value={observation} maxLength={2000} onChange={(event) => setObservation(event.target.value)} /></div>
        </div><button type="submit" disabled={busy || !stocks.length}>{busy ? 'Confirmando…' : 'Confirmar ajuste'}</button>
        {onLoadMoreStocks ? <button type="button" onClick={onLoadMoreStocks}>Cargar más productos</button> : null}
      </form>}
    {!compact ? <section className={styles.panel} aria-label="Ajustes confirmados"><h2>Historial de ajustes</h2>
      {adjustments.length === 0 ? <p>No hay ajustes confirmados en esta sucursal.</p> : <>
        <div className={adjustmentStyles.search}><label htmlFor={`${fieldPrefix}-search`}>Buscar producto</label>
          <input id={`${fieldPrefix}-search`} type="search" value={search} onChange={(event) => setSearch(event.target.value)} /></div>
        {visibleAdjustments.length === 0 ? <p role="status">Ningún ajuste coincide con «{search.trim()}».</p> :
        <ul className={adjustmentStyles.entries} aria-label="Ajustes de stock">{visibleAdjustments.map((adjustment) => <li className={adjustmentStyles.entry} key={adjustment.id}>
          <div className={adjustmentStyles.entryMain}>
            <strong>{adjustment.itemName}</strong>
            <span className={adjustmentStyles.meta}><time dateTime={adjustment.occurredAt}>{formatWhen(adjustment.occurredAt, timezone ?? contextTimezone)}</time>
              {' · '}{reasonLabels[adjustment.reason] ?? adjustment.reason}{adjustment.observation ? ` · ${adjustment.observation}` : ''}</span>
          </div>
          <span className={adjustmentStyles.delta} data-direction={adjustment.direction}>
            <span className={adjustmentStyles.hidden}>{adjustment.direction === 'INCREASE' ? 'Ingreso de ' : 'Egreso de '}</span>
            <span aria-hidden="true">{adjustment.direction === 'INCREASE' ? '+' : '−'}</span>{formatStockQuantity(adjustment.quantity)}</span>
          {adjustment.compensatedBy ? <span className={adjustmentStyles.pill}>Revertido</span>
            : adjustment.compensates ? <span className={adjustmentStyles.pill}>Reversión</span> : null}
          {role !== 'CASHIER' && !adjustment.compensatedBy && !adjustment.compensates ?
            confirmId === adjustment.id ? <div className={adjustmentStyles.confirm}><p>Se registra un movimiento contrario que deja el stock como estaba. El ajuste original queda en el historial.</p>
              <div className={styles.actions}><button type="button" disabled={busy} onClick={() => void compensate(adjustment.id)}><EntityAction label="Sí, revertir el ajuste" name={`de ${adjustment.itemName}`} /></button>
                <button type="button" onClick={() => setConfirmId(null)}>Cancelar</button></div></div>
              : <button type="button" className={adjustmentStyles.revert} disabled={busy} onClick={() => setConfirmId(adjustment.id)}><EntityAction label="Revertir" name={`ajuste de ${adjustment.itemName}`} /></button> : null}
        </li>)}</ul>}</>}
      {nextCursor && onLoadMore ? <button type="button" onClick={onLoadMore}>Cargar más ajustes</button> : null}
    </section> : null}
  </section>;
}

function formatWhen(value: string, timeZone: string): string {
  return new Date(value).toLocaleString('es-AR', { timeZone, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
    .replace('.', '');
}

function problem(cause: unknown): ApiProblemError {
  return cause instanceof ApiProblemError ? cause : new ApiProblemError({ status: 0,
    code: 'ADJUSTMENT_FAILED', message: 'No pudimos confirmar la operación. Intentá nuevamente.' });
}
