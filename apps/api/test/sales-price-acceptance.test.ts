import { describe, expect, it } from 'vitest';

import { assertAcceptedSalePrice, createPriceChangedProblem, fingerprintSaleQuote,
  PriceChangedError } from '../src/modules/sales/sales-price-acceptance.js';

describe('T134 PRICE_CHANGED', () => {
  const quote = { currency: 'ARS', subtotal: '10.00', discount: '0.00', total: '10.00',
    lines: [{ itemId: 'item-1', quantity: '1', unitPrice: '10.00', priceVersion: 2, lineTotal: '10.00' }] };
  it('rejects a stale accepted quote with a safe current quote and requires a fresh key', () => {
    const stale = { ...quote, lines: [{ itemId: 'item-1', quantity: '1', unitPrice: '9.00',
      priceVersion: 1, lineTotal: '9.00' }],
      subtotal: '9.00', total: '9.00' };
    let conflict: PriceChangedError | undefined;
    try { assertAcceptedSalePrice(quote, { fingerprint: fingerprintSaleQuote(stale), idempotencyKey: 'first' }); }
    catch (error) { if (error instanceof PriceChangedError) conflict = error; else throw error; }
    expect(conflict).toMatchObject({ code: 'PRICE_CHANGED', quote, previousKey: 'first' });
    expect(conflict?.quoteFingerprint).toBe(fingerprintSaleQuote(quote));
    if (!conflict) throw new Error('Expected price conflict');
    expect(createPriceChangedProblem(conflict, '/api/v1/sales', 'trace-1')).toMatchObject({
      code: 'PRICE_CHANGED', status: 409, traceId: 'trace-1', currentTotal: '10.00',
      quote, quoteFingerprint: fingerprintSaleQuote(quote),
    });
    expect(() => assertAcceptedSalePrice(quote, { fingerprint: conflict.quoteFingerprint,
      idempotencyKey: 'first', previousKey: 'first', acceptedPriceChange: true })).toThrowError(PriceChangedError);
    expect(() => assertAcceptedSalePrice(quote, { fingerprint: conflict.quoteFingerprint,
      idempotencyKey: 'second', previousKey: 'first' })).toThrowError(PriceChangedError);
    expect(assertAcceptedSalePrice(quote, { fingerprint: conflict.quoteFingerprint,
      idempotencyKey: 'second', previousKey: 'first', acceptedPriceChange: true })).toBeUndefined();
    expect(() => assertAcceptedSalePrice(quote, { fingerprint: '', idempotencyKey: 'second', previousKey: 'first' }))
      .toThrowError(PriceChangedError);
  });
});
