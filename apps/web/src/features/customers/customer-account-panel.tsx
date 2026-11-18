'use client';

import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { subtractMoney } from '@uconext/shared';
import { z } from 'zod';
import { ErrorSummary } from '../../components/error-summary';
import { OrganizationTime } from '../../components/organization-time';
import { ApiProblemError } from '../../lib/api/client';
import { loadCheckoutContext } from '../sales/sales-api';
import { accountAmountInput, canonicalAccountAmount, collectCustomerDebt, formatAccountAmount,
  loadCustomerAccount, reverseCustomerCollection, setCustomerCreditLimit } from './customer-account-api';
import styles from './customer-account.module.css';

const collectionSchema = z.object({ amount: accountAmountInput, method: z.string().min(1, 'Elegí un medio de pago.') });
const limitSchema = z.object({ creditLimit: accountAmountInput });
const reversalSchema = z.object({ reason: z.string().trim().min(1, 'Ingresá el motivo.').max(500) });
const methodNames: Record<string, string> = { CASH: 'Efectivo', TRANSFER: 'Transferencia', DEBIT_CARD: 'Débito', CREDIT_CARD: 'Crédito', QR: 'QR' };
const entryNames = { SALE: 'Compra a cuenta', COLLECTION: 'Cobro de deuda', SALE_CANCELLATION: 'Anulación de compra', COLLECTION_REVERSAL: 'Reversión de cobro' };

