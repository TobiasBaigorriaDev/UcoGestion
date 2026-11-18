import { expect, it } from 'vitest';
import fc from 'fast-check';
import { formatQuantityForDisplay } from './index.js';

it.each([
  ['24.000', '24'], ['0', '0'], ['0.500', '0,50'], ['1.235', '1,24'],
  ['-1.235', '-1,24'], ['12345678901234567.995', '12345678901234568,00'],
])('formats %s as %s without changing its stored precision', (value, expected) => {
  expect(formatQuantityForDisplay(value)).toBe(expected);
});

it('rounds fractional quantities exactly using an independent integer oracle', () => {
  fc.assert(fc.property(fc.bigInt({ min: 0n, max: 99999999999999999999n }), (milli) => {
    const value = `${milli / 1000n}.${(milli % 1000n).toString().padStart(3, '0')}`;
    const cents = (milli + 5n) / 10n;
    const expected = milli % 1000n === 0n ? (milli / 1000n).toString()
      : `${cents / 100n},${(cents % 100n).toString().padStart(2, '0')}`;
    expect(formatQuantityForDisplay(value)).toBe(expected);
  }));
});
