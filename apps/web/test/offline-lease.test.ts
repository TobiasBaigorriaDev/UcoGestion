import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { afterEach, describe, expect, it } from 'vitest';
import { OfflineDatabase } from '../src/offline/offline-database.js';
import { OfflineLease } from '../src/offline/offline-lease.js';

const org = '11111111-1111-4111-8111-111111111111';
const device = '22222222-2222-4222-8222-222222222222';
describe('T190B device sequence lease', () => {
  afterEach(async () => { await Dexie.delete(OfflineDatabase.nameFor(org, device)); });
  it('serializes independent connections and recovers after crash with a monotonic fence', async () => {
    const a = new OfflineDatabase(org, device);
    const b = new OfflineDatabase(org, device);
    let now = 100;
    const first = new OfflineLease(a, () => now);
    const second = new OfflineLease(b, () => now);
    const results = await Promise.allSettled([first.acquire('tab-a', 1000), second.acquire('tab-b', 1000)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const winner = results.find(result => result.status === 'fulfilled');
    if (!winner || winner.status !== 'fulfilled') throw new Error('Missing lease.');
    expect(winner.value.sequence).toBe('0');
    now += 1001;
    a.close();
    const recovered = await second.acquire('after-crash', 1000);
    expect(BigInt(recovered.fence)).toBeGreaterThan(BigInt(winner.value.fence));
    expect(recovered.sequence).toBe('0');
    await expect(second.assert(winner.value)).rejects.toThrow(/lease/i);
    await second.release(winner.value);
    await second.assert(recovered);
    await second.release(recovered);
    expect((await second.acquire('next', 1000)).sequence).toBe('0');
    b.close();
  });
});
