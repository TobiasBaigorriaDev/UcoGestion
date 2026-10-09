'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Money,subtractMoney,validateNonNegativeMoney } from '@uconext/shared';
import { ErrorSummary } from '../../components/error-summary';
import { ApiProblemError } from '../../lib/api/client';
import { CashCommandRetry,cashCommand,cashRejectionIsDefinitive,loadCashSession,type CashSession } from './cash-api';
import { cashError } from './cash-operations';
import { prepareCashClose,finishCashClose,type SignedCashClose } from './cash-close-client';
import styles from '../identity/management.module.css';

const reason=z.string().trim().min(1,'El motivo es obligatorio.').max(2000,'El motivo no puede superar los 2000 caracteres.');
const count=z.string().refine(value=>validateNonNegativeMoney(value)!==undefined,'Ingresá un importe no negativo con hasta dos decimales.');
const reconcileSchema=z.object({countedCash:count,reason,confirm:z.boolean().refine(value=>value,
  'Confirmá que conservarás separadas las sesiones y sus operaciones.')});
const exceptionalSchema=z.object({reason,countedCash:z.string().refine(value=>value==='' || validateNonNegativeMoney(value)!==undefined,
  'Ingresá un importe no negativo con hasta dos decimales, o dejalo vacío.'),confirm:z.boolean().refine(value=>value,
  'Confirmá que entendés la incertidumbre permanente antes de cerrar.')});
const resolvedSchema=z.object({cashSessionId:z.uuid(),closureId:z.uuid(),status:z.literal('CLOSED_CONFLICT_RESOLVED'),
  expectedCash:z.string(),countedCash:z.string(),difference:z.string()});

function useCashAction(partition:string,onCommand:(path:string,body:unknown,key:string)=>Promise<unknown>) {
  const [error,setError]=useState<ApiProblemError|null>(null),[busy,setBusy]=useState(false);
  const retry=new CashCommandRetry(partition);
  async function run(operation:()=>Promise<void>) {
    setBusy(true);setError(null);try{await operation();}catch(cause){setError(cashError(cause));}finally{setBusy(false);}
  }
  async function command(path:string,body:unknown,accept:(result:unknown)=>Promise<void>) {
    await run(async()=>{
      const key=await retry.key(path,body);
      try{await accept(await onCommand(path,body,key));retry.complete(path);}
      catch(cause){if(cashRejectionIsDefinitive(cause))retry.complete(path);throw cause;}
    });
  }
  return {error,busy,run,command};
}

