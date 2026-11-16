'use client';

import { useEffect,useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { ErrorSummary } from '../../components/error-summary';
import { CashOperations,cashError } from './cash-operations';
import { findLocalCashDevice,loadCashWorkspace,type CashView,type CashSession } from './cash-api';
import { CashClosing } from './cash-closing';
import { CashExceptional } from './cash-exceptional';
import cashStyles from './cash.module.css';

export function CashWorkspace({organizationId,branchId,role}:{organizationId:string;branchId:string;role:'OWNER'|'ADMIN'|'CASHIER'|'EMPLOYEE'}) {
  const [view,setView]=useState<CashView>('ACTIVE');
  const query=useInfiniteQuery({queryKey:['cash-workspace',organizationId,branchId,view],initialPageParam:undefined as string|undefined,
    queryFn:({pageParam})=>loadCashWorkspace(organizationId,branchId,{view,...(pageParam?{cursor:pageParam}:{})}),
    getNextPageParam:page=>page.nextCursor ?? undefined,
    enabled:role!=='EMPLOYEE',refetchOnWindowFocus:true});
  const first=query.data?.pages[0],sessions=query.data?.pages.flatMap(page=>page.sessions) ?? [];
  const [device,setDevice]=useState<string|undefined>(),[loadingDevice,setLoadingDevice]=useState(true);
  useEffect(()=>{
    let current=true;
    if (first) void findLocalCashDevice(organizationId,[...first.devices].sort((a,b)=>
      Number(sessions.some(row=>row.deviceId===b.id))-Number(sessions.some(row=>row.deviceId===a.id)))).then(id=>{if(current)setDevice(id);})
      .catch(()=>{if(current)setDevice(undefined);}).finally(()=>{if(current)setLoadingDevice(false);});
    return ()=>{current=false;};
  },[organizationId,query.data]); // Pages share a server-authorized device list.
  if (role==='EMPLOYEE') return <p role="status">Tu rol no opera la caja.</p>;
  if (query.error) return <><ErrorSummary error={cashError(query.error)}/><button onClick={()=>void query.refetch()}>Volver a cargar cajas</button></>;
  function reload(status?:CashSession['status']) {
    if(status==='CLOSED' || status==='CLOSED_CONFLICT_RESOLVED' || status==='CLOSED_WITH_UNRECOVERED_DEVICE')setView('FINAL');
    else void query.refetch();
  }
  const viewSelector=<div className={cashStyles.viewFilter}><label htmlFor="cash-view">Ver turnos</label><select id="cash-view" value={view} onChange={event=>setView(event.target.value as CashView)}>
    <option value="ACTIVE">Abiertos o en cierre</option><option value="FINAL">Cerrados</option><option value="PENDING_REVIEW">Con diferencias para revisar</option></select></div>;
  return <>
    {!first || loadingDevice?<>{viewSelector}<p role="status">Cargando turnos y este equipo…</p></>:<CashOperations viewSelector={viewSelector}
      key={`${organizationId}:${branchId}:${first.actorUserId}:${device ?? 'unbound'}:${view}`} organizationId={organizationId} branchId={branchId} role={role}
      data={{...first,sessions}} localDeviceId={device} onReload={()=>reload()}
      sessionActions={session=>session.status==='CONFLICTED' || session.status==='CLOSED_WITH_UNRECOVERED_DEVICE'
        || session.deviceStatus==='UNRECOVERABLE' && (session.status==='OPEN' || session.status==='CLOSING')
        ?<CashExceptional key={session.id} organizationId={organizationId} branchId={branchId} actorUserId={first.actorUserId}
          role={role} session={session} localDeviceId={device} onReload={reload}/>
        :<CashClosing key={session.id} organizationId={organizationId} actorUserId={first.actorUserId}
          role={role} session={session} localDeviceId={device} onReload={reload}/>}/>}
    {query.hasNextPage?<button type="button" disabled={query.isFetchingNextPage} onClick={()=>void query.fetchNextPage()}>Cargar más turnos</button>:null}
  </>;
}
