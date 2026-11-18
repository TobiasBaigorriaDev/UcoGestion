'use client';
import { OrganizationTime } from '../../components/organization-time';

import { useRef, useState, type FormEvent } from 'react';

import { ErrorSummary } from '../../components/error-summary';
import { ApiProblemError } from '../../lib/api/client';
import { cancelExpense, createExpense, loadExpense, type ExpenseDetail } from './expenses-api';
import styles from '../identity/management.module.css';
import { ConfirmAction } from '../../components/confirm-action';
import { formatMoney, paymentMethodLabel } from '../../lib/format';
import { parseMoneyInput } from '../../lib/money-input';
import { loadReport } from '../insights/insights-api';
import { ExpenseHistory, type ExpenseHistoryLoader } from './expense-history';

const loadExpenseHistory: ExpenseHistoryLoader = (organizationId, filters) => loadReport(organizationId, 'expenses', filters);

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function ExpenseWorkspace({ organizationId, branchId, role, categories, paymentMethods, sessions,
  onCreate = createExpense, onLoad = loadExpense, onCancel = cancelExpense, loadHistory = loadExpenseHistory }: {
  organizationId: string; branchId: string; role: 'OWNER' | 'ADMIN' | 'CASHIER';
  categories: readonly { id: string; name: string }[];
  paymentMethods: readonly string[];
  sessions: readonly { id: string; deviceId: string; registerName: string }[];
  loadHistory?: ExpenseHistoryLoader;
  onCreate?: typeof createExpense; onLoad?: typeof loadExpense; onCancel?: typeof cancelExpense;
}) {
  const [categoryId, setCategoryId] = useState('');
  const [concept, setConcept] = useState('');
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState(role === 'CASHIER' ? 'CASH' : '');
  const [sessionId, setSessionId] = useState('');
  const [typedId, setTypedId] = useState('');
  const [detail, setDetail] = useState<ExpenseDetail | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<ApiProblemError | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const parsedAmount = parseMoneyInput(amount);
  const createKey = useRef<string | null>(null), cancelKey = useRef<string | null>(null);
  const selectedSession = sessions.find((session) => session.id === sessionId);
  const allowedMethods = role === 'CASHIER' ? paymentMethods.filter((entry) => entry === 'CASH') : paymentMethods;
  const canCreate = !!categoryId && !!concept.trim() && parsedAmount !== null && parsedAmount !== '0.00'
    && allowedMethods.includes(method) && (method !== 'CASH' || !!selectedSession);
  const cashCancellation = detail?.method === 'CASH';
  const canCancel = role !== 'CASHIER' && detail?.status === 'CONFIRMED' && !!reason.trim()
    && (!cashCancellation || !!selectedSession);
  const problem = (cause: unknown) => cause instanceof ApiProblemError ? cause : new ApiProblemError({
    status: 0, code: 'EXPENSE_OPERATION_FAILED',
    message: 'No pudimos completar la operación. Revisá los datos e intentá nuevamente.' });

  async function submitCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canCreate) return;
    const key = createKey.current ?? crypto.randomUUID(); createKey.current = key;
    setBusy(true); setError(null); setSuccess(null);
    try {
      await onCreate(organizationId, { branchId, categoryId, concept: concept.trim(),
        amount: parsedAmount ?? amount, method, ...(method === 'CASH' && selectedSession
          ? { cashSessionId: selectedSession.id, deviceId: selectedSession.deviceId } : {}) }, key);
      setSuccess('Gasto registrado.'); createKey.current = null; setRefresh(value => value + 1);
      setCategoryId(''); setConcept(''); setAmount(''); setMethod(role === 'CASHIER' ? 'CASH' : ''); setSessionId('');
    } catch (cause) { setError(problem(cause)); }
    finally { setBusy(false); }
  }
  async function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(null); setDetail(null); cancelKey.current = null;
    if (!uuid.test(typedId.trim())) {
      setError(new ApiProblemError({ status: 400, code: 'EXPENSE_ID_INVALID',
        message: 'Ingresá un ID de gasto válido.' })); return;
    }
    setBusy(true);
    try {
      const found = await onLoad(organizationId, typedId.trim());
      if (found.branchId !== branchId) throw new ApiProblemError({ status: 403,
        code: 'EXPENSE_BRANCH_MISMATCH', message: 'Seleccioná la sucursal del gasto para consultarlo.' });
      setDetail(found);
    } catch (cause) { setError(problem(cause)); }
    finally { setBusy(false); }
  }
  async function open(id: string) {
    setError(null); setDetail(null); cancelKey.current = null; setBusy(true);
    try { setDetail(await onLoad(organizationId, id)); }
    catch (cause) { setError(problem(cause)); }
    finally { setBusy(false); }
  }
  async function submitCancel() {
    if (!detail || !canCancel) return;
    const key = cancelKey.current ?? crypto.randomUUID(); cancelKey.current = key;
    setBusy(true); setError(null);
    try {
      await onCancel(organizationId, detail.id, { reason: reason.trim(),
        ...(cashCancellation && selectedSession
          ? { cashSessionId: selectedSession.id, deviceId: selectedSession.deviceId } : {}) }, key);
      setDetail(await onLoad(organizationId, detail.id)); cancelKey.current = null; setReason(''); setRefresh(value => value + 1);
    } catch (cause) { setError(problem(cause)); }
    finally { setBusy(false); }
  }
  return <section className={styles.page} aria-labelledby="expenses-heading">
    <header className={styles.heading}><h1 id="expenses-heading">Gastos</h1>
      <p>{role === 'CASHIER' ? 'Registrá los gastos pagados con el efectivo de tu caja.' : 'Registrá gastos y revisá los de la sucursal.'}</p></header>
    <ErrorSummary error={error} />
    <form className={styles.panel} onSubmit={(event) => void submitCreate(event)}>
      <h2>Registrar gasto</h2><div className={styles.fields}>
        <div><label htmlFor="expense-category">Categoría de gasto</label><select id="expense-category" value={categoryId}
          onChange={(event) => { setCategoryId(event.target.value); createKey.current = null; }}>
          <option value="">Seleccioná una categoría</option>{categories.map((category) =>
            <option key={category.id} value={category.id}>{category.name}</option>)}</select>
          {!categories.length ? <p role="alert">Solicitá que activen una categoría de gasto antes de continuar.</p> : null}</div>
        <div><label htmlFor="expense-concept">Concepto</label><input id="expense-concept" value={concept}
          onChange={(event) => { setConcept(event.target.value); createKey.current = null; }} maxLength={2000} /></div>
        <div><label htmlFor="expense-amount">Importe</label><input id="expense-amount" inputMode="decimal"
          value={amount} onChange={(event) => { setAmount(event.target.value); createKey.current = null; }} /></div>
        {role === 'CASHIER' ? <p><strong>Medio de pago:</strong> Efectivo</p>
          : <div><label htmlFor="expense-method">Medio de pago</label><select id="expense-method" value={method}
            onChange={(event) => { setMethod(event.target.value); setSessionId(''); createKey.current = null; }}>
            <option value="">Seleccioná un medio</option>{allowedMethods.map((entry) =>
              <option key={entry} value={entry}>{paymentMethodLabel(entry)}</option>)}</select></div>}
        {method === 'CASH' ? <div><label htmlFor="expense-session">Turno de caja</label>
          <select id="expense-session" value={sessionId} onChange={(event) => { setSessionId(event.target.value); createKey.current = null; }}>
            <option value="">Elegí un turno abierto</option>{sessions.map((session) =>
              <option key={session.id} value={session.id}>{session.registerName}</option>)}</select>
          {!sessions.length ? <p role="alert">Abrí un turno de caja en esta sucursal para pagar en efectivo.</p> : null}</div> : null}
      </div>
      {success ? <p role="status">{success}</p> : null}
      <button type="submit" disabled={busy || !canCreate}>{busy ? 'Registrando…' : 'Registrar gasto'}</button>
    </form>
    {role !== 'CASHIER' ? <ExpenseHistory organizationId={organizationId} branchId={branchId} load={loadHistory}
      onOpen={(id) => void open(id)} refresh={refresh} /> : null}
    <details className={styles.panel} open={role === 'CASHIER' || undefined}><summary>Buscar un gasto por su ID</summary>
    <form onSubmit={(event) => void search(event)}>
      <h2>Consultar gasto</h2><label htmlFor="expense-id">ID de gasto</label>
      <input id="expense-id" value={typedId} onChange={(event) => setTypedId(event.target.value)} />
      <button type="submit" disabled={busy}>Consultar gasto</button></form></details>
    {detail ? <section className={styles.panel} aria-label="Detalle de gasto"><h2>{detail.concept}</h2>
      <p><strong>Estado:</strong> {detail.status === 'CANCELLED' ? 'Anulado' : 'Confirmado'}</p>
      <p><strong>Concepto:</strong> {detail.concept}</p>
      <p><strong>Importe:</strong> <span>{formatMoney(detail.amount, detail.currency)}</span></p>
      <p><strong>Medio de pago:</strong> {paymentMethodLabel(detail.method)}</p>
      <p><strong>Registrado:</strong> <OrganizationTime value={detail.occurredAt} /></p>
      {detail.cancellation ? <p role="status"><strong>Anulación:</strong> {detail.cancellation.reason}
        {' · '}<OrganizationTime value={detail.cancellation.cancelledAt} /></p> : null}
      {role !== 'CASHIER' && detail.status === 'CONFIRMED' ? <div><h3>Anular gasto</h3>
        <label htmlFor="expense-reason">Motivo de anulación</label><textarea id="expense-reason"
          maxLength={500} value={reason} onChange={(event) => { setReason(event.target.value); cancelKey.current = null; }} />
        {cashCancellation ? <><label htmlFor="expense-return-session">Turno para devolver el efectivo</label>
          <select id="expense-return-session" value={sessionId} onChange={(event) => { setSessionId(event.target.value); cancelKey.current = null; }}>
            <option value="">Elegí un turno abierto</option>{sessions.map((session) =>
              <option key={session.id} value={session.id}>{session.registerName}</option>)}</select>
          {!sessions.length ? <p role="alert">Abrí un turno de caja para devolver el efectivo.</p> : null}</> : null}
        <ConfirmAction label="Anular gasto" confirmLabel="Sí, anular el gasto" busy={busy} busyLabel="Anulando…"
          disabled={!canCancel} onConfirm={() => void submitCancel()}>
          <p>{cashCancellation ? 'El efectivo vuelve a la caja elegida. ' : ''}La anulación queda registrada y no se puede deshacer.</p>
        </ConfirmAction></div> : null}
    </section> : null}
  </section>;
}
