/** Twelve characters derived from the sale UUID, including 60 random bits for v4 IDs. */
const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function saleCodeFromId(id: string): string {
  if (!uuidPattern.test(id)) throw new TypeError('Invalid sale ID');
  const hex = id.replaceAll('-', '').toLowerCase();
  // The first 12 and last 3 hex digits avoid UUID version/variant fixed bits.
  let value = BigInt(`0x${hex.slice(0, 12)}${hex.slice(-3)}`);
  let code = '';
  for (let index = 0; index < 12; index += 1) {
    code = alphabet[Number(value & 31n)] + code;
    value >>= 5n;
  }
  return code;
}

export function saleCodeLookup(value: string): {
  code: string; lowerId: string; upperId: string; suffix: string;
} | null {
  const code = value.trim().replace(/[\s-]/g, '').toUpperCase()
    .replaceAll('O', '0').replace(/[IL]/g, '1');
  if (code.length !== 12 || [...code].some(character => !alphabet.includes(character))) return null;
  let bits = 0n;
  for (const character of code) bits = (bits << 5n) | BigInt(alphabet.indexOf(character));
  const hex = bits.toString(16).padStart(15, '0');
  const prefix = hex.slice(0, 12);
  const uuid = (compact: string) => `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
  return { code, lowerId: uuid(prefix + '0'.repeat(20)),
    upperId: uuid(prefix + 'f'.repeat(20)), suffix: hex.slice(12) };
}
