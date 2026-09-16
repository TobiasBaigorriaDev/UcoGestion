import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

describe('development service configuration', () => {
  it('declares MinIO, Mailpit and the OTLP Collector in Compose', async () => {
    const { stdout } = await execFileAsync('docker', [
      'compose',
      '-f',
      '../../compose.yaml',
      'config',
    ]);

    expect(stdout).toContain('minio:');
    expect(stdout).toContain('mailpit:');
    expect(stdout).toContain('otel-collector:');
    expect(stdout).toContain('target: 9000');
    expect(stdout).toContain('target: 1025');
    expect(stdout).toContain('target: 4317');
  });

  it('keeps the Collector configuration versioned and ready for OTLP input', async () => {
    const configuration = await readFile(
      '../../observability/otel-collector-config.yaml',
      'utf8',
    );

    expect(configuration).toContain('otlp:');
    expect(configuration).toContain('grpc:');
    expect(configuration).toContain('http:');
    expect(configuration).toContain('service:');
  });
});
