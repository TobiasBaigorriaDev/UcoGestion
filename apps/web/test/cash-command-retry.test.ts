import { expect,it } from 'vitest';
import { CashCommandRetry } from '../src/features/cash/cash-api';

it('retains only an opaque retry key/hash, refuses changed data and partitions identities',async()=>{
  const partition=crypto.randomUUID();
  const retry=new CashCommandRetry(partition),body={amount:'2.00',reason:'Motivo privado'};
  const key=await retry.key('manual-deposits',body);
  expect(await new CashCommandRetry(partition).key('manual-deposits',body)).toBe(key);
  await expect(retry.key('manual-deposits',{...body,amount:'3.00'})).rejects.toMatchObject({code:'CASH_RETRY_PENDING'});
  expect(await new CashCommandRetry(`${partition}:other`).key('manual-deposits',body)).not.toBe(key);
  expect(localStorage.getItem(`uco-cash-retry:${partition}:manual-deposits`)).not.toContain('Motivo privado');
  expect(localStorage.getItem(`uco-cash-retry:${partition}:manual-deposits`)).not.toContain('2.00');
  retry.complete('manual-deposits');
  expect(await retry.key('manual-deposits',body)).not.toBe(key);
});
