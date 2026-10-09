'use client';

import { useEffect,useState, type ReactNode } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Money, validateNonNegativeMoney, validatePositiveMoney } from '@uconext/shared';
import { z } from 'zod';
import { ErrorSummary } from '../../components/error-summary';
import { ApiProblemError } from '../../lib/api/client';
import { CashCommandRetry, cashCommand,cashRejectionIsDefinitive, type CashSession, type CashWorkspaceData } from './cash-api';
import styles from '../identity/management.module.css';

export type { CashWorkspaceData } from './cash-api';
const openingSchema=z.object({cashRegisterId:z.uuid('Seleccioná una caja disponible.'),
  openingCash:z.string().refine(v=>validateNonNegativeMoney(v)!==undefined,'Ingresá un importe no negativo con hasta dos decimales.')});
const movementSchema=z.object({path:z.enum(['manual-deposits','manual-withdrawals']),
  amount:z.string().refine(v=>validatePositiveMoney(v)!==undefined,'Ingresá un importe mayor que cero con hasta dos decimales.'),
  reason:z.string().trim().min(1,'El motivo es obligatorio.').max(2000,'El motivo no puede superar los 2000 caracteres.')});
export function cashError(cause:unknown):ApiProblemError {
  if (cause instanceof ApiProblemError) return cause;
  const code=cause instanceof Error ? cause.message : 'REQUEST_FAILED';
  const message=code==='OFFLINE_PENDING' ? 'Todavía hay operaciones pendientes. Sincronizá y reintentá; la sesión sigue congelada.'
    : 'No pudimos completar la operación. Revisá la conexión, actualizá el estado y reintentá.';
  return new ApiProblemError({status:0,code,message});
}

export function CashOperations({organizationId,branchId,role,data,localDeviceId,onReload,
  onCommand=(path,body,key)=>cashCommand(organizationId,path,body,key),sessionActions}: {
  organizationId:string;branchId:string;role:'OWNER'|'ADMIN'|'CASHIER'|'EMPLOYEE';data:CashWorkspaceData;
  localDeviceId?:string|undefined;onReload:()=>void;onCommand?:(path:string,body:unknown,key:string)=>Promise<unknown>;
  sessionActions?:(session:CashSession)=>ReactNode;
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
  if (role==='EMPLOYEE') return <p role="status">No tenés permisos para operar sesiones de caja.</p>;
  return <section className={styles.page} aria-labelledby="cash-sessions-heading">
    <header className={styles.heading}><h1 id="cash-sessions-heading">Sesiones de caja</h1>
      <p>Abrí tu turno y registrá los movimientos de efectivo de la sucursal activa.</p></header>
    <ErrorSummary error={error}/>{message ? <p role="status">{message}</p>:null}
    {!device ? <p role="status">Este equipo no tiene un dispositivo autorizado para esta sucursal. Pedí a OWNER o ADMIN que lo autorice antes de operar.</p>:null}
    {device && available.length ? <form className={styles.panel} noValidate onSubmit={opening.handleSubmit(values=>execute('open',
      {branchId,cashRegisterId:values.cashRegisterId,deviceId:device.id,openingCash:Money.from(values.openingCash).toString()},
      'Sesión abierta. El estado se actualiza desde el servidor.',()=>opening.reset()))}>
      <h2>Abrir sesión</h2><div className={styles.fields}>
        <div><label htmlFor="cash-opening-register">Caja disponible</label><select id="cash-opening-register" {...opening.register('cashRegisterId')}>
          {available.map(row=><option key={row.id} value={row.id}>{row.name}</option>)}</select>
          {opening.formState.errors.cashRegisterId ? <p role="alert">{opening.formState.errors.cashRegisterId.message}</p>:null}</div>
        <div><label htmlFor="cash-opening-amount">Efectivo inicial</label><input id="cash-opening-amount" inputMode="decimal"
          aria-invalid={!!opening.formState.errors.openingCash} aria-describedby="cash-opening-error" {...opening.register('openingCash')}/>
          <p id="cash-opening-error">{opening.formState.errors.openingCash?.message ?? 'Podés comenzar con 0.00.'}</p></div>
      </div><p>El dispositivo de este equipo quedará asociado durante todo el turno.</p>
      <button type="submit" disabled={busy}>{busy?'Procesando…':'Abrir sesión'}</button>
    </form>:null}
    <section className={styles.panel} aria-labelledby="cash-active-heading"><h2 id="cash-active-heading">Sesiones de la sucursal</h2>
      {data.sessions.length===0 ? <p>No hay sesiones en esta vista y tu alcance.</p>:<>
        <label htmlFor="cash-session">Sesión</label><select id="cash-session" value={session?.id ?? ''} disabled={busy}
          onChange={event=>{setSelected(event.target.value);movement.reset();setError(null);setMessage('');}}>
          {data.sessions.map(row=><option key={row.id} value={row.id}>{row.registerName} · {row.status==='OPEN'?'Abierta':row.status==='CLOSING'?'En cierre':row.status==='CONFLICTED'?'En conflicto':'Finalizada'}</option>)}</select>
        {session ? <><p>Esperado: {session.expectedCash} {session.currencyCode}</p>
          <p>Apertura: <time dateTime={session.openedAt}>{new Date(session.openedAt).toLocaleString('es-AR')}</time> · Inicial: {session.openingCash} {session.currencyCode}</p>
          {session.status==='OPEN' && device?.id===session.deviceId ? <form noValidate onSubmit={movement.handleSubmit(values=>execute(values.path,
            {cashSessionId:session.id,deviceId:session.deviceId,amount:Money.from(values.amount).toString(),reason:values.reason},
            'Movimiento registrado. El estado se actualiza desde el servidor.',()=>movement.reset()))}>
            <div className={styles.fields}><div><label htmlFor="cash-movement-type">Tipo de movimiento</label>
              <select id="cash-movement-type" {...movement.register('path')}><option value="manual-deposits">Ingreso de efectivo</option>
                <option value="manual-withdrawals">Retiro de efectivo</option></select></div>
              <div><label htmlFor="cash-movement-amount">Importe</label><input id="cash-movement-amount" inputMode="decimal"
                aria-invalid={!!movement.formState.errors.amount} aria-describedby="cash-movement-amount-error" {...movement.register('amount')}/>
                <p id="cash-movement-amount-error">{movement.formState.errors.amount?.message ?? 'Usá punto decimal. Ejemplo: 25.50.'}</p></div>
              <div><label htmlFor="cash-movement-reason">Motivo</label><input id="cash-movement-reason"
                aria-invalid={!!movement.formState.errors.reason} aria-describedby="cash-movement-reason-error" {...movement.register('reason')}/>
                <p id="cash-movement-reason-error">{movement.formState.errors.reason?.message ?? 'Describí por qué ingresa o sale el efectivo.'}</p></div></div>
            <button type="submit" disabled={busy}>Registrar movimiento</button>
          </form>:session.status==='OPEN' ? <p>Operá desde el dispositivo asociado a esta sesión.</p>:<p>Esta sesión no admite movimientos manuales.</p>}
          {sessionActions?.(session)}</>:null}
      </>}
    </section>
  </section>;
}
