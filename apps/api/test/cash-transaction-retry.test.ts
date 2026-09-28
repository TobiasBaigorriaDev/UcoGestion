import { describe, expect, it } from 'vitest';

import { retryCashTransaction } from '../src/modules/cash/cash-transaction-retry.js';

describe('cash transaction retry', () => {
  it('restarts a failed transaction at most three times and propagates business failures', async () => {
    let attempts = 0;
    const result = await retryCashTransaction(async () => {
      attempts += 1;
      if (attempts < 3) throw Object.assign(new Error('deadlock'), { code: '40P01' });
      return 'committed';
    });
    expect(result).toBe('committed');
    expect(attempts).toBe(3);
    await expect(retryCashTransaction(async () => {
      throw Object.assign(new Error('serialization failure'), { code: '40001' });
    })).rejects.toMatchObject({ name: 'Error', message: 'Concurrent cash modification.' });
    attempts = 0;
    await expect(retryCashTransaction(async () => {
      attempts += 1;
      throw new RangeError('Invalid amount');
    })).rejects.toThrow('Invalid amount');
    expect(attempts).toBe(1);
  });
});
