import { describe, expect, it } from 'vitest';

import { sharedPackageMarker } from './index.js';

describe('@uconext/shared tooling smoke test', () => {
  it('loads TypeScript source through the shared Vitest configuration', () => {
    expect(sharedPackageMarker).toBe('uconext-shared');
  });
});
