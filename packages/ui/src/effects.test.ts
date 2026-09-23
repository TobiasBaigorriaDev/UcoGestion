import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(process.cwd(), 'src/effects.css'), 'utf8');

describe('glass effects fallback', () => {
  it('starts with an opaque surface and enables blur only when supported', () => {
    expect(css).toMatch(/\.uco-glass\s*\{[^}]*background:\s*var\(--color-surface\)/s);
    expect(css).toMatch(/@supports\s*\(backdrop-filter:\s*blur\(14px\)\)/);
    expect(css).toMatch(/backdrop-filter:\s*blur\(14px\)/);
  });

  it('removes blur for reduced transparency, reduced motion and the performance switch', () => {
    expect(css).toMatch(/prefers-reduced-transparency:\s*reduce/);
    expect(css).toMatch(/prefers-reduced-motion:\s*reduce/);
    expect(css).toMatch(/data-effects=['"]reduced['"]/);
    expect(css).toMatch(/backdrop-filter:\s*none/);
  });
});
