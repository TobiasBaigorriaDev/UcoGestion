'use client';

import { useState } from 'react';

import { ErrorSummary } from '../../components/error-summary';
import { ApiProblemError } from '../../lib/api/client';
import type { StockItem } from './inventory-api';
import { saveStockThreshold } from './inventory-api';
import styles from '../identity/management.module.css';

type Role = 'OWNER' | 'ADMIN' | 'EMPLOYEE' | 'CASHIER';
const minimumPattern = /^(?:0|[1-9]\d{0,16})(?:\.\d{1,3})?$/;

export function InventoryStock({ organizationId, role, branches, branchId, stocks, nextCursor,
  onBranchChange, onReload, onLoadMore, onSaveThreshold = saveStockThreshold }: {
  organizationId: string; role: Role; branches: { id: string; name: string }[]; branchId: string;
  stocks: StockItem[]; nextCursor: string | null; onBranchChange: (id: string) => void;
  onReload: () => void; onLoadMore?: () => void;
  onSaveThreshold?: typeof saveStockThreshold;
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<ApiProblemError | null>(null);
  const [message, setMessage] = useState('');
  const [errorItemId, setErrorItemId] = useState<string | null>(null);
  const [onlyLow, setOnlyLow] = useState(false);
  const lowCount = stocks.filter((item) => item.lowStock).length;
  const visibleStocks = stocks.filter((item) => !onlyLow || item.lowStock)
    .sort((left, right) => Number(right.lowStock) - Number(left.lowStock));
  async function save(item: StockItem) {
    const raw = (drafts[item.itemId] ?? displayMinimum(item)).trim();
    if (raw !== '' && (!minimumPattern.test(raw) || (item.baseUnit === 'UNIT' && raw.includes('.')))) {
      const fieldMessage = item.baseUnit === 'UNIT' ? 'Ingresá un mínimo entero o dejalo vacío para quitarlo.'
        : 'Ingresá un mínimo no negativo con hasta tres decimales, o dejalo vacío para quitarlo.';
      setErrorItemId(item.itemId);
      setError(new ApiProblemError({ status: 400, code: 'INVALID_MINIMUM', fieldErrors: { minimum: fieldMessage },
        message: fieldMessage }));
      return;
    }
    setBusyId(item.itemId); setError(null); setErrorItemId(null); setMessage('');
    try {
      await onSaveThreshold(organizationId, branchId, item.itemId, raw === '' ? null : raw);
      setDrafts((current) => { const next = { ...current }; delete next[item.itemId]; return next; });
      setMessage(`Mínimo de ${item.itemName} actualizado.`); onReload();
    } catch (cause) {
      setErrorItemId(item.itemId);
      setError(cause instanceof ApiProblemError ? cause : new ApiProblemError({ status: 0,
        code: 'THRESHOLD_FAILED', message: 'No pudimos guardar el mínimo. Revisá la conexión e intentá nuevamente.' }));
    } finally { setBusyId(null); }
  }
  return <section className={styles.page} aria-labelledby="inventory-heading">
    <header className={styles.heading}><h1 id="inventory-heading">Stock por sucursal</h1>
      <p>Consultá existencias, mínimos y productos que necesitan reposición.</p></header>
    <div className={styles.panel}><label htmlFor="stock-branch">Sucursal</label>
      <select id="stock-branch" value={branchId} onChange={(event) => onBranchChange(event.target.value)}>
        {branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
      </select></div>
    <ErrorSummary error={error} fieldIds={errorItemId ? { minimum: `minimum-${errorItemId}` } : {}}
      fieldLabels={{ minimum: 'Mínimo' }} />{message ? <p role="status">{message}</p> : null}
    <section className={styles.panel} aria-label="Existencias">
      {stocks.length === 0 ? <p>No hay productos inventariables en esta sucursal.</p> : <>
        <p role="status">{lowCount === 1 ? '1 producto con stock bajo entre los productos cargados.'
          : `${lowCount} productos con stock bajo entre los productos cargados.`}</p>
        <button type="button" aria-pressed={onlyLow} onClick={() => setOnlyLow((current) => !current)}>
          {onlyLow ? 'Mostrar todos' : `Solo stock bajo (${lowCount})`}</button>
        {visibleStocks.length === 0 ? <p>No hay productos con stock bajo entre los cargados.
          {nextCursor ? ' Cargá más productos para revisar el resto.' : ''}</p> : null}
        <ul className={styles.rows}>{visibleStocks.map((item) => <li className={styles.row} key={item.itemId}>
          <div className={styles.memberTitle}><strong>{item.itemName}</strong><span>Disponible: {item.quantity} {item.baseUnit === 'UNIT' ? 'unidades' : 'unidades fraccionables'}</span></div>
          <p>{item.threshold === null ? 'Sin mínimo configurado' : `Mínimo: ${item.threshold}`}</p>
          <p>{item.lowStock ? <strong>Alerta: Stock bajo. Alcanzó o quedó por debajo del mínimo.</strong> : 'Sin alerta de stock bajo.'}</p>
          {role !== 'CASHIER' ? <div className={styles.fields}><div>
            <label htmlFor={`minimum-${item.itemId}`}>Mínimo de {item.itemName}</label>
            <input id={`minimum-${item.itemId}`} type="text" inputMode="decimal" value={drafts[item.itemId] ?? displayMinimum(item)}
              aria-invalid={errorItemId === item.itemId && !!error?.fieldErrors.minimum}
              aria-describedby={errorItemId === item.itemId && error?.fieldErrors.minimum ? `minimum-error-${item.itemId}` : undefined}
              onChange={(event) => setDrafts((current) => ({ ...current, [item.itemId]: event.target.value }))} />
            {errorItemId === item.itemId && error?.fieldErrors.minimum ?
              <p id={`minimum-error-${item.itemId}`}>{error.fieldErrors.minimum}</p> : null}
            <span>{item.baseUnit === 'UNIT' ? 'Vacío elimina el mínimo. Ingresá unidades enteras.'
              : 'Vacío elimina el mínimo. Hasta tres decimales.'}</span>
            <button type="button" disabled={busyId !== null} onClick={() => void save(item)}>
              {busyId === item.itemId ? 'Guardando…' : `Guardar mínimo de ${item.itemName}`}</button>
          </div></div> : null}
        </li>)}</ul></>}
      {nextCursor && onLoadMore ? <button type="button" onClick={onLoadMore}>Cargar más productos</button> : null}
    </section>
  </section>;
}

function displayMinimum(item: StockItem): string {
  const stored = item.threshold ?? '';
  return item.baseUnit === 'UNIT' ? stored.replace(/\.000$/, '') : stored;
}
