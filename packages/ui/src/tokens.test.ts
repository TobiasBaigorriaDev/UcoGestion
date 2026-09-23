import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(process.cwd(), 'src/tokens.css'), 'utf8');
const primitivesCss = readFileSync(resolve(process.cwd(), 'src/primitives.css'), 'utf8');

function token(name: string): string {
  const match = css.match(new RegExp(`--${name}:\\s*([^;]+);`));
  if (!match) throw new Error(`Missing design token: ${name}`);
  return match[1]?.trim().toLowerCase() ?? '';
}

function luminance(hex: string): number {
  const channels = hex.match(/[\da-f]{2}/gi);
  if (!channels || channels.length !== 3) throw new Error(`Invalid color: ${hex}`);
  const values = channels.map((channel) => {
    const value = Number.parseInt(channel, 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return (values[0] ?? 0) * 0.2126 + (values[1] ?? 0) * 0.7152 + (values[2] ?? 0) * 0.0722;
}

function contrast(foreground: string, background: string): number {
  const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return ((values[0] ?? 0) + 0.05) / ((values[1] ?? 0) + 0.05);
}

describe('UcoNext design tokens', () => {
  it('materializes the brand palette and typography from DESIGN.md', () => {
    expect(token('color-primary')).toBe('#166534');
    expect(token('color-vibrant')).toBe('#22c55e');
    expect(token('color-accent')).toBe('#15803d');
    expect(token('color-background')).toBe('#f8fafc');
    expect(token('color-text')).toBe('#0f172a');
    expect(token('font-sans')).toContain('plus jakarta sans');
    expect(token('font-sans')).toContain('var(--font-plus-jakarta)');
    expect(token('radius-button')).toBe('12px');
  });

  it('keeps text on solid action colors at 4.5:1 or higher', () => {
    expect(contrast(token('color-on-primary'), token('color-primary'))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(token('color-on-vibrant'), token('color-vibrant'))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(token('color-text-muted'), token('color-background'))).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps secondary text readable over the strongest glass on a dark backdrop', () => {
    const alpha = Number(css.match(/--color-glass-strong:\s*rgb\(255 255 255 \/ (\d+)%\)/)?.[1]);
    expect(alpha).toBeGreaterThan(0);
    const channel = Math.round(255 * alpha / 100).toString(16).padStart(2, '0');
    expect(contrast(token('color-text-secondary'), `#${channel}${channel}${channel}`)).toBeGreaterThanOrEqual(4.5);
    expect(primitivesCss).toContain('uco-dialog');
    expect(readFileSync(resolve(process.cwd(), 'src/effects.css'), 'utf8')).toContain('var(--color-glass-strong)');
  });

  it('provides Tailwind theme mapping for the shared tokens', () => {
    expect(css).toMatch(/@theme inline\s*\{/);
    expect(css).toMatch(/--color-forest:\s*var\(--color-primary\)/);
  });
});
