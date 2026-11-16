import { expect, it } from 'vitest';
import fc from 'fast-check';
import { formatMoneyForDisplay } from './index.js';

it.each([
  ['1800.00', 'ARS', '$ 1.800,00'],
  ['0.00', 'ARS', '$ 0,00'],
  ['25.5', 'ARS', '$ 25,50'],
  ['-1234.56', 'ARS', '-$ 1.234,56'],
  ['12345678901234567.99', 'ARS', '$ 12.345.678.901.234.567,99'],
  ['10.00', 'USD', 'US$ 10,00'],
  ['10.00', 'EUR', 'EUR 10,00'],
])('formats %s %s as %s for Argentine display', (value, currency, expected) => {
  expect(formatMoneyForDisplay(value, currency)).toBe(expected);
});

it('defaults to pesos and rejects non-canonical amounts instead of guessing', () => {
  expect(formatMoneyForDisplay('7.00')).toBe('$ 7,00');
  for (const invalid of ['', '1,50', 'NaN', '1e3', '1.234.5']) {
    expect(() => formatMoneyForDisplay(invalid)).toThrow();
  }
});

it('keeps every cent: removing the presentation recovers the canonical amount', () => {
  fc.assert(fc.property(fc.bigInt({ min: -(10n ** 18n), max: 10n ** 18n }), (cents) => {
    const sign = cents < 0n ? '-' : '';
    const absolute = cents < 0n ? -cents : cents;
    const canonical = `${sign}${absolute / 100n}.${(absolute % 100n).toString().padStart(2, '0')}`;
    const shown = formatMoneyForDisplay(canonical);
    expect(shown.replace('$ ', '').replaceAll('.', '').replace(',', '.')).toBe(canonical);
  }));
});
