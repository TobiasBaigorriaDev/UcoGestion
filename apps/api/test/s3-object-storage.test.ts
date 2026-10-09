import { describe, expect, it } from 'vitest';

import { S3ObjectStorage } from '../src/core/objects/s3-object-storage.js';

describe('S3-compatible object storage', () => {
  it('signs a private attachment URL with a short expiry', async () => {
    const storage = new S3ObjectStorage({ bucket: 'exports', endpoint: 'http://localhost:9000',
      region: 'us-east-1', accessKeyId: 'test', secretAccessKey: 'test-secret' });
    const url = new URL(await storage.signedGetUrl('exports/tenant/file', 'sales.pdf',
      'application/pdf', 300));
    expect(url.pathname).toBe('/exports/exports/tenant/file');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(url.searchParams.get('response-content-type')).toBe('application/pdf');
    expect(url.searchParams.get('response-content-disposition'))
      .toBe('attachment; filename="sales.pdf"');
    await expect(storage.signedGetUrl('key', 'sales.pdf', 'application/pdf', 301))
      .rejects.toThrow();
  });
});
