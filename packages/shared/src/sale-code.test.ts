import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { saleCodeFromId, saleCodeLookup } from './index.js';

const alphabet = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{12}$/;
const inRange = (id: string, lookup: NonNullable<ReturnType<typeof saleCodeLookup>>) =>
  id >= lookup.lowerId && id <= lookup.upperId && id.slice(-3) === lookup.suffix;

describe('D05 visible sale code', () => {
  it('derives a deterministic 12-character code without ambiguous letters', () => {
    fc.assert(fc.property(fc.uuid(), (id) => {
      const code = saleCodeFromId(id);
      expect(code).toMatch(alphabet);
      expect(saleCodeFromId(id.toUpperCase())).toBe(code);
      expect(code).not.toMatch(/[ILOU]/);
    }));
  });

  it('resolves every code back to a range that contains the original UUID', () => {
    fc.assert(fc.property(fc.uuid(), (id) => {
      const lookup = saleCodeLookup(saleCodeFromId(id));
      if (!lookup) throw new Error('Expected a resolvable code');
      expect(inRange(id.toLowerCase(), lookup)).toBe(true);
    }));
  });

  it('tolerates case, spaces, dashes and O/0 and I/L/1 substitutions', () => {
    const id = '0123abcd-ef01-4abc-8def-0123456789ab';
    const code = saleCodeFromId(id);
    const variant = ` ${code.slice(0, 4)}-${code.slice(4, 8)} ${code.slice(8)} `.toLowerCase()
      .replaceAll('0', 'o').replaceAll('1', 'l');
    expect(saleCodeLookup(variant)?.code).toBe(code);
    expect(saleCodeLookup(code.replaceAll('1', 'I'))?.code).toBe(code);
  });

  it('rejects inputs that are not a complete visible code', () => {
    for (const value of ['', 'ABC', '0123456789ABC', '0123456789AU', '0123456789A*', 'not-a-sale-id']) {
      expect(saleCodeLookup(value)).toBeNull();
    }
    expect(() => saleCodeFromId('not-a-uuid')).toThrow(TypeError);
  });

  it('gives the same code to UUIDs that differ only outside the encoded bits', () => {
    const first = '0123abcd-ef01-4abc-8def-0123456789ab';
    const second = '0123abcd-ef01-4fff-9000-0000000009ab';
    expect(saleCodeFromId(first)).toBe(saleCodeFromId(second));
    expect(saleCodeFromId(first)).not.toBe(saleCodeFromId('0123abcd-ef02-4abc-8def-0123456789ab'));
  });
});
