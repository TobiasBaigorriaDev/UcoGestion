import { cleanup,render,screen,waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach,expect,it,vi } from 'vitest';
import { CashExceptional } from '../src/features/cash/cash-exceptional';
import type { CashSession } from '../src/features/cash/cash-api';
import { ApiProblemError } from '../src/lib/api/client';

afterEach(cleanup);
const org='00000000-0000-4000-8000-000000000101',device='00000000-0000-4000-8000-000000000103';
const id='00000000-0000-4000-8000-000000000105';
const session:CashSession={id,cashRegisterId:org,registerName:'Mostrador',deviceId:device,status:'CONFLICTED',openingCash:'10.00',
  expectedCash:'10.00',currencyCode:'ARS',openedAt:'2026-10-07T00:00:00Z',deviceStatus:'ACTIVE',completeness:'COMPLETE'};
const proof={key:crypto.randomUUID(),signature:'proof',checkpoint:{version:1 as const,organizationId:org,deviceId:device,
  actorUserId:org,sessionId:id,sequence:'0',headHash:'0'.repeat(64),sessionSequence:'0',creationFrozen:true as const,pending:0 as const}};

it('T218C freezes before reconciliation, shows the refreshed known expected and requires explicit confirmation',async()=>{
  const prepare=vi.fn().mockResolvedValue(proof),read=vi.fn().mockResolvedValue({...session,expectedCash:'12.00'}),finish=vi.fn();
  const command=vi.fn().mockResolvedValue({cashSessionId:id,closureId:org,status:'CLOSED_CONFLICT_RESOLVED',expectedCash:'12.00',countedCash:'13.00',difference:'1.00'});
  render(<CashExceptional organizationId={org} branchId={org} actorUserId={org} role="OWNER" session={session} localDeviceId={device}
    onPrepare={prepare} onRead={read} onCommand={command} onFinish={finish} onReload={vi.fn()}/>);
  await userEvent.click(screen.getByRole('button',{name:'Preparar conciliación'}));
  await screen.findByText('Esperado conocido al preparar: 12.00 ARS');expect(prepare).toHaveBeenCalledBefore(read);
  await userEvent.type(screen.getByRole('textbox',{name:'Efectivo contado'}),'13.00');
  await userEvent.type(screen.getByRole('textbox',{name:'Motivo u observación'}),'Conciliación independiente');
  await userEvent.click(screen.getByRole('button',{name:'Confirmar conciliación'}));expect(command).not.toHaveBeenCalled();
  await screen.findByText('Confirmá que conservarás separadas las sesiones y sus operaciones.');
  await userEvent.click(screen.getByRole('checkbox',{name:/Conservar las sesiones separadas/}));
  await userEvent.click(screen.getByRole('button',{name:'Confirmar conciliación'}));
  await waitFor(()=>expect(finish).toHaveBeenCalled());
  expect(command).toHaveBeenCalledWith('reconcile',{checkpoint:proof.checkpoint,signature:proof.signature,countedCash:'13.00',reason:'Conciliación independiente'},expect.any(String));
});

it('T218C only allows managers to confirm exceptional close and preserves an unknown counted amount',async()=>{
  const command=vi.fn().mockRejectedValueOnce(new ApiProblemError({status:0,code:'NETWORK_ERROR',message:'Sin respuesta.'}))
    .mockResolvedValue({cashSessionId:id,closureId:org,status:'CLOSED_WITH_UNRECOVERED_DEVICE'});
  const props={organizationId:org,branchId:org,actorUserId:org,role:'OWNER' as const,session:{...session,status:'OPEN' as const,deviceStatus:'UNRECOVERABLE' as const},onCommand:command,onReload:vi.fn()};
  const view=render(<CashExceptional {...props}/>);
  await userEvent.type(screen.getByRole('textbox',{name:'Motivo del cierre excepcional'}),'Equipo extraviado');
  await userEvent.click(screen.getByRole('button',{name:'Confirmar cierre excepcional'}));expect(command).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole('checkbox',{name:/Entiendo que la información/}));
  await userEvent.click(screen.getByRole('button',{name:'Confirmar cierre excepcional'}));await screen.findByText('Sin respuesta.');
  const key=command.mock.calls[0]?.[2];
  await userEvent.click(screen.getByRole('button',{name:'Confirmar cierre excepcional'}));
  await waitFor(()=>expect(props.onReload).toHaveBeenCalledWith('CLOSED_WITH_UNRECOVERED_DEVICE'));
  expect(command.mock.calls[1]?.[2]).toBe(key);
  expect(command.mock.calls[1]?.[1]).toEqual({cashSessionId:id,confirm:true,reason:'Equipo extraviado'});
  view.unmount();render(<CashExceptional {...props} role="CASHIER"/>);
  expect(screen.queryByRole('button',{name:'Confirmar cierre excepcional'})).toBeNull();
});

it('T218C distinguishes original exceptional snapshot from late values and requires a new review for a new cutoff',async()=>{
  const operation=crypto.randomUUID(),next=crypto.randomUUID(),command=vi.fn().mockResolvedValue({cashSessionId:id,throughOperationId:operation,status:'REVIEWED',reviewedAt:'2026-10-07T00:00:00Z'});
  const final:CashSession={...session,status:'CLOSED_WITH_UNRECOVERED_DEVICE',deviceStatus:'UNRECOVERABLE',completeness:'UNKNOWN',expectedCash:'30.00',
    exceptionalClosure:{expectedCashKnown:'10.00',countedCash:null,differenceObserved:null,lastContactAt:null,reason:'Equipo perdido',operationsReceived:[]},
    lateData:{marker:'LATE_RECOVERED_OPERATIONS',throughOperationId:operation,sequence:'2',receivedAt:'2026-10-07T00:00:00Z',count:'1',status:'PENDING_REVIEW'}};
  const props={organizationId:org,branchId:org,actorUserId:org,role:'ADMIN' as const,session:final,onCommand:command,onReload:vi.fn()};
  const view=render(<CashExceptional {...props}/>);
  expect(screen.getByText('Esperado conocido del snapshot original: 10.00 ARS')).toBeTruthy();
  expect(screen.getByText('Esperado conocido actualizado: 30.00 ARS')).toBeTruthy();
  expect(screen.getByText('Contado original: no registrado.')).toBeTruthy();
  await userEvent.click(screen.getByRole('checkbox',{name:/Revisé las operaciones recuperadas/}));
  await userEvent.click(screen.getByRole('button',{name:'Confirmar revisión de datos tardíos'}));
  await screen.findByText('Datos tardíos revisados. La completitud sigue siendo desconocida.');
  expect(command).toHaveBeenCalledWith('review-late-data',{cashSessionId:id,throughOperationId:operation,note:''},expect.any(String));
  view.rerender(<CashExceptional {...props} session={{...final,expectedCash:'50.00',lateData:{...final.lateData!,throughOperationId:next,sequence:'3',count:'2'}}}/>);
  expect(screen.getByRole('button',{name:'Confirmar revisión de datos tardíos'})).toBeTruthy();
  expect(screen.getByText('Esperado conocido del snapshot original: 10.00 ARS')).toBeTruthy();
});
