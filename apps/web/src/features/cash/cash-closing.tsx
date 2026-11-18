'use client';

import { useEffect,useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Money,subtractMoney,validateNonNegativeMoney } from '@uconext/shared';
import { z } from 'zod';
import { ErrorSummary } from '../../components/error-summary';
import { ApiProblemError } from '../../lib/api/client';
import { CashCommandRetry,cashCommand,cashRejectionIsDefinitive,type CashSession } from './cash-api';
import { cashError } from './cash-operations';
import { prepareCashClose,releaseCashAbort,finishCashClose,type SignedCashClose } from './cash-close-client';
import styles from '../identity/management.module.css';
import cashStyles from './cash.module.css';
import { formatMoney } from '../../lib/format';
import { parseMoneyInput } from '../../lib/money-input';

const countSchema=z.object({countedCash:z.string().refine(value=>{const amount=parseMoneyInput(value);return amount!==null && validateNonNegativeMoney(amount)!==undefined;},
  'Ingresá el efectivo contado, por ejemplo 22300 o 22.300,50.'),
  reason:z.string().trim().max(2000,'El motivo no puede superar los 2000 caracteres.')});
const beginSchema=z.object({cashSessionId:z.uuid(),closeAttemptId:z.uuid(),status:z.literal('CLOSING')});
const syncSchema=z.object({cashSessionId:z.uuid(),closeAttemptId:z.uuid(),expectedCash:z.string(),ready:z.literal(true)});
const closedSchema=z.object({cashSessionId:z.uuid(),closeAttemptId:z.uuid(),closureId:z.uuid(),status:z.literal('CLOSED'),
  expectedCash:z.string(),countedCash:z.string(),difference:z.string()});
const abortSchema=z.object({cashSessionId:z.uuid(),closeAttemptId:z.uuid(),status:z.literal('OPEN')});

