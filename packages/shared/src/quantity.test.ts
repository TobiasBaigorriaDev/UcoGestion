import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { Quantity } from './index.js';

describe('Quantity', () => {
  it('accepts only positive whole values for UNIT', () => {
    expect(Quantity.from('2', 'UNIT').toString()).toBe('2');
    expect(() => Quantity.from('2.5', 'UNIT')).toThrow();
    expect(() => Quantity.from('0', 'UNIT')).toThrow();
  });

  it('keeps fractional units positive and at three decimal places or less', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 999_999 }), (thousandths) => {
        const quantity = Quantity.from((thousandths / 1_000).toFixed(3), 'FRACTIONAL');
        expect(quantity.toString()).toMatch(/^\d+(?:\.\d{1,3})?$/);
      }),
    );
  });
});
