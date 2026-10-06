export function bytes(value: Uint8Array): ArrayBuffer {
  return new Uint8Array(value).buffer;
}

export function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && value && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(Reflect.get(value, key))}`).join(',')}}`;
  }
  throw new Error('Invalid canonical JSON.');
}

export const encode = (value: unknown): Uint8Array => new TextEncoder().encode(canonical(value));
export const base64 = (value: Uint8Array): string => btoa(Array.from(value, byte => String.fromCharCode(byte)).join(''));
export const unbase64 = (value: string): Uint8Array => Uint8Array.from(atob(value), char => char.charCodeAt(0));
export async function hash(value: Uint8Array): Promise<string> {
  return base64(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes(value))));
}