export function CashExceptional({organizationId,branchId,actorUserId,role,session,localDeviceId,onReload,
  onPrepare=()=>prepareCashClose(organizationId,session.deviceId,actorUserId,session.id),
  onRead=()=>loadCashSession(organizationId,branchId,session.id),
  onCommand=(path,body,key)=>cashCommand(organizationId,path,body,key),
  onFinish=response=>finishCashClose(organizationId,session.deviceId,session.id,response)}:{
  organizationId:string;branchId:string;actorUserId:string;role:'OWNER'|'ADMIN'|'CASHIER'|'EMPLOYEE';session:CashSession;
  localDeviceId?:string|undefined;onReload:(status?:CashSession['status'])=>void;onPrepare?:()=>Promise<SignedCashClose>;
  onRead?:()=>Promise<CashSession>;onCommand?:(path:string,body:unknown,key:string)=>Promise<unknown>;onFinish?:(response:unknown)=>Promise<void>;
}) {
  const manager=role==='OWNER' || role==='ADMIN';
  const final=session.status==='CLOSED_WITH_UNRECOVERED_DEVICE';
  const partition=`${organizationId}:${actorUserId}:${session.id}`;
  if(final)return <section className={styles.rows} aria-label="Cierre excepcional y datos tardíos"><h2>Cierre por dispositivo irrecuperable</h2>
    <p>Completitud operativa desconocida (UNKNOWN), permanente. La revisión no convierte este cierre en normal.</p>
    <p>Dispositivo asociado: {session.deviceId}</p>
    {session.exceptionalClosure?<><p>Esperado conocido del snapshot original: {session.exceptionalClosure.expectedCashKnown} {session.currencyCode}</p>
      <p>{session.exceptionalClosure.countedCash===null?'Contado original: no registrado.':`Contado original: ${session.exceptionalClosure.countedCash} ${session.currencyCode}`}</p>
      <p>{session.exceptionalClosure.differenceObserved===null?'Diferencia original: no registrada.':`Diferencia original: ${session.exceptionalClosure.differenceObserved} ${session.currencyCode}`}</p>
      <p>Motivo original: {session.exceptionalClosure.reason}</p>
      <p>Último contacto al cerrar: {session.exceptionalClosure.lastContactAt?<time dateTime={session.exceptionalClosure.lastContactAt}>
        {new Date(session.exceptionalClosure.lastContactAt).toLocaleString('es-AR')}</time>:'sin dato conocido.'}</p>
      <details><summary>Operaciones recibidas al cerrar ({session.exceptionalClosure.operationsReceived.length})</summary>
        {session.exceptionalClosure.operationsReceived.length?<ul>{session.exceptionalClosure.operationsReceived.map(row=><li key={row.operationId}>
          Secuencia {row.sequence} · Operación {row.operationId} · Recibida <time dateTime={row.receivedAt}>{new Date(row.receivedAt).toLocaleString('es-AR')}</time>
        </li>)}</ul>:<p>No había operaciones recibidas en el snapshot original.</p>}</details>
    </>:<p>Cargá nuevamente la sesión para consultar el snapshot original.</p>}
    <p>Esperado conocido actualizado: {session.expectedCash} {session.currencyCode}</p>
    <p>La incertidumbre histórica conserva restricciones y versiones necesarias para operaciones que puedan reaparecer.</p>
    {session.currencyPermanentlyLocked?<p>Moneda base bloqueada permanentemente por operaciones potencialmente desconocidas.</p>:null}
    {session.lateData?<CashLateReview key={session.lateData.throughOperationId} session={session} manager={manager} partition={partition}
      onCommand={onCommand} onReload={onReload}/>:<p>No se recibieron datos tardíos.</p>}
  </section>;
  if(session.deviceStatus==='UNRECOVERABLE' && ['OPEN','CLOSING','CONFLICTED'].includes(session.status))return <section className={styles.rows} aria-label="Cierre excepcional">
    <h2>Dispositivo irrecuperable</h2><p>El cierre normal está bloqueado. La información puede tener operaciones desconocidas.</p>
    <p>Esperado conocido ahora: {session.expectedCash} {session.currencyCode}. La caja quedará disponible tras el cierre, conservando la incertidumbre histórica.</p>
    {manager?<ExceptionalClose key={session.id} session={session} partition={partition} onCommand={onCommand} onReload={onReload}/>
      :<p>Solo OWNER o ADMIN con alcance puede confirmar el cierre excepcional.</p>}
  </section>;
  if(session.status!=='CONFLICTED')return null;
  return <section className={styles.rows} aria-label="Conciliación de sesión en conflicto"><h2>Sesión en conflicto</h2>
    <p>Esta sesión no admite cierre normal. La conciliación conserva separadas las sesiones, ventas y operaciones; no genera compensaciones automáticas.</p>
    {manager && localDeviceId===session.deviceId?<CashReconciliation key={session.id} session={session} partition={partition} onPrepare={onPrepare}
      onRead={onRead} onCommand={onCommand} onFinish={onFinish} onReload={onReload}/>
      :<p>OWNER o ADMIN con alcance debe conciliar desde el dispositivo asociado. Si es irrecuperable, primero debe declararlo en la administración de dispositivos.</p>}
  </section>;
}