export function CustomerAccountPanel({ organizationId, branchId, customerId, customerName, role, onReload }: {
  organizationId: string; branchId: string; customerId: string; customerName: string;
  role: 'OWNER' | 'ADMIN' | 'CASHIER' | 'EMPLOYEE'; onReload: () => void;
}) {
  const [cursor, setCursor] = useState('');
  const [previousCursors, setPreviousCursors] = useState<string[]>([]);
  const [sessionId, setSessionId] = useState('');
  const [reversalId, setReversalId] = useState('');
  const [error, setError] = useState<ApiProblemError | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [recoveringCollection, setRecoveringCollection] = useState(false);
  const attempts = useRef(new Map<string, { signature: string; key: string; operation: (key: string) => Promise<unknown> }>());
  const queryClient = useQueryClient();
  const manage = role === 'OWNER' || role === 'ADMIN';
  const account = useQuery({ queryKey: ['customer-account', organizationId, customerId, branchId, cursor],
    queryFn: () => loadCustomerAccount(organizationId, customerId, branchId, cursor || undefined), retry: false });
  const checkout = useQuery({ queryKey: ['sale-checkout-context', organizationId, branchId],
    queryFn: () => loadCheckoutContext(organizationId, branchId), retry: false });
  const data = account.data;
  const session = checkout.data?.sessions.find(item => item.id === sessionId) ?? checkout.data?.sessions[0];
  const collection = useForm<z.infer<typeof collectionSchema>>({ resolver: zodResolver(collectionSchema), defaultValues: { amount: '', method: 'CASH' } });
  const limit = useForm<z.infer<typeof limitSchema>>({ resolver: zodResolver(limitSchema), defaultValues: { creditLimit: '' } });
  const reversal = useForm<z.infer<typeof reversalSchema>>({ resolver: zodResolver(reversalSchema), defaultValues: { reason: '' } });
  const selectedMethod = collection.watch('method');
  useEffect(() => {
    if (checkout.data && !checkout.data.paymentMethods.includes(selectedMethod)) {
      collection.setValue('method', checkout.data.paymentMethods[0] ?? '');
    }
  }, [checkout.data, selectedMethod, collection]);
  const problem = (cause: unknown) => cause instanceof ApiProblemError ? cause : new ApiProblemError({ status: 0,
    code: 'CUSTOMER_ACCOUNT_REQUEST_FAILED', message: 'No pudimos completar la operación. Revisá la conexión y reintentá; conservamos la clave para evitar duplicados.' });

  async function run(action: string, payload: object, operation: (key: string) => Promise<unknown>, success: string) {
    setBusy(true); setError(null); setRecoveringCollection(false); setMessage('');
    const signature = JSON.stringify(payload);
    const previous = attempts.current.get(action);
    const attempt = previous?.signature === signature ? previous : { signature, key: crypto.randomUUID(), operation };
    attempts.current.set(action, attempt);
    try {
      await attempt.operation(attempt.key); attempts.current.delete(action);
      setMessage(success); setCursor(''); setPreviousCursors([]); setReversalId('');
      await queryClient.invalidateQueries({ queryKey: ['customer-account', organizationId] });
      await queryClient.invalidateQueries({ queryKey: ['customers', organizationId] });
      await queryClient.invalidateQueries({ queryKey: ['cash-workspace', organizationId] });
      onReload();
      return true;
    } catch (cause) {
      const failure = problem(cause); setError(failure);
      if (failure.code === 'VERSION_CONFLICT') attempts.current.delete(action);
      setRecoveringCollection(action === 'collect' && (failure.status === 0 || failure.code === 'INVALID_RESPONSE'));
      return false;
    }
    finally { setBusy(false); }
  }
  async function collect(values: z.infer<typeof collectionSchema>) {
    if (!data || !session) return;
    const amount = canonicalAccountAmount(values.amount);
    const input = { cashSessionId: session.id, deviceId: session.deviceId, amount, method: values.method };
    const replay = recoveringCollection && attempts.current.get('collect')?.signature === JSON.stringify(input);
    if (amount === '0.00') { collection.setError('amount', { message: 'El importe debe ser mayor que cero.' }); return; }
    if (!replay && subtractMoney(data.balance, amount).startsWith('-')) { collection.setError('amount', { message: 'El cobro no puede superar la deuda actual.' }); return; }
    if (await run('collect', input, key => collectCustomerDebt(organizationId, customerId, input, key), 'Cobro registrado. La deuda y la caja se actualizaron.')) collection.reset();
  }
  async function saveLimit(values: z.infer<typeof limitSchema>) {
    if (!data) return;
    const creditLimit = canonicalAccountAmount(values.creditLimit);
    const input = { creditLimit };
    const replay = (error?.status === 0 || error?.code === 'INVALID_RESPONSE') && attempts.current.get('limit')?.signature === JSON.stringify(input);
    if (!replay && subtractMoney(creditLimit, data.balance).startsWith('-')) { limit.setError('creditLimit', { message: 'El tope no puede ser menor que la deuda actual.' }); return; }
    await run('limit', input, key => setCustomerCreditLimit(organizationId, customerId, data.version, creditLimit, key), 'Tope de deuda actualizado.');
  }
  async function reverse(values: z.infer<typeof reversalSchema>) {
    if (!session || !reversalId) return;
    const input = { cashSessionId: session.id, deviceId: session.deviceId, reason: values.reason.trim() };
    if (await run('reverse', { entryId: reversalId, ...input }, key => reverseCustomerCollection(organizationId, customerId, reversalId, input, key), 'Cobro revertido. Se conservó el historial.')) reversal.reset();
  }
  return <section className={styles.account} aria-label={`Cuenta de ${customerName}`}>
    <h3>Cuenta corriente de {customerName}</h3>
    <p>La deuda es compartida entre las sucursales del negocio. Los movimientos corresponden a la sucursal activa.</p>
    {account.isPending ? <p role="status">Cargando cuenta corriente…</p> : null}
    {account.error ? <><ErrorSummary error={problem(account.error)} /><button type="button" onClick={() => void account.refetch()}>Reintentar cuenta</button></> : null}
    <ErrorSummary error={error} />
    {recoveringCollection ? <p>Reintentá el cobro original para consultar su resultado sin duplicarlo.</p> : null}
    {message ? <p role="status">{message}</p> : null}
    {data ? <>
      <dl className={styles.summary}>
        <div><dt>Deuda actual</dt><dd>{formatAccountAmount(data.balance, data.currency)}</dd></div>
        <div><dt>Tope de deuda</dt><dd>{formatAccountAmount(data.creditLimit, data.currency)}</dd></div>
        <div><dt>Disponible para comprar</dt><dd>{formatAccountAmount(data.available, data.currency)}</dd></div>
      </dl>
      {manage ? <form onSubmit={limit.handleSubmit(saveLimit)} noValidate>
        <fieldset disabled={busy} className={styles.fields}><legend>Modificar tope</legend>
          <div><label htmlFor={`limit-${customerId}`}>Tope de deuda</label>
            <input id={`limit-${customerId}`} inputMode="decimal" placeholder={data.creditLimit.replace('.', ',')}
              aria-invalid={!!limit.formState.errors.creditLimit} {...limit.register('creditLimit')} />
            {limit.formState.errors.creditLimit ? <p role="alert">{limit.formState.errors.creditLimit.message}</p> : null}</div>
          <button type="submit">Guardar tope</button>
        </fieldset>
      </form> : null}
      <form onSubmit={collection.handleSubmit(collect)} noValidate>
        <fieldset disabled={busy || !session} className={styles.fields}><legend>Registrar pago de la deuda</legend>
          <div><label htmlFor={`collection-session-${customerId}`}>Caja para el cobro</label>
            <select id={`collection-session-${customerId}`} value={session?.id ?? ''} onChange={event => setSessionId(event.target.value)}>
              {checkout.data?.sessions.map(item => <option key={item.id} value={item.id}>{item.registerName}</option>)}
            </select></div>
          <div><label htmlFor={`collection-amount-${customerId}`}>Importe a cobrar</label>
            <input id={`collection-amount-${customerId}`} inputMode="decimal" aria-invalid={!!collection.formState.errors.amount} {...collection.register('amount')} />
            {collection.formState.errors.amount ? <p role="alert">{collection.formState.errors.amount.message}</p> : null}</div>
          <div><label htmlFor={`collection-method-${customerId}`}>Medio del cobro</label>
            <select id={`collection-method-${customerId}`} {...collection.register('method')}>
              <option value="">Seleccionar medio</option>
              {checkout.data?.paymentMethods.map(method => <option key={method} value={method}>{methodNames[method] ?? method}</option>)}
            </select></div>
          <button type="submit" disabled={(data.balance === '0.00' && !recoveringCollection) || !checkout.data?.paymentMethods.length}>{busy ? 'Guardando…' : 'Registrar cobro'}</button>
        </fieldset>
      </form>
      {checkout.isPending ? <p role="status">Consultando cajas…</p> : null}
      {checkout.error ? <><ErrorSummary error={problem(checkout.error)} /><button type="button" onClick={() => void checkout.refetch()}>Reintentar cajas</button></> : null}
      {checkout.data && !session ? <p>Abrí una caja en esta sucursal para cobrar o revertir cobros.</p> : null}
      {data.balance === '0.00' ? <p>El cliente no tiene deuda pendiente.</p> : <p>En efectivo, registrá el importe aplicado a la deuda; el vuelto se entrega aparte.</p>}
      <h4>Movimientos de la cuenta</h4>
      {!data.entries.length ? <p>No hay movimientos en esta sucursal.</p> : <ol className={styles.history}>
        {data.entries.map(entry => <li key={entry.id}>
          <div className={styles.entryHeading}><strong>{entryNames[entry.kind]}</strong><strong>{formatAccountAmount(entry.amount, entry.currency)}</strong></div>
          <p><OrganizationTime value={entry.occurredAt} />{entry.method ? ` · ${methodNames[entry.method] ?? entry.method}` : ''}{entry.reversed ? ' · Compensado' : ''}</p>
          {entry.reason ? <p>Motivo: {entry.reason}</p> : null}
          {manage && entry.kind === 'COLLECTION' && !entry.reversed ? <button type="button" disabled={busy || !session} onClick={() => { setReversalId(entry.id); reversal.reset(); setError(null); }}>Revertir cobro</button> : null}
        </li>)}
      </ol>}
      <div className={styles.pagination}>
        {previousCursors.length ? <button type="button" disabled={busy} onClick={() => { setCursor(previousCursors.at(-1) ?? ''); setPreviousCursors(previousCursors.slice(0, -1)); }}>Movimientos anteriores de la página</button> : null}
        {data.nextCursor ? <button type="button" disabled={busy} onClick={() => { setPreviousCursors([...previousCursors, cursor]); setCursor(data.nextCursor ?? ''); }}>Ver movimientos más antiguos</button> : null}
      </div>
      {reversalId ? <form onSubmit={reversal.handleSubmit(reverse)} noValidate>
        <fieldset disabled={busy || !session} className={styles.fields}><legend>Confirmar reversión de cobro</legend>
          <p>Se restaura la deuda y se reintegra el importe por el mismo medio. En efectivo, la caja seleccionada registra la salida.</p>
          <div><label htmlFor={`reverse-reason-${customerId}`}>Motivo de reversión</label>
            <input id={`reverse-reason-${customerId}`} maxLength={500} aria-invalid={!!reversal.formState.errors.reason} {...reversal.register('reason')} />
            {reversal.formState.errors.reason ? <p role="alert">{reversal.formState.errors.reason.message}</p> : null}</div>
          <button type="submit">Confirmar reversión</button>
          <button type="button" onClick={() => setReversalId('')}>Cancelar reversión</button>
        </fieldset>
      </form> : null}
    </> : null}
  </section>;
}
