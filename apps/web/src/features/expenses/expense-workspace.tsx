'use client';

import { useRef, useState, type FormEvent } from 'react';

import { ErrorSummary } from '../../components/error-summary';
import { ApiProblemError } from '../../lib/api/client';
import { cancelExpense, createExpense, loadExpense, type ExpenseDetail } from './expenses-api';
import styles from '../identity/management.module.css';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const money = /^(?:0|[1-9]\d{0,17})\.\d{2}$/;

export function ExpenseWorkspace({ organizationId, branchId, role, categories, paymentMethods, sessions,
  onCreate = createExpense, onLoad = loadExpense, onCancel = cancelExpense }: {
  organizationId: string; branchId: string; role: 'OWNER' | 'ADMIN' | 'CASHIER';
  categories: readonly { id: string; name: string }[];
  paymentMethods: readonly string[];
  sessions: readonly { id: string; deviceId: string; registerName: string }[];
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
  const createKey = useRef<string | null>(null), cancelKey = useRef<string | null>(null);
  const selectedSession = sessions.find((session) => session.id === sessionId);
  const allowedMethods = role === 'CASHIER' ? paymentMethods.filter((entry) => entry === 'CASH') : paymentMethods;
  const canCreate = !!categoryId && !!concept.trim() && money.test(amount) && amount !== '0.00'
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
      const result = await onCreate(organizationId, { branchId, categoryId, concept: concept.trim(),
        amount, method, ...(method === 'CASH' && selectedSession
          ? { cashSessionId: selectedSession.id, deviceId: selectedSession.deviceId } : {}) }, key);
      setSuccess(`Gasto registrado · ${result.id}`); createKey.current = null;
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
  async function submitCancel() {
    if (!detail || !canCancel) return;
    const key = cancelKey.current ?? crypto.randomUUID(); cancelKey.current = key;
    setBusy(true); setError(null);
    try {
      await onCancel(organizationId, detail.id, { reason: reason.trim(),
        ...(cashCancellation && selectedSession
          ? { cashSessionId: selectedSession.id, deviceId: selectedSession.deviceId } : {}) }, key);
      setDetail(await onLoad(organizationId, detail.id)); cancelKey.current = null; setReason('');
    } catch (cause) { setError(problem(cause)); }
    finally { setBusy(false); }
  }
  return <section className={styles.page} aria-labelledby="expenses-heading">
    <header className={styles.heading}><h1 id="expenses-heading">Gastos</h1>
      <p>Registrá gastos y consultá su historial en la sucursal seleccionada.</p></header>
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
              <option key={entry} value={entry}>{entry}</option>)}</select></div>}
        {method === 'CASH' ? <div><label htmlFor="expense-session">Sesión de caja</label>
          <select id="expense-session" value={sessionId} onChange={(event) => { setSessionId(event.target.value); createKey.current = null; }}>
            <option value="">Seleccioná una sesión</option>{sessions.map((session) =>
              <option key={session.id} value={session.id}>{session.registerName}</option>)}</select>
          {!sessions.length ? <p role="alert">Abrí una sesión válida en esta sucursal para registrar efectivo.</p> : null}</div> : null}
      </div>
      {success ? <p role="status">{success}</p> : null}
      <button type="submit" disabled={busy || !canCreate}>{busy ? 'Registrando…' : 'Registrar gasto'}</button>
    </form>
    <form className={styles.panel} onSubmit={(event) => void search(event)}>
      <h2>Consultar gasto</h2><label htmlFor="expense-id">ID de gasto</label>
      <input id="expense-id" value={typedId} onChange={(event) => setTypedId(event.target.value)} />
      <button type="submit" disabled={busy}>Consultar gasto</button></form>
    {detail ? <section className={styles.panel} aria-label="Detalle de gasto"><h2>Gasto {detail.id}</h2>
      <p><strong>Estado:</strong> {detail.status === 'CANCELLED' ? 'Anulado' : 'Confirmado'}</p>
      <p><strong>Concepto:</strong> {detail.concept}</p>
      <p><strong>Importe:</strong> {detail.amount} {detail.currency}</p>
      <p><strong>Medio histórico:</strong> {detail.method}</p>
      <p><strong>Registrado:</strong> {new Date(detail.occurredAt).toLocaleString('es-AR')}</p>
      {detail.cancellation ? <p role="status"><strong>Anulación:</strong> {detail.cancellation.reason}
        {' · '}{new Date(detail.cancellation.cancelledAt).toLocaleString('es-AR')}</p> : null}
      {role !== 'CASHIER' && detail.status === 'CONFIRMED' ? <div><h3>Anular gasto</h3>
        <label htmlFor="expense-reason">Motivo de anulación</label><textarea id="expense-reason"
          maxLength={500} value={reason} onChange={(event) => { setReason(event.target.value); cancelKey.current = null; }} />
        {cashCancellation ? <><label htmlFor="expense-return-session">Sesión para devolver efectivo</label>
          <select id="expense-return-session" value={sessionId} onChange={(event) => { setSessionId(event.target.value); cancelKey.current = null; }}>
            <option value="">Seleccioná una sesión</option>{sessions.map((session) =>
              <option key={session.id} value={session.id}>{session.registerName}</option>)}</select>
          {!sessions.length ? <p role="alert">Abrí una sesión válida para devolver el efectivo.</p> : null}</> : null}
        <button type="button" disabled={busy || !canCancel} onClick={() => void submitCancel()}>
          {busy ? 'Anulando…' : 'Anular gasto'}</button></div> : null}
    </section> : null}
  </section>;
}
