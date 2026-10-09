import 'fake-indexeddb/auto';
import { cleanup,render,screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach,expect,it,vi } from 'vitest';
import { CashWorkspace } from '../src/features/cash/cash-workspace';
import { RemoteProvider } from '../src/features/identity/remote-provider';

afterEach(()=>{cleanup();vi.unstubAllGlobals();});
it('T218B loads another authorized page and the final-session view without keeping an active selection',async()=>{
  const org=crypto.randomUUID(),branch=crypto.randomUUID(),device=crypto.randomUUID(),register=crypto.randomUUID();
  const row=(name:string,status:'OPEN'|'CLOSED')=>({id:crypto.randomUUID(),cashRegisterId:register,registerName:name,deviceId:device,
    status,openingCash:'0.00',expectedCash:'0.00',currencyCode:'ARS',openedAt:'2026-10-07T00:00:00Z',
    ...(status==='CLOSED'?{deviceStatus:'UNRECOVERABLE',closure:{expectedCash:'0.00',countedCash:'0.00',difference:'0.00',reason:null}}:{})});
  const first=row('Primera','OPEN'),second=row('Segunda','OPEN'),final=row('Histórica','CLOSED');
  vi.stubGlobal('fetch',vi.fn(async(input:string)=>{
    const url=new URL(input,'http://localhost');
    const isFinal=url.searchParams.get('view')==='FINAL',next=url.searchParams.has('cursor');
    return Response.json({actorUserId:org,registers:[],devices:[],sessions:[isFinal?final:next?second:first],
      nextCursor:isFinal || next ? null:'next-page'});
  }));
  render(<RemoteProvider><CashWorkspace organizationId={org} branchId={branch} role="OWNER"/></RemoteProvider>);
  await screen.findByRole('option',{name:'Primera · Abierta'});
  await userEvent.click(screen.getByRole('button',{name:'Cargar más sesiones'}));
  await screen.findByRole('option',{name:'Segunda · Abierta'});
  await userEvent.selectOptions(screen.getByRole('combobox',{name:'Mostrar sesiones'}),'FINAL');
  await screen.findByRole('option',{name:'Histórica · Finalizada'});
  expect(screen.queryByRole('option',{name:'Primera · Abierta'})).toBeNull();
  expect(screen.getByText('Diferencia: 0.00 ARS')).toBeTruthy();
});
