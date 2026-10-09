import { cleanup,render,screen,waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach,expect,it,vi } from 'vitest';
import { CashClosing,CashDifferenceReview } from '../src/features/cash/cash-closing';
import { ApiProblemError } from '../src/lib/api/client';
import type { CashSession } from '../src/features/cash/cash-api';

afterEach(cleanup);
const org='00000000-0000-4000-8000-000000000001',device='00000000-0000-4000-8000-000000000003';
const id='00000000-0000-4000-8000-000000000005',attempt='00000000-0000-4000-8000-000000000007';
const session:CashSession={id,cashRegisterId:org,registerName:'Mostrador',deviceId:device,status:'OPEN',openingCash:'8.25',
  expectedCash:'8.25',currencyCode:'ARS',openedAt:'2026-10-07T00:00:00Z'};
const proof={key:crypto.randomUUID(),signature:'proof',checkpoint:{version:1 as const,organizationId:org,deviceId:device,
  actorUserId:org,sessionId:id,sequence:'0',headHash:'0'.repeat(64),sessionSequence:'0',creationFrozen:true as const,pending:0 as const}};

it('T218B freezes before begin and requires final-sync before counted cash, then explains a difference',async()=>{
  const freeze=vi.fn().mockResolvedValue(proof),release=vi.fn(),finish=vi.fn();
  let syncFailed=false;
  const command=vi.fn(async(path:string,_body:unknown,_key:string)=>{
    void _body;void _key;
    if(path==='begin-close')return {cashSessionId:id,closeAttemptId:attempt,status:'CLOSING'};
    if(path==='final-sync'){
      if(!syncFailed){syncFailed=true;throw new ApiProblemError({status:0,code:'NETWORK_ERROR',message:'Conexión interrumpida.'});}
      return {cashSessionId:id,closeAttemptId:attempt,expectedCash:'8.25',ready:true};
    }
    return {cashSessionId:id,closeAttemptId:attempt,closureId:org,status:'CLOSED',expectedCash:'8.25',countedCash:'9.25',difference:'1.00'};
  });
  render(<CashClosing organizationId={org} actorUserId={org} role="CASHIER" session={session} localDeviceId={device}
    onPrepare={freeze} onCommand={command} onAbortRelease={release} onFinish={finish} onReload={vi.fn()}/>);
  expect(screen.queryByRole('textbox',{name:'Efectivo contado'})).toBeNull();
  await userEvent.click(screen.getByRole('button',{name:'Congelar y comenzar cierre'}));
  await screen.findByRole('button',{name:'Verificar sincronización final'});
  expect(freeze).toHaveBeenCalledBefore(command);
  expect(command).toHaveBeenCalledWith('begin-close',{checkpoint:proof.checkpoint,signature:proof.signature},proof.key);
  await userEvent.click(screen.getByRole('button',{name:'Verificar sincronización final'}));
  await screen.findByText('Conexión interrumpida.');
  expect(screen.queryByRole('textbox',{name:'Efectivo contado'})).toBeNull();
  const syncKey=command.mock.calls[1]?.[2];
  await userEvent.click(screen.getByRole('button',{name:'Verificar sincronización final'}));
  await screen.findByRole('textbox',{name:'Efectivo contado'});
  expect(command.mock.calls[2]?.[2]).toBe(syncKey);
  await userEvent.type(screen.getByRole('textbox',{name:'Efectivo contado'}),'9.25');
  await userEvent.click(screen.getByRole('button',{name:'Confirmar cierre'}));
  expect(command).toHaveBeenCalledTimes(3);
  await screen.findByText('Explicá la diferencia antes de cerrar.');
  await userEvent.type(screen.getByRole('textbox',{name:'Motivo del cierre'}),'Sobrante contado');
  await userEvent.click(screen.getByRole('button',{name:'Confirmar cierre'}));
  await waitFor(()=>expect(finish).toHaveBeenCalled());
  expect(screen.getByText(/Diferencia: 1.00 ARS/)).toBeTruthy();
});