function CashReconciliation({session,partition,onPrepare,onRead,onCommand,onFinish,onReload}:{session:CashSession;partition:string;
  onPrepare:()=>Promise<SignedCashClose>;onRead:()=>Promise<CashSession>;onCommand:(path:string,body:unknown,key:string)=>Promise<unknown>;
  onFinish:(response:unknown)=>Promise<void>;onReload:(status?:CashSession['status'])=>void}) {
  const [prepared,setPrepared]=useState<{signed:SignedCashClose;expectedCash:string}|null>(null),[done,setDone]=useState(false);
  const action=useCashAction(`${partition}:reconcile`,onCommand);
  const form=useForm<z.infer<typeof reconcileSchema>>({resolver:zodResolver(reconcileSchema),defaultValues:{countedCash:'',reason:'',confirm:false}});
  const counted=form.watch('countedCash');
  const difference=prepared && validateNonNegativeMoney(counted)!==undefined?subtractMoney(Money.from(counted).toString(),prepared.expectedCash):null;
  return <><ErrorSummary error={action.error}/>{done?<p role="status">Sesión conciliada por separado.</p>:prepared?<form noValidate onSubmit={form.handleSubmit(values=>action.command('reconcile',
    {checkpoint:prepared.signed.checkpoint,signature:prepared.signed.signature,countedCash:Money.from(values.countedCash).toString(),reason:values.reason},async response=>{
      const result=resolvedSchema.parse(response);if(result.cashSessionId!==session.id)throw new Error('OFFLINE_CHECKPOINT_INVALID');
      await onFinish(result);setDone(true);onReload('CLOSED_CONFLICT_RESOLVED');
    }))}>
    <p>Esperado conocido al preparar: {prepared.expectedCash} {session.currencyCode}</p>
    <p>Creación congelada y pendientes entregados. Conservá esta sesión bloqueada hasta confirmar la conciliación.</p>
    <div className={styles.fields}><div><label htmlFor="cash-reconcile-count">Efectivo contado</label><input id="cash-reconcile-count" inputMode="decimal"
      aria-invalid={!!form.formState.errors.countedCash} aria-describedby="cash-reconcile-count-error" {...form.register('countedCash')}/>
      <p id="cash-reconcile-count-error">{form.formState.errors.countedCash?.message ?? 'Contá el efectivo de esta sesión.'}</p></div>
      <div><label htmlFor="cash-reconcile-reason">Motivo u observación</label><input id="cash-reconcile-reason" aria-invalid={!!form.formState.errors.reason}
        aria-describedby="cash-reconcile-reason-error" {...form.register('reason')}/>
        <p id="cash-reconcile-reason-error">{form.formState.errors.reason?.message ?? 'Explicá el resultado de la conciliación.'}</p></div></div>
    {difference!==null?<p role="status">Diferencia observada: {difference} {session.currencyCode}</p>:null}
    <div className={styles.checks}><label><input type="checkbox" aria-describedby="cash-reconcile-confirm-error" aria-invalid={!!form.formState.errors.confirm}
      {...form.register('confirm')}/>Conservar las sesiones separadas, sin reasignar ventas ni compensaciones automáticas.</label></div>
    <p id="cash-reconcile-confirm-error">{form.formState.errors.confirm?.message ?? 'La conciliación es definitiva y queda auditada.'}</p>
    <button disabled={action.busy} type="submit">Confirmar conciliación</button>
  </form>:<button type="button" disabled={action.busy} onClick={()=>void action.run(async()=>{
    const signed=await onPrepare(),current=await onRead();
    if(current.id!==session.id || current.status!=='CONFLICTED' || current.deviceStatus==='UNRECOVERABLE')throw new Error('CASH_CLOSE_STATE_INVALID');
    setPrepared({signed,expectedCash:current.expectedCash});
  })}>Preparar conciliación</button>}</>;
}

function ExceptionalClose({session,partition,onCommand,onReload}:{session:CashSession;partition:string;
  onCommand:(path:string,body:unknown,key:string)=>Promise<unknown>;onReload:(status?:CashSession['status'])=>void}) {
  const action=useCashAction(`${partition}:exceptional`,onCommand),[done,setDone]=useState(false);
  const form=useForm<z.infer<typeof exceptionalSchema>>({resolver:zodResolver(exceptionalSchema),defaultValues:{reason:'',countedCash:'',confirm:false}});
  if(done)return <p role="status">Cierre excepcional confirmado. La completitud permanece desconocida.</p>;
  return <form noValidate onSubmit={form.handleSubmit(values=>action.command('exceptional-close',
    {cashSessionId:session.id,confirm:true,reason:values.reason,...(values.countedCash===''?{}:{countedCash:Money.from(values.countedCash).toString()})},async response=>{
      const result=z.object({cashSessionId:z.uuid(),closureId:z.uuid(),status:z.literal('CLOSED_WITH_UNRECOVERED_DEVICE')}).parse(response);
      if(result.cashSessionId!==session.id)throw new Error('OFFLINE_CHECKPOINT_INVALID');setDone(true);onReload(result.status);
    }))}><ErrorSummary error={action.error}/><div className={styles.fields}>
    <div><label htmlFor="cash-exceptional-reason">Motivo del cierre excepcional</label><input id="cash-exceptional-reason" aria-invalid={!!form.formState.errors.reason}
      aria-describedby="cash-exceptional-reason-error" {...form.register('reason')}/><p id="cash-exceptional-reason-error">{form.formState.errors.reason?.message ?? 'El motivo es obligatorio y queda auditado.'}</p></div>
    <div><label htmlFor="cash-exceptional-count">Efectivo contado (opcional)</label><input id="cash-exceptional-count" inputMode="decimal"
      aria-invalid={!!form.formState.errors.countedCash} aria-describedby="cash-exceptional-count-error" {...form.register('countedCash')}/>
      <p id="cash-exceptional-count-error">{form.formState.errors.countedCash?.message ?? 'Dejalo vacío si no fue contado; no se registra como cero.'}</p></div></div>
    <div className={styles.checks}><label><input type="checkbox" aria-invalid={!!form.formState.errors.confirm} aria-describedby="cash-exceptional-confirm-error"
      {...form.register('confirm')}/>Entiendo que la información operativa quedará desconocida permanentemente y confirmo el cierre excepcional.</label></div>
    <p id="cash-exceptional-confirm-error">{form.formState.errors.confirm?.message ?? 'No libera restricciones históricas ni el bloqueo permanente de moneda.'}</p>
    <button disabled={action.busy} type="submit">Confirmar cierre excepcional</button>
  </form>;
}

