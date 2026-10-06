import { parseUtcTimestamp } from '@uconext/shared';
import type { PoolClient } from 'pg';
import { z } from 'zod';

const receiptInputSchema = z.strictObject({ id: z.uuid(), organizationId: z.uuid(), deviceId: z.uuid(), grantId: z.uuid(),
  epoch: z.string().regex(/^[1-9]\d*$/), sequence: z.string().regex(/^[1-9]\d*$/),
  previousHash: z.string().regex(/^[0-9a-f]{64}$/), operationHash: z.string().regex(/^[0-9a-f]{64}$/), occurredAt: z.string(),
  envelope: z.strictObject({ sessionId: z.uuid(), sessionSequence: z.string().regex(/^[1-9]\d{0,18}$/),
    kind: z.enum(['cash-session-open', 'sale-confirm']), hash: z.string().regex(/^[0-9a-f]{64}$/) }).optional() });
interface ReceiptRow {
  id: string; organization_id: string; device_id: string; grant_id: string; epoch: string; sequence: string;
  prev_hash: string; operation_hash: string; occurred_at: Date | null; received_at: Date;
  session_id: string | null; session_sequence: string | null; kind: string | null; envelope_hash: string | null;
}

/** Internal persistence primitive for a historically validated operation.
 * The ingesting use case owns grant/signature/chain validation and business
 * effects in the surrounding contextual transaction. Time alone never authorizes.
 */
export async function recordOfflineReceipt(client: PoolClient, input: unknown) {
  const operation = receiptInputSchema.parse(input);
  const occurredAt = parseUtcTimestamp(operation.occurredAt);
  if (operation.envelope?.kind === 'cash-session-open') {
    await client.query(`INSERT INTO offline_sync_sessions (organization_id,id,device_id) VALUES ($1,$2,$3)
      ON CONFLICT (organization_id,id) DO NOTHING`, [operation.organizationId,operation.envelope.sessionId,operation.deviceId]);
  }
  const select = () => client.query<ReceiptRow>(`SELECT id, organization_id, device_id, grant_id,
    epoch::text, sequence::text, prev_hash, operation_hash, occurred_at, received_at,
    session_id, session_sequence::text, kind, envelope_hash
    FROM sync_operations WHERE id = $1`, [operation.id]);
  let row = (await select()).rows[0];
  if (!row) {
    await client.query(`INSERT INTO sync_operations
      (id, organization_id, device_id, grant_id, epoch, sequence, prev_hash, operation_hash, status, occurred_at,
       session_id, session_sequence, kind, envelope_hash)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'PENDING',$9,$10,$11,$12,$13) ON CONFLICT (id) DO NOTHING`,
    [operation.id, operation.organizationId, operation.deviceId, operation.grantId, operation.epoch,
      operation.sequence, operation.previousHash, operation.operationHash, occurredAt,
      operation.envelope?.sessionId ?? null, operation.envelope?.sessionSequence ?? null,
      operation.envelope?.kind ?? null, operation.envelope?.hash ?? null]);
    row = (await select()).rows[0];
  }
  if (!row || row.organization_id !== operation.organizationId || row.device_id !== operation.deviceId ||
    row.grant_id !== operation.grantId || row.epoch !== operation.epoch || row.sequence !== operation.sequence ||
    row.prev_hash !== operation.previousHash || row.operation_hash !== operation.operationHash ||
    row.occurred_at?.toISOString() !== occurredAt || row.session_id !== (operation.envelope?.sessionId ?? null) ||
    row.session_sequence !== (operation.envelope?.sessionSequence ?? null) || row.kind !== (operation.envelope?.kind ?? null) ||
    row.envelope_hash !== (operation.envelope?.hash ?? null)) throw new Error('SYNC_RECEIPT_CONFLICT');
  return { id: row.id, occurredAt, receivedAt: row.received_at.toISOString() };
}
