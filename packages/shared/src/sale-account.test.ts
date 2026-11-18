import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { calculateSaleSettlement } from './index.js';

describe('sale settlement', () => {
  it('distinguishes complete payment, full credit and partial credit', () => {
    expect(calculateSaleSettlement('100.00', ['40.00'], true)).toEqual({ paidAmount: '40.00', onAccountAmount: '60.00' });
    expect(calculateSaleSettlement('100.00', [], true)).toEqual({ paidAmount: '0.00', onAccountAmount: '100.00' });
    expect(calculateSaleSettlement('100.00', ['100.00'], false)).toEqual({ paidAmount: '100.00', onAccountAmount: '0.00' });
    expect(() => calculateSaleSettlement('100.00', ['40.00'], false)).toThrow();
    for (const payments of [['100.01'], ['-1.00'], ['0.00'], ['NaN'], ['0.001']]) {
      expect(() => calculateSaleSettlement('100.00', payments, true)).toThrow();
    }
    expect(calculateSaleSettlement('0.00', [], false)).toEqual({ paidAmount: '0.00', onAccountAmount: '0.00' });
  });
  it('conserves each cent with a bigint oracle', () => {
    const money = (cents: bigint) => `${cents / 100n}.${(cents % 100n).toString().padStart(2, '0')}`;
    fc.assert(fc.property(fc.bigInt({ min: 1n, max: 99999999999999999999n }), fc.nat({ max: 100 }), (total, percent) => {
      const paid = total * BigInt(percent) / 100n;
      expect(calculateSaleSettlement(money(total), paid ? [money(paid)] : [], true))
        .toEqual({ paidAmount: money(paid), onAccountAmount: money(total - paid) });
    }));
  });
});