export function CashClosing({organizationId,actorUserId,role,session,localDeviceId,onReload,
  onPrepare=()=>prepareCashClose(organizationId,session.deviceId,actorUserId,session.id),
  onCommand=(path,body,key)=>cashCommand(organizationId,path,body,key),
  onAbortRelease=(id,attempt,response)=>releaseCashAbort(organizationId,session.deviceId,id,attempt,response),
  onFinish=(response,attempt)=>finishCashClose(organizationId,session.deviceId,session.id,response,attempt)}:{
  organizationId:string;actorUserId:string;role:'OWNER'|'ADMIN'|'CASHIER'|'EMPLOYEE';session:CashSession;localDeviceId?:string|undefined;
  onReload:(status?:CashSession['status'])=>void;onPrepare?:()=>Promise<SignedCashClose>;
  onCommand?:(path:string,body:unknown,key:string)=>Promise<unknown>;
  onAbortRelease?:(id:string,attempt:string,response:unknown)=>Promise<void>;
  onFinish?:(response:unknown,attempt?:string)=>Promise<void>;
}) {
  const [phase,setPhase]=useState(session.status),[attempt,setAttempt]=useState(session.closeAttemptId ?? null);
  const [expected,setExpected]=useState(session.finalSync?.expectedCash ?? null),[closed,setClosed]=useState<z.infer<typeof closedSchema>|null>(null);
  const [error,setError]=useState<ApiProblemError|null>(null),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
  const form=useForm<z.infer<typeof countSchema>>({resolver:zodResolver(countSchema),defaultValues:{countedCash:'',reason:''}});
  const reset=form.reset;
  useEffect(()=>{setPhase(session.status);setAttempt(session.closeAttemptId ?? null);setExpected(session.finalSync?.expectedCash ?? null);
    reset();},[session.id,session.status,session.closeAttemptId,session.finalSync?.expectedCash,reset]);
  const retry=new CashCommandRetry(`${organizationId}:${actorUserId}:${session.deviceId}:${session.id}:${attempt ?? 'begin'}`);
  async function command(path:string,body:unknown) {
    const key=await retry.key(path,body);
    try{const result=await onCommand(path,body,key);return {result,key};}
    catch(cause){if(cashRejectionIsDefinitive(cause))retry.complete(path);throw cause;}
  }
  async function run(operation:()=>Promise<void>) {
    setBusy(true);setError(null);setMessage('');
    try{await operation();}catch(cause){setError(cashError(cause));}finally{setBusy(false);}
  }
  async function begin() {
    await run(async()=>{
      if(session.status==='OPEN' && session.lastAbortedAttemptId)await onAbortRelease(session.id,session.lastAbortedAttemptId,
        {cashSessionId:session.id,closeAttemptId:session.lastAbortedAttemptId,status:'OPEN'});
      const signed=await onPrepare();
      const result=beginSchema.parse(await onCommand('begin-close',{checkpoint:signed.checkpoint,signature:signed.signature},signed.key));
      if(result.cashSessionId!==session.id)throw new Error('OFFLINE_CHECKPOINT_INVALID');
      setAttempt(result.closeAttemptId);setExpected(null);setPhase('CLOSING');
      setMessage('Cierre empezado: las ventas en esta caja quedan en pausa.');onReload('CLOSING');
    });
  }
  async function synchronize() {
    if(!attempt)return;
    await run(async()=>{
      const {result}=await command('final-sync',{cashSessionId:session.id,deviceId:session.deviceId,closeAttemptId:attempt});
      const sync=syncSchema.parse(result);
      if(sync.cashSessionId!==session.id || sync.closeAttemptId!==attempt)throw new Error('OFFLINE_CHECKPOINT_INVALID');
      retry.complete('final-sync');setExpected(sync.expectedCash);setMessage('Todas las ventas llegaron. Ya podés contar el efectivo.');onReload('CLOSING');
    });
  }
  async function confirm(values:z.infer<typeof countSchema>) {
    if(!attempt || expected===null)return;
    const countedCash=Money.from(parseMoneyInput(values.countedCash) ?? values.countedCash).toString(),difference=subtractMoney(countedCash,expected);
    if(difference!=='0.00' && !values.reason){form.setError('reason',{message:'Explicá la diferencia antes de cerrar.'},{shouldFocus:true});return;}
    await run(async()=>{
      const {result}=await command('close',{cashSessionId:session.id,deviceId:session.deviceId,closeAttemptId:attempt,
        expectedCash:expected,countedCash,reason:values.reason});
      const snapshot=closedSchema.parse(result);
      if(snapshot.cashSessionId!==session.id || snapshot.closeAttemptId!==attempt)throw new Error('OFFLINE_CHECKPOINT_INVALID');
      await onFinish(snapshot,attempt);retry.complete('close');setClosed(snapshot);setPhase('CLOSED');setExpected(null);form.reset();
      setMessage('Caja cerrada. Los importes y movimientos quedan guardados.');onReload('CLOSED');
    });
  }
  async function abort() {
    if(!attempt)return;
    await run(async()=>{
      const {result}=await command('abort-close',{cashSessionId:session.id,deviceId:session.deviceId,closeAttemptId:attempt});
      const response=abortSchema.parse(result);
      if(response.cashSessionId!==session.id || response.closeAttemptId!==attempt)throw new Error('OFFLINE_CHECKPOINT_INVALID');
      await onAbortRelease(session.id,attempt,response);retry.complete('abort-close');setAttempt(null);setExpected(null);setPhase('OPEN');form.reset();
      setMessage('Cierre cancelado. La caja vuelve a estar abierta para vender.');onReload('OPEN');
    });
  }
  const canOperate=role!=='EMPLOYEE' && localDeviceId===session.deviceId;
  const currency=session.currencyCode,money=(value:string)=>formatMoney(value,currency);
  const count=form.watch('countedCash'),counted=parseMoneyInput(count);
  const difference=expected!==null && counted!==null && validateNonNegativeMoney(counted)!==undefined
    ? subtractMoney(Money.from(counted).toString(),expected):null;
  const snapshot=closed ?? session.closure;
  const finished=phase==='CLOSED' || phase==='CLOSED_CONFLICT_RESOLVED';
  const stage=finished?4:phase==='CLOSING'?(expected!==null?2:1):0;
  const stepState=(index:number)=>index<stage?'done':index===stage?'current':'pending';
  const steps=['Empezar el cierre','Revisar ventas pendientes','Contar el efectivo','Confirmar el cierre'];
  return <section aria-label="Cierre de la sesión" className={styles.rows}>
    <h2>Cerrar la caja</h2><ErrorSummary error={error}/>{message?<p role="status">{message}</p>:null}
    {!finished?<ol className={cashStyles.steps} aria-label="Pasos para cerrar la caja">
      {steps.map((title,index)=><li key={title} data-state={stepState(index)}>
        <div><h3>{title}</h3>
          {index===0 && stage===0?<><p>Se frenan las ventas en esta caja para contar con tranquilidad. Si te arrepentís, podés cancelar y seguir vendiendo.</p>
            {canOperate?<button type="button" className={cashStyles.primaryButton} disabled={busy} onClick={()=>void begin()}>Empezar el cierre</button>
              :<p>El cierre se empieza desde el equipo donde se abrió el turno.</p>}</>:null}
          {index===1 && stage===1?<>{canOperate && attempt?<><p>Comprobamos que todas las ventas de este equipo, incluidas las hechas sin conexión, ya llegaron al servidor.</p>
            <button type="button" className={cashStyles.primaryButton} disabled={busy} onClick={()=>void synchronize()}>Revisar ventas pendientes</button></>
            :<p>Retomá el cierre desde el equipo donde se abrió el turno.</p>}</>:null}
          {index===2 && stage===2 && expected!==null?<form noValidate onSubmit={form.handleSubmit(confirm)}>
            <p>En la caja debería haber <strong className={cashStyles.expectedInline}>{money(expected)}</strong></p>
            <div className={styles.fields}>
              <div><label htmlFor={`cash-counted-${session.id}`}>Efectivo contado</label><input id={`cash-counted-${session.id}`} inputMode="decimal"
                aria-invalid={!!form.formState.errors.countedCash} aria-describedby={`cash-counted-error-${session.id}`} {...form.register('countedCash')}/>
                <p id={`cash-counted-error-${session.id}`}>{form.formState.errors.countedCash?.message ?? 'Contá los billetes y monedas de la caja.'}</p></div>
              <div><label htmlFor={`cash-close-reason-${session.id}`}>Motivo de la diferencia</label><input id={`cash-close-reason-${session.id}`}
                aria-invalid={!!form.formState.errors.reason} aria-describedby={`cash-close-reason-error-${session.id}`} {...form.register('reason')}/>
                <p id={`cash-close-reason-error-${session.id}`}>{form.formState.errors.reason?.message ?? 'Solo si lo contado no coincide.'}</p></div></div>
            {difference!==null?<p role="status" className={cashStyles.difference}
              data-kind={difference==='0.00'?'even':difference.startsWith('-')?'short':'over'}>
              {difference==='0.00'?'El efectivo coincide':difference.startsWith('-')?`Faltan ${money(difference.slice(1))}`:`Sobran ${money(difference)}`}</p>:null}
            <button type="submit" className={cashStyles.primaryButton} disabled={busy}>Confirmar cierre</button></form>:null}
        </div>
      </li>)}
    </ol>:null}
    {phase==='CLOSING' && canOperate && attempt?<p className={cashStyles.note}>
      <button type="button" className={cashStyles.secondary} disabled={busy} onClick={()=>void abort()}>Cancelar el cierre</button>{' '}
      La caja vuelve a quedar abierta para vender; no se pierde ningún importe.</p>:null}
    {finished?<section aria-label="Caja cerrada" className={cashStyles.closedPanel}><h3>Caja cerrada</h3>{snapshot?<dl className={cashStyles.closed}>
      <div><dt>Esperado</dt><dd>{money(snapshot.expectedCash)}</dd></div>
      <div><dt>Contado</dt><dd>{money(snapshot.countedCash)}</dd></div>
      <div><dt>Diferencia</dt><dd>{money(snapshot.difference)}</dd></div></dl>:null}
      {canOperate?<><p className={cashStyles.note}>Si se cortó la conexión justo al cerrar, actualizá este equipo para que también lo dé por cerrado.</p>
        <button type="button" disabled={busy} onClick={()=>void run(async()=>{
          await onFinish({cashSessionId:session.id,status:phase},undefined);setMessage('Este equipo quedó actualizado con el cierre.');
        })}>Actualizar este equipo con el cierre</button></>:null}
      <CashDifferenceReview organizationId={organizationId} actorUserId={actorUserId} role={role} session={session} onCommand={onCommand} onReload={()=>onReload()}/>
    </section>:null}
  </section>;
}