it('T218B resumes the persisted attempt after reload and never thaws on a lost abort response',async()=>{
  const command=vi.fn().mockRejectedValueOnce(new ApiProblemError({status:0,code:'NETWORK_ERROR',message:'Sin respuesta.'}))
    .mockResolvedValue({cashSessionId:id,closeAttemptId:attempt,status:'OPEN'}),release=vi.fn();
  render(<CashClosing organizationId={org} actorUserId={org} role="OWNER" session={{...session,status:'CLOSING',closeAttemptId:attempt,
    finalSync:{ready:true,expectedCash:'8.25'}}} localDeviceId={device} onCommand={command} onAbortRelease={release}
    onPrepare={vi.fn()} onFinish={vi.fn()} onReload={vi.fn()}/>);
  expect(screen.getByRole('textbox',{name:'Efectivo contado'})).toBeTruthy();
  await userEvent.click(screen.getByRole('button',{name:'Abortar cierre'}));
  await screen.findByText('Sin respuesta.');expect(release).not.toHaveBeenCalled();
  const key=command.mock.calls[0]?.[2];
  await userEvent.click(screen.getByRole('button',{name:'Abortar cierre'}));
  await waitFor(()=>expect(release).toHaveBeenCalledWith(id,attempt,{cashSessionId:id,closeAttemptId:attempt,status:'OPEN'}));
  expect(command.mock.calls[1]?.[2]).toBe(key);
  expect(screen.queryByRole('textbox',{name:'Efectivo contado'})).toBeNull();
});

it('T218B recovers local completion from an authenticated final snapshot after losing the close response',async()=>{
  const finish=vi.fn().mockResolvedValue(undefined),command=vi.fn();
  render(<CashClosing organizationId={org} actorUserId={org} role="CASHIER" session={{...session,status:'CLOSED',
    closure:{expectedCash:'8.25',countedCash:'8.25',difference:'0.00',reason:null}}} localDeviceId={device}
    onFinish={finish} onCommand={command} onReload={vi.fn()}/>);
  await userEvent.click(screen.getByRole('button',{name:'Consolidar cierre en este equipo'}));
  await waitFor(()=>expect(finish).toHaveBeenCalledWith({cashSessionId:id,status:'CLOSED'},undefined));
  expect(command).not.toHaveBeenCalled();
});

it('T218B requires a justified self-review and preserves the financial snapshot',async()=>{
  const reviewId=crypto.randomUUID(),command=vi.fn().mockResolvedValue({id:reviewId,status:'REVIEWED',mode:'SELF_REVIEW',
    reviewerUserId:org,reviewedAt:'2026-10-07T00:00:00Z'});
  const original={...session,status:'CLOSED' as const,closure:{expectedCash:'8.25',countedCash:'9.25',difference:'1.00',reason:'Sobrante'},
    differenceReview:{id:reviewId,status:'PENDING_REVIEW' as const,selfReview:true,canReview:true}};
  const props={organizationId:org,actorUserId:org,role:'OWNER' as const,session:original,onCommand:command,onReload:vi.fn()};
  const view=render(<CashDifferenceReview {...props}/>);
  await userEvent.click(screen.getByRole('button',{name:'Confirmar autorrevisión justificada'}));
  await screen.findByText('Justificá por qué no existe otro revisor disponible.');expect(command).not.toHaveBeenCalled();
  await userEvent.type(screen.getByRole('textbox',{name:'Nota de revisión'}),'Único revisor con alcance.');
  await userEvent.click(screen.getByRole('button',{name:'Confirmar autorrevisión justificada'}));
  await screen.findByText('Diferencia revisada. El cierre y sus importes se conservan.');
  expect(command).toHaveBeenCalledWith('review-difference',{reviewId,note:'Único revisor con alcance.'},expect.any(String));
  expect(original.closure.difference).toBe('1.00');view.unmount();
  render(<CashDifferenceReview {...props} session={{...original,differenceReview:{...original.differenceReview,canReview:false}}}/>);
  expect(screen.queryByRole('button')).toBeNull();
});

it('T218B consolidates a server-confirmed abort after reload before signing another attempt',async()=>{
  const release=vi.fn().mockResolvedValue(undefined),prepare=vi.fn().mockResolvedValue(proof);
  const command=vi.fn().mockResolvedValue({cashSessionId:id,closeAttemptId:attempt,status:'CLOSING'});
  render(<CashClosing organizationId={org} actorUserId={org} role="CASHIER" session={{...session,
    lastAbortedAttemptId:attempt}} localDeviceId={device} onAbortRelease={release} onPrepare={prepare} onCommand={command} onReload={vi.fn()}/>);
  await userEvent.click(screen.getByRole('button',{name:'Congelar y comenzar cierre'}));
  await screen.findByRole('button',{name:'Abortar cierre'});
  expect(release).toHaveBeenCalledWith(id,attempt,{cashSessionId:id,closeAttemptId:attempt,status:'OPEN'});
  expect(release).toHaveBeenCalledBefore(prepare);
});
