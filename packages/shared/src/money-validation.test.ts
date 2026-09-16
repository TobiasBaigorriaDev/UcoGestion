import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  validateFixedDiscount,
  validateNonNegativeMoney,
  validatePositiveMoney,
  validatePercentageDiscount,
} from './index.js';

describe('money input validation', () => {
  it('enforces the approved scale and sign rules', () => {
    expect(validateNonNegativeMoney('0.00')).toBe('0.00');
    expect(validateNonNegativeMoney('12.345')).toBeUndefined();
    expect(validateNonNegativeMoney('-0.01')).toBeUndefined();
    expect(validatePositiveMoney('0.00')).toBeUndefined();
    expect(validatePositiveMoney('0.01')).toBe('0.01');
  });

  it('accepts a percentage discount only in the inclusive 0–100 range', () => {
    expect(validatePercentageDiscount('0')).toBe('0');
    expect(validatePercentageDiscount('100')).toBe('100');
    expect(validatePercentageDiscount('100.01')).toBeUndefined();
  });

  it('never accepts a fixed discount above its subtotal', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100_000 }),
        fc.integer({ min: 0, max: 100_000 }),
        (subtotal, discount) => {
          const accepted = validateFixedDiscount(String(discount), String(subtotal));
          expect(accepted === undefined).toBe(discount > subtotal);
        },
      ),
    );
  });
});
