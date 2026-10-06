import fc from 'fast-check';
import { expect, it } from 'vitest';
import { calculateSaleLine, calculatePercentageDiscount, subtractMoney, sumMoney } from './index.js';

const money = (cents: bigint) => `${cents / 100n}.${(cents % 100n).toString().padStart(2, '0')}`;

it('rounds a large valid line once, preserving the cent found by the offline property regression', () => {
  expect(calculateSaleLine('0.410', '58043747049713873.89')).toBe('23797936290382688.29');
  expect(sumMoney(['23797936290382688.29', '0.01'])).toBe('23797936290382688.30');
  expect(subtractMoney('23797936290382688.30', '0.01')).toBe('23797936290382688.29');
});

it('rounds percentage discounts at numeric bounds against an integer arithmetic oracle', () => {
  fc.assert(fc.property(fc.bigInt({ min: 1n, max: 99999999999999999999n }),
    fc.integer({ min: 0, max: 10000 }), (subtotal, hundredths) => {
      const percentage = money(BigInt(hundredths));
      const expected = (subtotal * BigInt(hundredths) + 5000n) / 10000n;
      expect(calculatePercentageDiscount(money(subtotal), percentage)).toBe(money(expected));
    }));
});
