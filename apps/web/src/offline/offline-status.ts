import { z } from 'zod';
import type { OfflineAuthorization } from './offline-authorization';
import type { OfflineDatabase } from './offline-database';
import type { OfflineKeys } from './offline-keys';
import { OfflineRecordCipher } from './offline-record-cipher';

const operationSchema = z.object({ operation: z.object({ id: z.uuid(), actorId: z.string(), organizationId: z.uuid(),
  deviceId: z.uuid(), kind: z.string(), sequence: z.string(), occurredAt: z.iso.datetime() }) });
export interface OfflineStatus {
  readonly timezone: string;
  readonly expiresAt: string;
  readonly lastSyncAt: string;
  readonly expired: boolean;
  readonly pending: readonly { id: string; kind: string; sequence: string; occurredAt: string }[];
}

export async function readOfflineStatus(db: OfflineDatabase, keys: OfflineKeys, authorization: OfflineAuthorization,
  userId: string, now: () => number = Date.now): Promise<OfflineStatus> {
  const context = await authorization.read(userId), dek = keys.dekFor(userId);
  const records = await db.records.filter(row => row.userId === userId && row.kind === 'operation').toArray();
  const cipher = new OfflineRecordCipher();
  const pending = await Promise.all(records.map(async record => {
    const { operation } = operationSchema.parse(JSON.parse(new TextDecoder().decode(await cipher.decrypt(dek,
      { organizationId: db.organizationId, deviceId: db.deviceId, userId, kind: record.kind, id: record.id }, record.ciphertext))));
    if (operation.id !== record.id || operation.actorId !== userId || operation.organizationId !== db.organizationId ||
      operation.deviceId !== db.deviceId) throw new Error('OFFLINE_IDENTITY_MISMATCH');
    return { id: operation.id, kind: operation.kind, sequence: operation.sequence, occurredAt: operation.occurredAt };
  }));
  if (keys.dekFor(userId) !== dek) throw new Error('Identidad offline bloqueada.');
  await authorization.read(userId);
  return { timezone: context.bootstrap.timezone, expiresAt: new Date(context.claims.exp * 1000).toISOString(), lastSyncAt: context.bootstrap.serverTime,
    expired: Boolean(context.knownExpired) || now() >= context.claims.exp * 1000,
    pending: pending.sort((a, b) => BigInt(a.sequence) < BigInt(b.sequence) ? -1 : 1) };
}
