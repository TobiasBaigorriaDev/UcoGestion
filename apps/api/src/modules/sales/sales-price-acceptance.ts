import { createHash } from 'node:crypto';

import type { SalesQuote } from './sales-quote.service.js';

export interface AcceptedSalePrice {
  readonly fingerprint: string;
  readonly idempotencyKey: string;
  readonly previousKey?: string;
  readonly acceptedPriceChange?: true;
}

export interface PriceChangedProblemDetails {
  readonly type: 'about:blank';
  readonly title: 'Precio actualizado';
  readonly status: 409;
  readonly code: 'PRICE_CHANGED';
  readonly detail: string;
  readonly instance: string;
  readonly traceId: string;
  readonly currentTotal: string;
  readonly quote: SalesQuote;
  readonly quoteFingerprint: string;
}

export class PriceChangedError extends Error {
  readonly code = 'PRICE_CHANGED' as const;
  readonly quoteFingerprint: string;

  constructor(readonly quote: SalesQuote, readonly previousKey: string) {
    super('El precio cambió. Acepte la cotización actual y reintente con una clave nueva.');
    this.name = 'PriceChangedError';
    this.quoteFingerprint = fingerprintSaleQuote(quote);
  }
}

export const fingerprintSaleQuote = (quote: SalesQuote): string => createHash('sha256')
  .update(JSON.stringify({ currency: quote.currency, lines: quote.lines.map((line) => ({
    itemId: line.itemId, quantity: line.quantity, unitPrice: line.unitPrice,
    priceVersion: line.priceVersion, lineTotal: line.lineTotal,
  })), subtotal: quote.subtotal, discount: quote.discount, total: quote.total }))
  .digest('hex');

export const assertAcceptedSalePrice = (quote: SalesQuote, acceptance: AcceptedSalePrice): void => {
  if (acceptance.fingerprint !== fingerprintSaleQuote(quote) ||
    (acceptance.previousKey !== undefined &&
      (acceptance.idempotencyKey === acceptance.previousKey || acceptance.acceptedPriceChange !== true))) {
    throw new PriceChangedError(quote, acceptance.idempotencyKey);
  }
};

export const createPriceChangedProblem = (error: PriceChangedError, instance: string,
  traceId: string): PriceChangedProblemDetails => ({
  type: 'about:blank', title: 'Precio actualizado', status: 409, code: 'PRICE_CHANGED',
  detail: error.message, instance, traceId, currentTotal: error.quote.total,
  quote: error.quote, quoteFingerprint: error.quoteFingerprint,
});
