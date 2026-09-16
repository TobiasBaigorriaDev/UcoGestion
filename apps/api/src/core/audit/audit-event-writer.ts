import { randomUUID } from 'node:crypto';

import type { PoolClient } from 'pg';

export type AuditJsonValue = boolean | null | number | string | AuditJsonValue[] | { [key: string]: AuditJsonValue };
export type AuditJsonObject = { [key: string]: AuditJsonValue };

export interface AuditEventInput {
  action: string;
  actorUserId: string;
  after: AuditJsonObject;
  afterAllowlist: readonly string[];
  before: AuditJsonObject;
  beforeAllowlist: readonly string[];
  branchId: string | null;
  context: AuditJsonObject;
  contextAllowlist: readonly string[];
  deviceId?: string | null;
  entityId: string;
  entityType: string;
  operationId: string;
  organizationId: string;
  requestId: string;
}

export interface AuditEvent {
  action: string;
  actorUserId: string;
  after: AuditJsonObject;
  before: AuditJsonObject;
  branchId: string | null;
  context: AuditJsonObject;
  deviceId: string | null;
  entityId: string;
  entityType: string;
  id: string;
  operationId: string;
  organizationId: string;
  requestId: string;
}

interface AuditEventRow {
  action: string;
  actor_user_id: string;
  after_data: AuditJsonObject;
  before_data: AuditJsonObject;
  branch_id: string | null;
  context_data: AuditJsonObject;
  device_id: string | null;
  entity_id: string;
  entity_type: string;
  id: string;
  operation_id: string;
  organization_id: string;
  request_id: string;
}

const sensitiveAuditField = /(password|passphrase|token|secret|credential|cookie|authorization|api[_-]?key|private[_-]?key|session)/i;

export class AuditEventWriter {
  constructor(private readonly client: PoolClient) {}

  async append(input: AuditEventInput): Promise<AuditEvent> {
    const before = projectAuditFields(input.before, input.beforeAllowlist);
    const after = projectAuditFields(input.after, input.afterAllowlist);
    const context = projectAuditFields(input.context, input.contextAllowlist);
    const result = await this.client.query<AuditEventRow>(
      `INSERT INTO audit_events (
        id, organization_id, actor_user_id, branch_id, device_id, request_id, operation_id,
        entity_type, entity_id, action, before_data, after_data, context_data
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb, $13::jsonb)
      RETURNING id, organization_id, actor_user_id, branch_id, device_id, request_id, operation_id,
        entity_type, entity_id, action, before_data, after_data, context_data`,
      [
        randomUUID(),
        input.organizationId,
        input.actorUserId,
        input.branchId,
        input.deviceId ?? null,
        input.requestId,
        input.operationId,
        input.entityType,
        input.entityId,
        input.action,
        JSON.stringify(before),
        JSON.stringify(after),
        JSON.stringify(context),
      ],
    );
    const row = result.rows.at(0);
    if (!row) {
      throw new Error('The audit event was not persisted.');
    }

    return {
      action: row.action,
      actorUserId: row.actor_user_id,
      after: row.after_data,
      before: row.before_data,
      branchId: row.branch_id,
      context: row.context_data,
      deviceId: row.device_id,
      entityId: row.entity_id,
      entityType: row.entity_type,
      id: row.id,
      operationId: row.operation_id,
      organizationId: row.organization_id,
      requestId: row.request_id,
    };
  }
}

export function projectAuditFields(source: AuditJsonObject, allowlist: readonly string[]): AuditJsonObject {
  const allowed = new Set(allowlist);
  const projected: AuditJsonObject = {};

  for (const [key, value] of Object.entries(source)) {
    if (allowed.has(key) && !sensitiveAuditField.test(key) && !containsSensitiveField(value)) {
      projected[key] = value;
    }
  }

  return projected;
}

function containsSensitiveField(value: AuditJsonValue): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => containsSensitiveField(item));
  }
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  return Object.entries(value).some(
    ([key, item]) => sensitiveAuditField.test(key) || containsSensitiveField(item),
  );
}