function CashLateReview({session,manager,partition,onCommand,onReload}:{session:CashSession;manager:boolean;partition:string;
  onCommand:(path:string,body:unknown,key:string)=>Promise<unknown>;onReload:(status?:CashSession['status'])=>void}) {
  const late=session.lateData,[done,setDone]=useState(false),action=useCashAction(`${partition}:late:${late?.throughOperationId}`,onCommand);
  const schema=z.object({note:z.string().trim().max(2000,'La nota no puede superar los 2000 caracteres.'),
    confirm:z.boolean().refine(value=>value,'Confirmá la revisión de las operaciones recuperadas.')});
  const form=useForm<z.infer<typeof schema>>({resolver:zodResolver(schema),defaultValues:{note:'',confirm:false}});
  if(!late)return null;
  return <><h3>Operaciones recuperadas tardíamente</h3><p>Datos tardíos (LATE_RECOVERED_OPERATIONS): {late.count} operaciones. Última secuencia recibida: {late.sequence}.</p>
    <p>Recuperación más reciente: <time dateTime={late.receivedAt}>{new Date(late.receivedAt).toLocaleString('es-AR')}</time></p>
    {done || late.status==='REVIEWED'?<p role="status">Datos tardíos revisados. La completitud sigue siendo desconocida.</p>:manager?<form noValidate onSubmit={form.handleSubmit(values=>action.command('review-late-data',
      {cashSessionId:session.id,throughOperationId:late.throughOperationId,note:values.note},async response=>{
        const result=z.object({cashSessionId:z.uuid(),throughOperationId:z.uuid(),status:z.literal('REVIEWED'),reviewedAt:z.string()}).parse(response);
        if(result.cashSessionId!==session.id || result.throughOperationId!==late.throughOperationId)throw new Error('OFFLINE_CHECKPOINT_INVALID');
        setDone(true);onReload();
      }))}><ErrorSummary error={action.error}/><p>Revisión pendiente. Nuevas recuperaciones requerirán otra revisión.</p>
      <div className={styles.fields}><div><label htmlFor="cash-late-note">Nota de revisión de datos tardíos</label><input id="cash-late-note"
        aria-invalid={!!form.formState.errors.note} aria-describedby="cash-late-note-error" {...form.register('note')}/>
        <p id="cash-late-note-error">{form.formState.errors.note?.message ?? 'Registrá lo que verificaste, sin modificar el snapshot original.'}</p></div></div>
      <div className={styles.checks}><label><input type="checkbox" aria-invalid={!!form.formState.errors.confirm} aria-describedby="cash-late-confirm-error"
        {...form.register('confirm')}/>Revisé las operaciones recuperadas hasta la secuencia indicada, conservando el cierre excepcional.</label></div>
      <p id="cash-late-confirm-error">{form.formState.errors.confirm?.message ?? 'Se registra una revisión independiente, sin nuevos movimientos.'}</p>
      <button disabled={action.busy} type="submit">Confirmar revisión de datos tardíos</button>
    </form>:<p>Revisión pendiente de OWNER o ADMIN con alcance.</p>}
  </>;
}