export function CashDifferenceReview({organizationId,actorUserId,role,session,onCommand,onReload}:{organizationId:string;actorUserId:string;
  role:'OWNER'|'ADMIN'|'CASHIER'|'EMPLOYEE';session:CashSession;onCommand:(path:string,body:unknown,key:string)=>Promise<unknown>;onReload:()=>void}) {
  const review=session.differenceReview,[error,setError]=useState<ApiProblemError|null>(null),[busy,setBusy]=useState(false),[done,setDone]=useState(false);
  const schema=z.object({note:z.string().trim().max(2000,'La nota no puede superar los 2000 caracteres.')
    .refine(value=>!review?.selfReview || !!value,'Justificá por qué no existe otro revisor disponible.')});
  const form=useForm<z.infer<typeof schema>>({resolver:zodResolver(schema),defaultValues:{note:''}});
  if(!review)return null;
  if(done || review.status==='REVIEWED')return <p role="status">Diferencia revisada. El cierre y sus importes se conservan.</p>;
  if(role!=='OWNER' && role!=='ADMIN')return <p>Diferencia pendiente de revisión del dueño o un administrador.</p>;
  if(!review.canReview)return <p>Otro dueño o administrador de la sucursal debe revisar esta diferencia; no se permite la autorrevisión si hay alternativa.</p>;
  const retry=new CashCommandRetry(`${organizationId}:${actorUserId}:review:${review.id}`);
  return <form noValidate onSubmit={form.handleSubmit(async values=>{
    setBusy(true);setError(null);
    try{
      const body={reviewId:review.id,note:values.note},key=await retry.key('review-difference',body);
      const result=z.object({id:z.uuid(),status:z.literal('REVIEWED'),mode:z.enum(['REVIEW','SELF_REVIEW']),reviewerUserId:z.uuid(),reviewedAt:z.string()})
        .parse(await onCommand('review-difference',body,key));
      if(result.id!==review.id)throw new Error('OFFLINE_CHECKPOINT_INVALID');
      retry.complete('review-difference');setDone(true);onReload();
    }catch(cause){if(cashRejectionIsDefinitive(cause))retry.complete('review-difference');setError(cashError(cause));}finally{setBusy(false);}
  })}><h3>Revisar diferencia</h3><ErrorSummary error={error}/>
    <p>{review.selfReview?'Autorrevisión: justificá que no hay otro revisor activo con alcance.':'La revisión deja constancia; conserva los importes y movimientos del cierre.'}</p>
    <div className={styles.fields}><div><label htmlFor={`cash-review-note-${review.id}`}>Nota de revisión</label>
      <input id={`cash-review-note-${review.id}`} aria-invalid={!!form.formState.errors.note}
        aria-describedby={`cash-review-error-${review.id}`} {...form.register('note')}/>
      <p id={`cash-review-error-${review.id}`}>{form.formState.errors.note?.message ?? 'Registrá el resultado de tu revisión.'}</p></div></div>
    <button type="submit" disabled={busy}>{review.selfReview?'Confirmar autorrevisión justificada':'Confirmar revisión de diferencia'}</button>
  </form>;
}
