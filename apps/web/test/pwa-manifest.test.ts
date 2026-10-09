import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import manifest from '../app/manifest';

describe('T224 installable manifest', () => {
  it('uses standalone with public PNG icons of their declared dimensions', () => {
    const value = manifest();
    expect(value.display).toBe('standalone');
    expect(value.start_url).toBe('/workspace');
    expect(value.icons?.some(icon => icon.purpose === 'any')).toBe(true);
    for (const size of [192, 512]) {
      const icon = value.icons?.find(candidate => candidate.sizes === `${size}x${size}`);
      expect(icon?.type).toBe('image/png');
      const png = readFileSync(`public${icon?.src}`);
      expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      expect(png.readUInt32BE(16)).toBe(size);
      expect(png.readUInt32BE(20)).toBe(size);
    }
  });
});
