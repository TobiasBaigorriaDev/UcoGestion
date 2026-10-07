import { randomUUID, verify } from 'node:crypto';
import { revocationCheckpointSchema,revocationCheckpointPayload } from '@uconext/shared';
import type { PoolClient } from 'pg';
import { AuditEventWriter } from '../../core/audit/audit-event-writer.js';
import type { DeviceCertificateClaims } from './device-certificate.js';
export { revocationCheckpointPayload } from '@uconext/shared';
export async function recordRevocationCheckpoint(client:PoolClient,certificate:DeviceCertificateClaims,input:unknown):Promise<void> {
  const checkpoint=revocationCheckpointSchema.parse(input);
  if (checkpoint.organizationId!==certificate.organizationId || checkpoint.deviceId!==certificate.deviceId) throw new Error('OFFLINE_CHECKPOINT_INVALID');
  await client.query('SELECT id FROM organizations WHERE id=$1 FOR UPDATE',[certificate.organizationId]);
  const device=(await client.query<{public_key:string;public_key_thumbprint:string;status:string;authorized_by_user_id:string;branch_id:string}>(
    'SELECT public_key,public_key_thumbprint,status,authorized_by_user_id,branch_id FROM devices WHERE organization_id=$1 AND id=$2 FOR UPDATE',
    [certificate.organizationId,certificate.deviceId])).rows[0];
  const sig=Buffer.from(checkpoint.signature,'base64');
  if (!device || device.public_key_thumbprint!==certificate.thumbprint || sig.length!==64 || sig.toString('base64')!==checkpoint.signature ||
    !verify('sha256',Buffer.from(revocationCheckpointPayload(checkpoint)),{key:device.public_key,dsaEncoding:'ieee-p1363'},sig)) throw new Error('OFFLINE_CHECKPOINT_INVALID');
  if (checkpoint.actorUserId===null) {
    if (device.status!=='REVOKED') throw new Error('OFFLINE_CHECKPOINT_INVALID');
  } else {
    const membership=await client.query("SELECT 1 FROM memberships WHERE organization_id=$1 AND user_id=$2 AND (status<>'ACTIVE' OR revoked_at IS NOT NULL)",[checkpoint.organizationId,checkpoint.actorUserId]);
    if (!membership.rowCount) throw new Error('OFFLINE_CHECKPOINT_INVALID');
  }
  const target=checkpoint.actorUserId ?? 'DEVICE';
  const previous=(await client.query<{sequence:string;head_hash:string}>(
    'SELECT sequence::text,head_hash FROM offline_revocation_checkpoints WHERE organization_id=$1 AND device_id=$2 AND target=$3',
    [checkpoint.organizationId,checkpoint.deviceId,target])).rows[0];
  // The first acknowledged knowledge point is irreversible. A later larger cutoff
  // would incorrectly legitimize operations created after learning revocation.
  if (previous) {
    if (previous.sequence!==checkpoint.sequence || previous.head_hash!==checkpoint.headHash) throw new Error('OFFLINE_CHECKPOINT_ROLLBACK');
    return;
  }
  const persisted=(await client.query<{sequence:string;operation_hash:string}>(
    'SELECT sequence::text,operation_hash FROM sync_operations WHERE organization_id=$1 AND device_id=$2 ORDER BY sequence DESC LIMIT 1',
    [checkpoint.organizationId,checkpoint.deviceId])).rows[0];
  if (persisted && (BigInt(persisted.sequence)>BigInt(checkpoint.sequence) ||
    (persisted.sequence===checkpoint.sequence && persisted.operation_hash!==checkpoint.headHash)) ||
    checkpoint.sequence==='0' && checkpoint.headHash!=='0'.repeat(64)) throw new Error('OFFLINE_CHECKPOINT_ROLLBACK');
  await client.query(`INSERT INTO offline_revocation_checkpoints (organization_id,device_id,target,actor_user_id,sequence,head_hash,signature)
    VALUES ($1,$2,$3,$4,$5,$6,$7)`,[checkpoint.organizationId,checkpoint.deviceId,target,checkpoint.actorUserId,checkpoint.sequence,checkpoint.headHash,checkpoint.signature]);
  await new AuditEventWriter(client).append({action:'offline.revocation_known',organizationId:checkpoint.organizationId,
    actorUserId:checkpoint.actorUserId ?? device.authorized_by_user_id,branchId:device.branch_id,deviceId:checkpoint.deviceId,
    entityType:'device',entityId:checkpoint.deviceId,operationId:randomUUID(),requestId:randomUUID(),before:{},beforeAllowlist:[],
    after:{sequence:checkpoint.sequence},afterAllowlist:['sequence'],context:{headHash:checkpoint.headHash},contextAllowlist:['headHash']});
}
export async function readRevocationKnowledge(client:PoolClient,organizationId:string,deviceId:string,actorUserId:string) {
  const rows=await client.query<{target:string;sequence:string;head_hash:string}>(
    'SELECT target,sequence::text,head_hash FROM offline_revocation_checkpoints WHERE organization_id=$1 AND device_id=$2 AND target=ANY($3::text[])',
    [organizationId,deviceId,['DEVICE',actorUserId]]);
  const device=rows.rows.find(row=>row.target==='DEVICE'),actor=rows.rows.find(row=>row.target===actorUserId);
  return {deviceSequence:device?.sequence ?? null,actorSequence:actor?.sequence ?? null,
    deviceHeadHash:device?.head_hash ?? null,actorHeadHash:actor?.head_hash ?? null};
}
