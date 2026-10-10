import { cleanup,fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, expect, it, vi } from 'vitest';
import { CashOperations, type CashWorkspaceData } from '../src/features/cash/cash-operations';
import { ApiProblemError } from '../src/lib/api/client';
import { OrganizationTimezone } from '../src/components/organization-time';

afterEach(cleanup);
const org='00000000-0000-4000-8000-000000000001',branch='00000000-0000-4000-8000-000000000002';
const device='00000000-0000-4000-8000-000000000003',register='00000000-0000-4000-8000-000000000004';
const session='00000000-0000-4000-8000-000000000005';
const data:CashWorkspaceData={actorUserId:org,registers:[{id:register,name:'Mostrador',available:true}],
  devices:[{id:device,status:'ACTIVE'}],sessions:[]};

it('RF-271 shows the organization day across midnight while preserving the UTC timestamp', () => {
  const openedAt = '2026-10-07T00:00:00Z';
  const {container} = render(<OrganizationTimezone.Provider value="Pacific/Auckland">
    <CashOperations organizationId={org} branchId={branch} role="CASHIER" localDeviceId={device}
      data={{...data,sessions:[{id:session,cashRegisterId:register,registerName:'Mostrador',deviceId:device,
        status:'OPEN',openingCash:'5.00',expectedCash:'5.00',currencyCode:'ARS',openedAt}]}}
      onCommand={vi.fn()} onReload={vi.fn()} />
  </OrganizationTimezone.Provider>);
  const time = container.querySelector('time');
  expect(time?.dateTime).toBe(openedAt);
  expect(time?.textContent).toBe(new Date(openedAt).toLocaleString('es-AR',{timeZone:'Pacific/Auckland'}));
});

it('T218A opens with the bound device and retries the exact command after a lost response',async()=>{
  const submit=vi.fn().mockRejectedValueOnce(new ApiProblemError({status:0,code:'NETWORK_ERROR',message:'Conexión interrumpida.'}))
    .mockResolvedValue({id:session});
  const reload=vi.fn();
  const props={organizationId:org,branchId:branch,role:'CASHIER' as const,data,localDeviceId:device,onCommand:submit,onReload:reload};
  const view=render(<CashOperations {...props}/>);
  await userEvent.type(screen.getByRole('textbox',{name:'Efectivo inicial'}),'5.00');
  await userEvent.click(screen.getByRole('button',{name:'Abrir sesión'}));
  await screen.findByText('Conexión interrumpida.');
  const key=submit.mock.calls[0]?.[2];
  view.unmount();
  render(<CashOperations {...props}/>);
  await userEvent.type(screen.getByRole('textbox',{name:'Efectivo inicial'}),'5.00');
  await userEvent.click(screen.getByRole('button',{name:'Abrir sesión'}));
  await waitFor(()=>expect(reload).toHaveBeenCalled());
  expect(submit.mock.calls[1]).toEqual(['open',{branchId:branch,cashRegisterId:register,deviceId:device,openingCash:'5.00'},key]);
  expect(screen.getByRole('status').textContent).toContain('Sesión abierta');
});

it('T218A validates amount and reason, shows persisted state and denies another device and EMPLOYEE',async()=>{
  const submit=vi.fn().mockResolvedValue({id:org});
  const active:CashWorkspaceData={...data,sessions:[{id:session,cashRegisterId:register,registerName:'Mostrador',deviceId:device,
    status:'OPEN',openingCash:'5.00',expectedCash:'5.00',currencyCode:'ARS',openedAt:'2026-10-07T00:00:00Z'}]};
  const props={organizationId:org,branchId:branch,role:'CASHIER' as const,data:active,localDeviceId:device,onCommand:submit,onReload:vi.fn()};
  const view=render(<CashOperations {...props}/>);
  expect(screen.getByText(/Esperado: 5.00 ARS/)).toBeTruthy();
  await userEvent.click(screen.getByRole('button',{name:'Registrar movimiento'}));
  expect(submit).not.toHaveBeenCalled();
  await userEvent.type(screen.getByRole('textbox',{name:'Importe'}),'2.00');
  await userEvent.type(screen.getByRole('textbox',{name:'Motivo'}),'Cambio');
  await userEvent.selectOptions(screen.getByRole('combobox',{name:'Tipo de movimiento'}),'manual-withdrawals');
  await userEvent.click(screen.getByRole('button',{name:'Registrar movimiento'}));
  await waitFor(()=>expect(submit).toHaveBeenCalledWith('manual-withdrawals',
    {cashSessionId:session,deviceId:device,amount:'2.00',reason:'Cambio'},expect.any(String)));
  expect((await axe.run(view.container,{rules:{'color-contrast':{enabled:false}}})).violations).toEqual([]);
  view.unmount();
  const other=render(<CashOperations {...props} localDeviceId={branch}/>);
  expect(screen.queryByRole('button',{name:'Registrar movimiento'})).toBeNull();
  expect(screen.getByText(/dispositivo asociado/)).toBeTruthy();
  other.unmount();
  render(<CashOperations {...props} role="EMPLOYEE"/>);
  expect(screen.queryByRole('button',{name:'Abrir sesión'})).toBeNull();
  expect(screen.queryByRole('button',{name:'Registrar movimiento'})).toBeNull();
});

it('T218A explains an oversized reason in Spanish before sending the movement',async()=>{
  const command=vi.fn();
  render(<CashOperations organizationId={org} branchId={branch} role="CASHIER" data={{...data,sessions:[{
    id:session,cashRegisterId:register,registerName:'Mostrador',deviceId:device,status:'OPEN',openingCash:'5.00',
    expectedCash:'5.00',currencyCode:'ARS',openedAt:'2026-10-07T00:00:00Z'}]}} localDeviceId={device}
    onCommand={command} onReload={vi.fn()}/>);
  fireEvent.change(screen.getByRole('textbox',{name:'Importe'}),{target:{value:'2.00'}});
  fireEvent.change(screen.getByRole('textbox',{name:'Motivo'}),{target:{value:'x'.repeat(2001)}});
  await userEvent.click(screen.getByRole('button',{name:'Registrar movimiento'}));
  expect(await screen.findByText('El motivo no puede superar los 2000 caracteres.')).toBeTruthy();
  expect(command).not.toHaveBeenCalled();
});
