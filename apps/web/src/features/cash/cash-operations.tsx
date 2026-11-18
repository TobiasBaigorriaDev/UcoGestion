'use client';
import { OrganizationTime } from '../../components/organization-time';

import { useEffect,useState, type ReactNode } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Money, validateNonNegativeMoney, validatePositiveMoney } from '@uconext/shared';
import { z } from 'zod';
import { ErrorSummary } from '../../components/error-summary';
import { ApiProblemError } from '../../lib/api/client';
import { CashCommandRetry, cashCommand,cashRejectionIsDefinitive, type CashSession, type CashWorkspaceData } from './cash-api';
import styles from '../identity/management.module.css';
import cashStyles from './cash.module.css';
import { formatMoney } from '../../lib/format';
import { moneyInputHint, parseMoneyInput } from '../../lib/money-input';

export type { CashWorkspaceData } from './cash-api';
const openingSchema=z.object({cashRegisterId:z.uuid('Seleccioná una caja disponible.'),
  openingCash:z.string().refine(v=>{const amount=parseMoneyInput(v);return amount!==null && validateNonNegativeMoney(amount)!==undefined;},'Ingresá un importe válido, por ejemplo 0, 1500 o 1.500,50.')});
const movementSchema=z.object({path:z.enum(['manual-deposits','manual-withdrawals']),
  amount:z.string().refine(v=>{const amount=parseMoneyInput(v);return amount!==null && validatePositiveMoney(amount)!==undefined;},'Ingresá un importe mayor que cero, por ejemplo 2500 o 2.500,50.'),
  reason:z.string().trim().min(1,'El motivo es obligatorio.').max(2000,'El motivo no puede superar los 2000 caracteres.')});
export function cashError(cause:unknown):ApiProblemError {
  if (cause instanceof ApiProblemError) return cause;
  const code=cause instanceof Error ? cause.message : 'REQUEST_FAILED';
  const message=code==='OFFLINE_PENDING' ? 'Todavía hay operaciones pendientes. Sincronizá y reintentá; la sesión sigue congelada.'
    : 'No pudimos completar la operación. Revisá la conexión, actualizá el estado y reintentá.';
  return new ApiProblemError({status:0,code,message});
}

