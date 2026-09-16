import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

describe('development Compose configuration', () => {
  it('declares a health-checked PostgreSQL service', async () => {
    const { stdout } = await execFileAsync('docker', [
      'compose',
      '-f',
      '../../compose.yaml',
      'config',
    ]);

    expect(stdout).toContain('postgres:');
    expect(stdout).toContain('image: postgres:16-alpine');
    expect(stdout).toContain('healthcheck:');
    expect(stdout).toContain('pg_isready');
  });
});
