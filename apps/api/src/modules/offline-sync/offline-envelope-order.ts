import type { PoolClient } from 'pg';

export interface EnvelopeOrderInput {
  readonly id: string; readonly organizationId: string; readonly deviceId: string; readonly sessionId: string;
  readonly sequence: string; readonly sessionSequence: string; readonly previousHash: string | null;
  readonly kind: 'cash-session-open' | 'sale-confirm'; readonly operationHash: string; readonly envelopeHash: string;
}
export interface EnvelopeOrderRecord extends EnvelopeOrderInput { readonly status: 'PENDING' | 'ACKED' | 'SECURITY_REJECTED' }
export type EnvelopeOrderDecision = 'READY' | 'WAITING_DEPENDENCY' | 'CONFLICT' | 'ACKED' | 'SECURITY_REJECTED';

/** Pure ordering over server-persisted evidence. A failed dependency never consumes
 * its dependent's sequence or grants permission to delete the sealed envelope. */
export function validateEnvelopeOrder(input: EnvelopeOrderInput, persisted: readonly EnvelopeOrderRecord[]): EnvelopeOrderDecision {
  if (!/^[1-9]\d{0,18}$/.test(input.sequence) || !/^[1-9]\d{0,18}$/.test(input.sessionSequence)) return 'CONFLICT';
  const replay = persisted.find(row => row.id === input.id);
  if (replay) {
    for (const key of ['organizationId', 'deviceId', 'sessionId', 'sequence', 'sessionSequence', 'previousHash', 'kind', 'operationHash', 'envelopeHash'] as const) {
      if (input[key] !== replay[key]) return 'CONFLICT';
    }
    if (replay.status !== 'PENDING') return replay.status;
  }
  const chain = persisted.filter(row => row.organizationId === input.organizationId && row.deviceId === input.deviceId);
  if (chain.some(row => row.sequence === input.sequence && row.id !== input.id)) return 'CONFLICT';
  const sequence = BigInt(input.sequence);
  if (sequence === 1n) {
    if (input.previousHash !== null) return 'CONFLICT';
  } else {
    const previous = chain.filter(row => BigInt(row.sequence) === sequence - 1n);
    if (previous.length > 1) return 'CONFLICT';
    if (!previous[0] || previous[0].status !== 'ACKED') return 'WAITING_DEPENDENCY';
    if (input.previousHash !== previous[0].operationHash) return 'CONFLICT';
  }
  const session = chain.filter(row => row.sessionId === input.sessionId && row.id !== input.id);
  if (input.kind === 'cash-session-open') {
    if (input.sessionSequence !== '1' || session.length > 0) return 'CONFLICT';
  } else {
    if (input.sessionSequence === '1') return 'CONFLICT';
    if (session.some(row => row.sessionSequence === input.sessionSequence)) return 'CONFLICT';
    const opening = session.find(row => row.kind === 'cash-session-open' && row.sessionSequence === '1');
    const previous = session.find(row => BigInt(row.sessionSequence) === BigInt(input.sessionSequence) - 1n);
    if (!opening || opening.status !== 'ACKED' || !previous || previous.status !== 'ACKED') return 'WAITING_DEPENDENCY';
    if (BigInt(previous.sequence) >= sequence) return 'CONFLICT';
  }
  return 'READY';
}

/** Hold the device lock through the caller's receipt/business/audit commit. This
 * reader cannot be used with a pool or outside the contextual transaction. */
export async function readEnvelopeOrder(client: PoolClient, input: EnvelopeOrderInput): Promise<EnvelopeOrderDecision> {
  const device = await client.query('SELECT id FROM devices WHERE organization_id = $1 AND id = $2 FOR UPDATE',
    [input.organizationId, input.deviceId]);
  if (!device.rowCount) return 'CONFLICT';
  const rows = await client.query<EnvelopeOrderRecord>(`SELECT id, organization_id AS "organizationId", device_id AS "deviceId",
    session_id AS "sessionId", sequence::text, session_sequence::text AS "sessionSequence", kind,
    CASE WHEN sequence = 1 AND prev_hash = repeat('0', 64) THEN NULL ELSE encode(decode(prev_hash, 'hex'), 'base64') END AS "previousHash",
    encode(decode(operation_hash, 'hex'), 'base64') AS "operationHash", envelope_hash AS "envelopeHash", status
    FROM sync_operations WHERE organization_id = $1 AND (device_id = $2 OR id = $3)`,
  [input.organizationId, input.deviceId, input.id]);
  // Legacy records without bound session/envelope metadata cannot prove new dependencies.
  if (rows.rows.some(row => !row.sessionId || !row.sessionSequence || !row.kind || !row.envelopeHash)) return 'WAITING_DEPENDENCY';
  return validateEnvelopeOrder(input, rows.rows);
}