export function CashOperations({organizationId,branchId,role,data,localDeviceId,onReload,
  onCommand=(path,body,key)=>cashCommand(organizationId,path,body,key),sessionActions,viewSelector}: {
  organizationId:string;branchId:string;role:'OWNER'|'ADMIN'|'CASHIER'|'EMPLOYEE';data:CashWorkspaceData;
  localDeviceId?:string|undefined;onReload:()=>void;onCommand?:(path:string,body:unknown,key:string)=>Promise<unknown>;
  sessionActions?:(session:CashSession)=>ReactNode;
  /** Filter of which shifts to list, rendered under the page title. */
  viewSelector?:ReactNode;
}) {
  const [error,setError]=useState<ApiProblemError|null>(null),[message,setMessage]=useState(''),[busy,setBusy]=useState(false);
  const [selected,setSelected]=useState(data.sessions[0]?.id ?? '');
  const session=data.sessions.find(row=>row.id===selected) ?? data.sessions[0];
  const device=data.devices.find(row=>row.id===localDeviceId && row.status==='ACTIVE');
  const available=data.registers.filter(row=>row.available);
  const opening=useForm<z.infer<typeof openingSchema>>({resolver:zodResolver(openingSchema),
    defaultValues:{cashRegisterId:available[0]?.id ?? '',openingCash:''}});
  const movement=useForm<z.infer<typeof movementSchema>>({resolver:zodResolver(movementSchema),
    defaultValues:{path:'manual-deposits',amount:'',reason:''}});
  const resetMovement=movement.reset;
  useEffect(()=>{resetMovement();},[session?.id,resetMovement]);
  const retry=new CashCommandRetry(`${organizationId}:${data.actorUserId}:${localDeviceId ?? 'unbound'}`);
  async function execute(path:string,body:unknown,success:string,reset:()=>void) {
    setBusy(true);setError(null);setMessage('');
    try {
      const key=await retry.key(path,body);
      await onCommand(path,body,key);retry.complete(path);reset();setMessage(success);onReload();
    } catch (cause) {
      // An HTTP rejection is definitive; transport/processing failures retain the exact retry.
      if (cashRejectionIsDefinitive(cause)) retry.complete(path);
      setError(cashError(cause));
    } finally {setBusy(false);}
  }
  if (role==='EMPLOYEE') return <p role="status">Tu rol no opera la caja.</p>;
  const canEnableDevice = role === 'OWNER' || role === 'ADMIN';
  const statusName = (status: CashSession['status']) => shiftStatusName(status);
  return <section className={styles.page} aria-labelledby="cash-sessions-heading">
    <header className={styles.heading}><h1 id="cash-sessions-heading">Turno de caja</h1>
      <p>Abrí el turno, registrá entradas y salidas de efectivo y cerrá la caja al final del día.</p></header>
    {viewSelector}
    <ErrorSummary error={error}/>{message ? <p role="status">{message}</p>:null}
    {session ? <section className={`${styles.panel} ${cashStyles.summary}`} aria-label="Turno actual">
      <div className={cashStyles.summaryHead}><h2>{session.registerName}</h2>
        <span className={cashStyles.state} data-state={session.status}>{statusName(session.status)}</span></div>
      <dl className={cashStyles.figures}>
        <div><dt>Efectivo esperado en la caja</dt><dd className={cashStyles.expected}>{formatMoney(session.expectedCash,session.currencyCode)}</dd></div>
        <div><dt>Apertura</dt><dd><OrganizationTime value={session.openedAt} /> · Inicial {formatMoney(session.openingCash,session.currencyCode)}</dd></div>
      </dl>
    </section>:null}
    {!device ? <section className={`${styles.panel} ${cashStyles.notice}`} aria-label="Este equipo no está habilitado para la caja">
      <h2>Este equipo no está habilitado para la caja</h2>
      {canEnableDevice ? <><p>Para abrir turnos y cobrar desde este equipo, habilitalo una sola vez: creás un PIN y queda autorizado para esta sucursal.</p>
        <a className={cashStyles.primaryLink} href="/workspace/offline">Habilitar este equipo</a></>
        : <p>Pedile al dueño o a un administrador que habilite este equipo para la caja. Después vas a poder abrir tu turno desde acá.</p>}
    </section>:null}
    {device && available.length ? <form className={styles.panel} noValidate onSubmit={opening.handleSubmit(values=>execute('open',
      {branchId,cashRegisterId:values.cashRegisterId,deviceId:device.id,openingCash:Money.from(parseMoneyInput(values.openingCash) ?? values.openingCash).toString()},
      'Turno abierto. Ya podés vender desde el Mostrador.',()=>opening.reset()))}>
      <h2>Abrir turno</h2><div className={styles.fields}>
        <div><label htmlFor="cash-opening-register">Caja</label><select id="cash-opening-register" {...opening.register('cashRegisterId')}>
          {available.map(row=><option key={row.id} value={row.id}>{row.name}</option>)}</select>
          {opening.formState.errors.cashRegisterId ? <p role="alert">{opening.formState.errors.cashRegisterId.message}</p>:null}</div>
        <div><label htmlFor="cash-opening-amount">Efectivo inicial</label><input id="cash-opening-amount" inputMode="decimal"
          aria-invalid={!!opening.formState.errors.openingCash} aria-describedby="cash-opening-error" {...opening.register('openingCash')}/>
          <p id="cash-opening-error">{opening.formState.errors.openingCash?.message ?? 'Lo que hay en la caja ahora. Podés empezar con 0.'}</p></div>
      </div><p className={cashStyles.note}>Este equipo queda asociado al turno hasta que lo cierres.</p>
      <button type="submit" className={cashStyles.primaryButton} disabled={busy}>{busy?'Abriendo…':'Abrir turno'}</button>
    </form>:null}
    {data.sessions.length===0 ? <p className={cashStyles.empty}>No hay turnos en esta vista.</p>:<section className={styles.panel} aria-labelledby="cash-active-heading">
      <h2 id="cash-active-heading">{data.sessions.length>1?'Turnos de la sucursal':'Movimientos y cierre'}</h2>
      {data.sessions.length>1 ? <><label htmlFor="cash-session">Turno</label><select id="cash-session" value={session?.id ?? ''} disabled={busy}
        onChange={event=>{setSelected(event.target.value);movement.reset();setError(null);setMessage('');}}>
        {data.sessions.map(row=><option key={row.id} value={row.id}>{row.registerName} · {statusName(row.status)}</option>)}</select></>:null}
      {session ? <>
        {session.status==='OPEN' && device?.id===session.deviceId ? <form noValidate className={cashStyles.movement} onSubmit={movement.handleSubmit(values=>execute(values.path,
          {cashSessionId:session.id,deviceId:session.deviceId,amount:Money.from(parseMoneyInput(values.amount) ?? values.amount).toString(),reason:values.reason},
          'Movimiento registrado.',()=>movement.reset()))}>
          <h3>Ingresar o retirar efectivo</h3>
          <div className={styles.fields}><div><label htmlFor="cash-movement-type">Tipo de movimiento</label>
            <select id="cash-movement-type" {...movement.register('path')}><option value="manual-deposits">Ingreso de efectivo</option>
              <option value="manual-withdrawals">Retiro de efectivo</option></select></div>
            <div><label htmlFor="cash-movement-amount">Importe</label><input id="cash-movement-amount" inputMode="decimal"
              aria-invalid={!!movement.formState.errors.amount} aria-describedby="cash-movement-amount-error" {...movement.register('amount')}/>
              <p id="cash-movement-amount-error">{movement.formState.errors.amount?.message ?? moneyInputHint}</p></div>
            <div><label htmlFor="cash-movement-reason">Motivo</label><input id="cash-movement-reason"
              aria-invalid={!!movement.formState.errors.reason} aria-describedby="cash-movement-reason-error" {...movement.register('reason')}/>
              <p id="cash-movement-reason-error">{movement.formState.errors.reason?.message ?? 'Por ejemplo: cambio para el día, pago a un proveedor.'}</p></div></div>
          <button type="submit" disabled={busy}>Registrar movimiento</button>
        </form>:session.status==='OPEN' ? <p>Este turno se opera desde el equipo donde se abrió (dispositivo asociado).</p>:null}
        {sessionActions?.(session)}</>:null}
    </section>}
  </section>;
}

function shiftStatusName(status: CashSession['status']): string {
  return status==='OPEN'?'Abierto':status==='CLOSING'?'Cerrando':status==='CONFLICTED'?'Con conflicto':'Cerrado';
}
