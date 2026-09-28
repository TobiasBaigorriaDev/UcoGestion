import { describe, expect, it } from 'vitest';

import { csvCell } from '../src/modules/reports/report-csv.js';

describe('CSV cell encoding', () => {
  it.each(['=SUM(1)', '+cmd', '-1+2', '@x', '\t=1', '\r=1', '  =1'])(
    'neutralizes executable content while preserving %s', (value) => {
      expect(csvCell(value)).toBe(`"'${value}"`);
    });
  it('quotes separators and preserves ordinary values', () => {
    expect(csvCell('A,"B"')).toBe('"A,""B"""');
    expect(csvCell('texto')).toBe('"texto"');
  });
});
