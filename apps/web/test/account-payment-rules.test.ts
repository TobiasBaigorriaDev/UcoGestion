import { expect, it } from 'vitest';
import { accountPaymentBalance } from '../src/features/sales/pos-payment-rules.js';
it('validates real payments separately from credit, including received cash and excess', () => {
  expect(accountPaymentBalance('10.00', [])).toMatchObject({ valid: true, deferred: '10.00', change: '0.00' });
  expect(accountPaymentBalance('10.00', [{ method: 'CASH', appliedAmount: '4.00', receivedAmount: '5.00' }])).toMatchObject({ valid: true, deferred: '6.00', change: '1.00' });
  expect(accountPaymentBalance('10.00', [{ method: 'CASH', appliedAmount: '4.00', receivedAmount: '3.00' }]).valid).toBe(false);
  expect(accountPaymentBalance('10.00', [{ method: 'TRANSFER', appliedAmount: '11.00' }]).valid).toBe(false);
});
