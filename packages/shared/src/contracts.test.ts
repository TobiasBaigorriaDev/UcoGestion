import { describe, expect, it } from 'vitest';

import {
  parseCanonicalDecimal,
  parseUtcTimestamp,
  parseUuid,
} from './index.js';

describe('shared transport contracts', () => {
  it('accepts canonical UUID v4 values and rejects malformed IDs', () => {
    expect(parseUuid('d9428888-122b-4b88-9a10-5d7be4d3a123')).toBe(
      'd9428888-122b-4b88-9a10-5d7be4d3a123',
    );
    expect(() => parseUuid('d9428888-122b-1b88-9a10-5d7be4d3a123')).toThrow();
  });

  it('accepts only canonical UTC timestamps', () => {
    expect(parseUtcTimestamp('2026-09-16T02:00:00.000Z')).toBe(
      '2026-09-16T02:00:00.000Z',
    );
    expect(() => parseUtcTimestamp('2026-09-16T02:00:00-03:00')).toThrow();
  });

  it('accepts decimal strings without numeric coercion or exponent notation', () => {
    expect(parseCanonicalDecimal('123.450')).toBe('123.450');
    expect(parseCanonicalDecimal('-1.5')).toBe('-1.5');
    expect(() => parseCanonicalDecimal('01.5')).toThrow();
    expect(() => parseCanonicalDecimal('1e3')).toThrow();
    expect(() => parseCanonicalDecimal('-0.00')).toThrow();
  });
});
