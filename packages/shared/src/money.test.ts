import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { Money } from './index.js';

describe('Money', () => {
  it('rounds persisted values with HALF_UP to two decimal places', () => {
    expect(Money.from('1.005').toString()).toBe('1.01');
    expect(Money.from('-1.005').toString()).toBe('-1.01');
  });

  it('is stable when its canonical representation is parsed again', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -1_000_000, max: 1_000_000 }),
        fc.integer({ min: 0, max: 9_999 }),
        (whole, fraction) => {
          const sign = whole < 0 ? '-' : '';
          const value = `${sign}${Math.abs(whole)}.${String(fraction).padStart(4, '0')}`;
          const money = Money.from(value);

          expect(Money.from(money.toString()).toString()).toBe(money.toString());
          expect(money.toString()).toMatch(/^-?\d+\.\d{2}$/);
        },
      ),
    );
  });
});
