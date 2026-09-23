import { createHash, randomUUID } from 'node:crypto';

import type { PoolClient } from 'pg';

export type JsonValue = boolean | null | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface IdempotencyRequest {
  actorUserId: string;
  authorizationClass: string;
  branchId: string | null;
  key: string;
  organizationId: string;
  payload: JsonValue;
  scope: string;
}

export interface IdempotencyRecord {
  actorUserId: string;
  authorizationClass: string;
  branchId: string | null;
  id: string;
  key: string;
  organizationId: string;
  requestHash: string;
  scope: string;
  status: 'COMPLETED' | 'IN_PROGRESS';
}

export interface StoredResponse {
  body: JsonValue;
  statusCode: number;
}

export type IdempotencyAcquisition =
  | { kind: 'acquired'; record: IdempotencyRecord }
  | { kind: 'replay'; response: StoredResponse };

export type ReplayAuthorizer = (record: IdempotencyRecord) => Promise<void>;

interface IdempotencyRow {
  actor_user_id: string;
  authorization_class: string;
  branch_id: string | null;
  id: string;
  key: string;
  organization_id: string;
  request_hash: string;
  response_body: JsonValue | null;
  response_code: number | null;
  scope: string;
  status: 'COMPLETED' | 'IN_PROGRESS';
}

export class IdempotencyKeyReusedError extends Error {
  constructor() {
    super('The idempotency key was already used with a different payload.');
    this.name = 'IdempotencyKeyReusedError';
  }
}

export class IdempotencyReplayForbiddenError extends Error {
  constructor() {
    super('The idempotency key belongs to another authorization context.');
    this.name = 'IdempotencyReplayForbiddenError';
  }
}

export class IdempotencyReplayPendingError extends Error {
  constructor() {
    super('The idempotent operation has not completed yet.');
    this.name = 'IdempotencyReplayPendingError';
  }
}

export class IdempotencyService {
  constructor(private readonly client: PoolClient) {}

  async acquire(request: IdempotencyRequest, authorizeReplay: ReplayAuthorizer): Promise<IdempotencyAcquisition> {
    const requestHash = hashCanonicalJson(request.payload);
    const inserted = await this.client.query<IdempotencyRow>(
      `INSERT INTO idempotency_records (
        id, organization_id, scope, key, request_hash, status, actor_user_id, branch_id, authorization_class
      ) VALUES ($1, $2, $3, $4, $5, 'IN_PROGRESS', $6, $7, $8)
      ON CONFLICT (organization_id, scope, key) DO NOTHING
      RETURNING id, organization_id, scope, key, request_hash, status, actor_user_id, branch_id, authorization_class,
        response_code, response_body`,
      [
        randomUUID(),
        request.organizationId,
        request.scope,
        request.key,
        requestHash,
        request.actorUserId,
        request.branchId,
        request.authorizationClass,
      ],
    );

    const created = inserted.rows.at(0);
    if (created) {
      return { kind: 'acquired', record: toRecord(created) };
    }

    const existing = await this.client.query<IdempotencyRow>(
      `SELECT id, organization_id, scope, key, request_hash, status, actor_user_id, branch_id, authorization_class,
        response_code, response_body
      FROM idempotency_records
      WHERE organization_id = $1 AND scope = $2 AND key = $3
      FOR UPDATE`,
      [request.organizationId, request.scope, request.key],
    );
    const record = existing.rows.at(0);
    if (!record) {
      throw new Error('The idempotency record was not available after a conflicting insert.');
    }
    if (record.request_hash !== requestHash) {
      throw new IdempotencyKeyReusedError();
    }
    if (
      record.actor_user_id !== request.actorUserId ||
      record.branch_id !== request.branchId ||
      record.authorization_class !== request.authorizationClass
    ) {
      throw new IdempotencyReplayForbiddenError();
    }
    if (record.status !== 'COMPLETED' || record.response_code === null) {
      throw new IdempotencyReplayPendingError();
    }

    await authorizeReplay(toRecord(record));
    return {
      kind: 'replay',
      response: { body: record.response_body, statusCode: record.response_code },
    };
  }

  async complete(recordId: string, response: StoredResponse): Promise<void> {
    const updated = await this.client.query<{ id: string }>(
      `UPDATE idempotency_records
      SET status = 'COMPLETED', response_code = $2, response_body = $3::jsonb, completed_at = now()
      WHERE id = $1 AND status = 'IN_PROGRESS'
      RETURNING id`,
      [recordId, response.statusCode, canonicalizeJson(response.body)],
    );

    if (updated.rowCount !== 1) {
      throw new Error('The idempotency record cannot be completed.');
    }
  }
}

export function hashCanonicalJson(payload: JsonValue): string {
  return createHash('sha256').update(canonicalizeJson(payload)).digest('hex');
}

export function canonicalizeJson(value: JsonValue): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('Canonical JSON only accepts finite numbers.');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${Array.from({ length: value.length }, (_, index) => {
      const item = value[index];
      if (item === undefined) {
        throw new TypeError('Canonical JSON does not accept undefined array items.');
      }
      return canonicalizeJson(item);
    }).join(',')}]`;
  }

  return `{${Object.keys(value)
    .sort()
    .map((key) => {
      const item = value[key];
      if (item === undefined) {
        throw new TypeError('Canonical JSON does not accept undefined object values.');
      }
      return `${JSON.stringify(key)}:${canonicalizeJson(item)}`;
    })
    .join(',')}}`;
}

function toRecord(row: IdempotencyRow): IdempotencyRecord {
  return {
    actorUserId: row.actor_user_id,
    authorizationClass: row.authorization_class,
    branchId: row.branch_id,
    id: row.id,
    key: row.key,
    organizationId: row.organization_id,
    requestHash: row.request_hash,
    scope: row.scope,
    status: row.status,
  };
}
