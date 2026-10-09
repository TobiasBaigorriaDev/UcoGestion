import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('T235 pins runtime and pnpm, freezes dependencies and separates migration from service startup', () => {
  const dockerfile=readFileSync('../../infra/deploy/Dockerfile','utf8');
  expect(dockerfile).toMatch(/FROM node:24\.15\.0-bookworm-slim@sha256:[a-f0-9]{64}/);
  expect(dockerfile).toContain('pnpm@11.19.0');
  expect(dockerfile).toContain('pnpm install --frozen-lockfile');
  for(const image of ['web','api','worker'])expect(dockerfile).toContain(`AS ${image}`);
  const rollout=readFileSync('../../infra/deploy/rollout.ps1','utf8');
  expect(rollout.indexOf('run --rm migrate')).toBeLessThan(rollout.indexOf('up -d --wait'));
  expect(rollout).toContain('smoke.ps1');
  expect(dockerfile).not.toContain('schema push');
});
