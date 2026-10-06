import { expect, it } from 'vitest';
import fc from 'fast-check';
import { consumeKnownStock } from './index.js';

it('consumes known stock without precision loss or a negative projection', () => {
  expect(consumeKnownStock('3.000', ['1.25', '0.005'])).toBe('1.745');
  expect(() => consumeKnownStock('1.000', ['1', '1'])).toThrow();
  expect(() => consumeKnownStock('-1.000', ['1'])).toThrow();
  fc.assert(fc.property(fc.integer({ min: 1, max: 1000000 }), count => {
    const available = `${count}.000`;
    expect(consumeKnownStock(available, [String(count)])).toBe('0.000');
    expect(() => consumeKnownStock(available, [String(count), '0.001'])).toThrow();
  }));
});
