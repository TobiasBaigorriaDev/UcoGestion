'use client';

import { useState } from 'react';

import { ErrorSummary } from '../../components/error-summary';
import { ApiProblemError } from '../../lib/api/client';
import { compensateTransfer, confirmTransfer, type StockItem, type Transfer } from './inventory-api';
import styles from '../identity/management.module.css';

type Role = 'OWNER' | 'ADMIN' | 'EMPLOYEE' | 'CASHIER';
type Line = { key: string; itemId: string; quantity: string };
const decimal = /^(?:0|[1-9]\d{0,16})(?:\.\d{1,3})?$/;

export function InventoryTransfers({ organizationId, role, branches, originBranchId, stocks,
  transfers, nextCursor, onOriginChange, onReload, onLoadMore, onLoadMoreStocks,
  onConfirm = confirmTransfer, onCompensate = compensateTransfer }: {
  organizationId: string; role: Role; branches: { id: string; name: string }[]; originBranchId: string;
  stocks: StockItem[]; transfers: Transfer[]; nextCursor: string | null;
  onOriginChange: (id: string) => void; onReload: () => void; onLoadMore?: () => void; onLoadMoreStocks?: () => void;
  onConfirm?: typeof confirmTransfer; onCompensate?: typeof compensateTransfer;
}) {
  const [destination, setDestination] = useState('');
  const [lines, setLines] = useState<Line[]>([{ key: crypto.randomUUID(), itemId: stocks[0]?.itemId ?? '', quantity: '' }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiProblemError | null>(null);
  const [message, setMessage] = useState('');
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const fieldIds: Record<string, string> = { destinationBranchId: 'transfer-destination' };
  const fieldLabels: Record<string, string> = { destinationBranchId: 'Destino' };
  for (const [index, line] of lines.entries()) {
    fieldIds[`item-${line.key}`] = `transfer-item-${line.key}`;
    fieldIds[`quantity-${line.key}`] = `transfer-quantity-${line.key}`;
    fieldLabels[`item-${line.key}`] = `Producto de línea ${index + 1}`;
    fieldLabels[`quantity-${line.key}`] = `Cantidad de línea ${index + 1}`;
  }
  function changeLine(key: string, patch: Partial<Line>) {
    setLines((current) => current.map((line) => line.key === key ? { ...line, ...patch } : line));
  }
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setError(null); setMessage('');
    if (!destination || destination === originBranchId || !branches.some((branch) => branch.id === destination)) {
      setError(new ApiProblemError({ status: 400, code: 'INVALID_DESTINATION',
        message: 'Elegí una sucursal de destino distinta del origen.',
        fieldErrors: { destinationBranchId: 'Elegí una sucursal de destino distinta del origen.' } })); return;
    }
    const seen = new Set<string>();
    const lineErrors: Record<string, string> = {};
    for (const line of lines) {
      const stock = stocks.find((entry) => entry.itemId === line.itemId);
      if (!stock) lineErrors[`item-${line.key}`] = 'Seleccioná un producto.';
      else if (seen.has(line.itemId)) lineErrors[`item-${line.key}`] = 'Este producto ya está en otra línea.';
      if (!stock || !decimal.test(line.quantity) || /^0(?:\.0+)?$/.test(line.quantity)
        || (stock.baseUnit === 'UNIT' && line.quantity.includes('.'))) {
        lineErrors[`quantity-${line.key}`] = stock?.baseUnit === 'UNIT'
          ? 'Ingresá una cantidad entera mayor que cero.' : 'Ingresá una cantidad mayor que cero con hasta tres decimales.';
      }
      seen.add(line.itemId);
    }
    if (!lines.length || Object.keys(lineErrors).length) {
      setError(new ApiProblemError({ status: 400, code: 'INVALID_LINES',
        message: 'Revisá las líneas: cada producto debe ser único y tener una cantidad válida; las unidades deben ser enteras.',
        fieldErrors: lineErrors })); return;
    }
    setBusy(true);
    try {
      await onConfirm(organizationId, { originBranchId, destinationBranchId: destination,
        lines: lines.map(({ itemId, quantity }) => ({ itemId, quantity })) });
      setMessage('Transferencia confirmada. Se actualizarán ambos saldos.');
      setLines([{ key: crypto.randomUUID(), itemId: stocks[0]?.itemId ?? '', quantity: '' }]); onReload();
    } catch (cause) { setError(problem(cause)); }
    finally { setBusy(false); }
  }
  async function compensate(id: string) {
    setBusy(true); setError(null); setMessage('');
    try { await onCompensate(organizationId, id); setConfirmId(null);
      setMessage('Transferencia compensatoria confirmada.'); onReload(); }
    catch (cause) { setError(problem(cause)); }
    finally { setBusy(false); }
  }
  const branchName = (id: string) => branches.find((branch) => branch.id === id)?.name ?? 'Sucursal no disponible';
  return <section className={styles.page} aria-labelledby="transfer-heading">
    <header className={styles.heading}><h1 id="transfer-heading">Transferencias de stock</h1>
      <p>Mové productos entre sucursales autorizadas. Una corrección posterior crea una transferencia compensatoria.</p></header>
    <p><a href="/workspace/inventory">Volver al stock</a></p>
    <ErrorSummary error={error} fieldIds={fieldIds} fieldLabels={fieldLabels} />
    {message ? <p role="status">{message}</p> : null}
    {role === 'CASHIER' ? <p role="alert">Tu rol no puede confirmar transferencias.</p> :
      <form className={styles.panel} onSubmit={(event) => void submit(event)} noValidate>
        <h2>Nueva transferencia</h2><div className={styles.fields}>
          <div><label htmlFor="transfer-origin">Origen</label><select id="transfer-origin" value={originBranchId}
            onChange={(event) => onOriginChange(event.target.value)}>{branches.map((branch) =>
              <option key={branch.id} value={branch.id}>{branch.name}</option>)}</select></div>
          <div><label htmlFor="transfer-destination">Destino</label><select id="transfer-destination" value={destination}
            aria-invalid={!!error?.fieldErrors.destinationBranchId}
            aria-describedby={error?.fieldErrors.destinationBranchId ? 'transfer-destination-error' : undefined}
            onChange={(event) => setDestination(event.target.value)}><option value="">Elegí una sucursal</option>
            {branches.filter((branch) => branch.id !== originBranchId).map((branch) =>
              <option key={branch.id} value={branch.id}>{branch.name}</option>)}</select>
            {error?.fieldErrors.destinationBranchId ? <p id="transfer-destination-error">{error.fieldErrors.destinationBranchId}</p> : null}</div>
        </div>
        <h3>Productos</h3>{lines.map((line, index) => {
          const stock = stocks.find((entry) => entry.itemId === line.itemId);
          return <div className={styles.fields} key={line.key}>
            <div><label htmlFor={`transfer-item-${line.key}`}>Producto de línea {index + 1}</label>
              <select id={`transfer-item-${line.key}`} value={line.itemId}
                aria-invalid={!!error?.fieldErrors[`item-${line.key}`]}
                aria-describedby={error?.fieldErrors[`item-${line.key}`] ? `transfer-item-error-${line.key}` : undefined}
                onChange={(event) => changeLine(line.key, { itemId: event.target.value })}>
                {stocks.map((entry) => <option key={entry.itemId} value={entry.itemId}>{entry.itemName}</option>)}</select>
              {error?.fieldErrors[`item-${line.key}`] ? <p id={`transfer-item-error-${line.key}`}>{error.fieldErrors[`item-${line.key}`]}</p> : null}</div>
            <div><label htmlFor={`transfer-quantity-${line.key}`}>Cantidad de {stock?.itemName ?? `línea ${index + 1}`}</label>
              <input id={`transfer-quantity-${line.key}`} type="text" inputMode="decimal" value={line.quantity}
                aria-invalid={!!error?.fieldErrors[`quantity-${line.key}`]}
                aria-describedby={error?.fieldErrors[`quantity-${line.key}`] ? `transfer-quantity-error-${line.key}` : undefined}
                onChange={(event) => changeLine(line.key, { quantity: event.target.value })} />
              {error?.fieldErrors[`quantity-${line.key}`] ? <p id={`transfer-quantity-error-${line.key}`}>{error.fieldErrors[`quantity-${line.key}`]}</p> : null}
              <span>Disponible en origen: {stock?.quantity ?? '—'}</span></div>
            {lines.length > 1 ? <button type="button" onClick={() => setLines((current) => current.filter((entry) => entry.key !== line.key))}>Quitar línea {index + 1}</button> : null}
          </div>;
        })}
        <div className={styles.actions}><button type="submit" disabled={busy || !stocks.length || branches.length < 2}>
          {busy ? 'Confirmando…' : 'Confirmar transferencia'}</button>
          <button type="button" disabled={!stocks.length || lines.length >= 100}
            onClick={() => setLines((current) => [...current, { key: crypto.randomUUID(), itemId: stocks[0]?.itemId ?? '', quantity: '' }])}>Agregar producto</button>
          {onLoadMoreStocks ? <button type="button" onClick={onLoadMoreStocks}>Cargar más productos</button> : null}</div>
      </form>}
    <section className={styles.panel} aria-label="Transferencias confirmadas"><h2>Historial de transferencias</h2>
      {transfers.length === 0 ? <p>No hay transferencias disponibles para esta sucursal.</p> :
        <ul className={styles.rows}>{transfers.map((transfer) => <li className={styles.row} key={transfer.id}>
          <strong>{branchName(transfer.originBranchId)} → {branchName(transfer.destinationBranchId)}</strong>
          <ul>{transfer.lines.map((line) => <li key={line.itemId}>{line.itemName}: {line.quantity}</li>)}</ul>
          <span>{transfer.compensatedBy ? 'Compensada' : transfer.compensates ? 'Compensación confirmada' : 'Confirmada'}</span>
          {role !== 'CASHIER' && !transfer.compensatedBy && !transfer.compensates ?
            confirmId === transfer.id ? <div><p>La compensación revertirá las líneas si hay stock suficiente en destino. El original seguirá en el historial.</p>
              <div className={styles.actions}><button type="button" disabled={busy} onClick={() => void compensate(transfer.id)}>Confirmar compensación</button>
                <button type="button" onClick={() => setConfirmId(null)}>Cancelar</button></div></div>
              : <button type="button" disabled={busy} onClick={() => setConfirmId(transfer.id)}>Compensar transferencia</button> : null}
        </li>)}</ul>}
      {nextCursor && onLoadMore ? <button type="button" onClick={onLoadMore}>Cargar más transferencias</button> : null}
    </section>
  </section>;
}

function problem(cause: unknown): ApiProblemError {
  return cause instanceof ApiProblemError ? cause : new ApiProblemError({ status: 0, code: 'TRANSFER_FAILED',
    message: 'No pudimos confirmar la transferencia. Intentá nuevamente.' });
}
