import { type DeviceChain, OfflineDatabase } from './offline-database';

export class OfflineLease {
  constructor(private readonly db: OfflineDatabase, private readonly now: () => number = Date.now) {}

  async acquire(owner: string, duration = 30_000): Promise<DeviceChain> {
    if (!owner || !Number.isSafeInteger(duration) || duration <= 0 || duration > 60_000) throw new Error('Invalid local lease.');
    return this.db.transaction('rw', this.db.meta, async () => {
      const current = await this.db.meta.get('device-chain');
      if (current && current.expiresAt > this.now()) throw new Error('Device sequence lease busy.');
      const lease: DeviceChain = { key: 'device-chain', owner, fence: (BigInt(current?.fence ?? '0') + 1n).toString(),
        ...(current?.deviceRevoked ? {deviceRevoked:true}: {}),
        ...(current?.cashSessionOpen ? { cashSessionOpen: true } : {}),
        ...(current?.cashSessionId ? {cashSessionId:current.cashSessionId}:{}),
        expiresAt: this.now() + duration, sequence: current?.sequence ?? '0', headHash: current?.headHash ?? null };
      await this.db.meta.put(lease);
      return lease;
    });
  }

  /** Call inside the same rw transaction that commits the operation and head. */
  async assert(lease: DeviceChain): Promise<void> {
    const current = await this.db.meta.get('device-chain');
    if (!current || current.owner !== lease.owner || current.fence !== lease.fence || current.expiresAt <= this.now() ||
      current.sequence !== lease.sequence || current.headHash !== lease.headHash ||
      current.cashSessionOpen !== lease.cashSessionOpen || current.cashSessionId!==lease.cashSessionId) throw new Error('Device sequence lease lost.');
  }

  async release(lease: DeviceChain): Promise<void> {
    await this.db.transaction('rw', this.db.meta, async () => {
      const current = await this.db.meta.get('device-chain');
      if (current?.owner === lease.owner && current.fence === lease.fence) await this.db.meta.put({ ...current, expiresAt: 0 });
    });
  }
}
