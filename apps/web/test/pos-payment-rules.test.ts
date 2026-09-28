import { describe, expect, it } from 'vitest';

import { paymentBalance } from '../src/features/sales/pos-payment-rules.js';

describe('T152C payment balance', () => {
  it('accepts exact mixed payments and computes cash change', () => {
    expect(paymentBalance('11.00', [
      { method: 'CASH', appliedAmount: '6.00', receivedAmount: '10.00' },
      { method: 'TRANSFER', appliedAmount: '5.00' },
    ])).toEqual({ valid: true, change: '4.00' });
  });

  it('requires no payment for a zero total', () => {
    expect(paymentBalance('0.00', [])).toEqual({ valid: true, change: '0.00' });
    expect(paymentBalance('0.00', [{ method: 'CASH', appliedAmount: '0.00' }]).valid).toBe(false);
  });

  it('rejects short, excess, and malformed payments', () => {
    expect(paymentBalance('10.00', [{ method: 'CASH', appliedAmount: '9.00' }]).valid).toBe(false);
    expect(paymentBalance('10.00', [{ method: 'CASH', appliedAmount: '11.00' }]).valid).toBe(false);
    expect(paymentBalance('10.00', [{ method: 'CASH', appliedAmount: '10.00', receivedAmount: '9.00' }]).valid).toBe(false);
    expect(paymentBalance('10.00', [{ method: 'CASH', appliedAmount: '1e1' }]).valid).toBe(false);
  });
});
