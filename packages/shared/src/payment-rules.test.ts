import { describe, expect, it } from 'vitest';

import {
  arePaymentsValidForSale,
  isPositiveReversalAmount,
  shouldCreatePaymentLine,
} from './index.js';

describe('payment rules', () => {
  it('requires strictly positive payments whose exact sum matches a positive sale total', () => {
    expect(arePaymentsValidForSale('10.00', ['4.00', '6.00'])).toBe(true);
    expect(arePaymentsValidForSale('10.00', ['10.01'])).toBe(false);
    expect(arePaymentsValidForSale('10.00', ['10.00', '0.00'])).toBe(false);
  });

  it('confirms a zero-total sale without any payment line', () => {
    expect(shouldCreatePaymentLine('0.00')).toBe(false);
    expect(arePaymentsValidForSale('0.00', [])).toBe(true);
    expect(arePaymentsValidForSale('0.00', ['0.00'])).toBe(false);
  });

  it('represents reversal direction outside the amount by requiring a positive magnitude', () => {
    expect(isPositiveReversalAmount('0.01')).toBe(true);
    expect(isPositiveReversalAmount('0.00')).toBe(false);
    expect(isPositiveReversalAmount('-0.01')).toBe(false);
  });
});
