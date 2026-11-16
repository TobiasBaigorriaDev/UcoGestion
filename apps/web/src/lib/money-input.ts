/**
 * Reads a typed amount as people write it in Argentina ("5000", "5.000", "5.000,50", "25.50")
 * and returns the canonical API decimal ("5000.50"), or null when it is not an unambiguous amount.
 * Works on the string only; no floating point.
 */
export function parseMoneyInput(text: string): string | null {
  const value = text.trim();
  let whole: string | undefined;
  let fraction = '';
  let match: RegExpExecArray | null;
  if ((match = /^(\d{1,3}(?:\.\d{3})+|\d+),(\d{1,2})$/.exec(value))) [, whole = '', fraction = ''] = match;
  else if ((match = /^(\d{1,3}(?:\.\d{3})+)$/.exec(value))) [, whole = ''] = match;
  else if ((match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value))) [, whole = '', fraction = ''] = match;
  if (whole === undefined) return null;
  return `${BigInt(whole.replaceAll('.', '')).toString()}.${fraction.padEnd(2, '0')}`;
}

/** Hint shown under money inputs. */
export const moneyInputHint = 'Podés escribir 2500, 2.500 o 2.500,50.';
