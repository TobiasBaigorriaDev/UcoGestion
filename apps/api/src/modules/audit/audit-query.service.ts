import type { PoolClient } from 'pg';

import { encodeCursor, type Cursor } from '../../core/validation/pagination.js';
import { TenantTransaction, type TenantTransactionContext } from '../../database/tenant-transaction.js';

export interface AuditQuery {
  readonly limit: number;
  readonly cursor?: Cursor | undefined;
  readonly branchId?: string | undefined;
  readonly action?: string | undefined;
  readonly actorUserId?: string | undefined;
}

interface AuditRow {
  readonly id: string;
  readonly organization_id: string;
  readonly actor_user_id: string;
  readonly branch_id: string | null;
  readonly device_id: string | null;
  readonly request_id: string;
  readonly operation_id: string;
  readonly entity_type: string;
  readonly entity_id: string;
  readonly action: string;
  readonly before_data: Record<string, unknown>;
  readonly after_data: Record<string, unknown>;
  readonly context_data: Record<string, unknown>;
  readonly occurred_at: Date;
  readonly occurred_cursor: string;
}

export class AuditAccessError extends Error {
  readonly code = 'AUDIT_ACCESS_FORBIDDEN';

  constructor() {
    super('No tenés acceso a la auditoría de esta organización.');
  }
}

export class AuditQueryService {
  constructor(private readonly transactions: TenantTransaction) {}

  async list(context: TenantTransactionContext, query: AuditQuery) {
    return this.transactions.read(context, async (client) => {
      const membership = await this.membership(client, context);
      if (membership?.role !== 'OWNER' && membership?.role !== 'ADMIN') throw new AuditAccessError();
      const result = await client.query<AuditRow>(`SELECT id, organization_id, actor_user_id,
        branch_id, device_id, request_id, operation_id, entity_type, entity_id, action,
        before_data, after_data, context_data, occurred_at,
        to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_cursor
        FROM audit_events
        WHERE organization_id = $1
          AND ($8::text = 'OWNER' OR
            (branch_id IS NOT NULL AND EXISTS (
              SELECT 1 FROM effective_membership_branch_scope s
              WHERE s.organization_id = audit_events.organization_id
                AND s.membership_id = $9::uuid AND s.branch_id = audit_events.branch_id
            )) OR
            (branch_id IS NULL AND (
              entity_type IN ('catalog_item', 'catalog_category', 'expense_category',
                'payment_method_setting', 'customer', 'supplier')
              OR (entity_type = 'organization' AND action = 'organization.profile_updated')
              OR (entity_type = 'membership' AND EXISTS (
                SELECT 1 FROM memberships target
                JOIN membership_branches target_scope
                  ON target_scope.organization_id = target.organization_id
                  AND target_scope.membership_id = target.id
                JOIN effective_membership_branch_scope actor_scope
                  ON actor_scope.organization_id = target_scope.organization_id
                  AND actor_scope.branch_id = target_scope.branch_id
                WHERE target.organization_id = audit_events.organization_id
                  AND target.id = audit_events.entity_id AND target.role <> 'OWNER'
                  AND actor_scope.membership_id = $9::uuid
              ))
              OR (entity_type = 'invitation' AND EXISTS (
                SELECT 1 FROM invitations target
                JOIN invitation_branches target_scope
                  ON target_scope.organization_id = target.organization_id
                  AND target_scope.invitation_id = target.id
                JOIN effective_membership_branch_scope actor_scope
                  ON actor_scope.organization_id = target_scope.organization_id
                  AND actor_scope.branch_id = target_scope.branch_id
                WHERE target.organization_id = audit_events.organization_id
                  AND target.id = audit_events.entity_id AND target.role <> 'OWNER'
                  AND actor_scope.membership_id = $9::uuid
              ))
            )))
          AND ($2::uuid IS NULL OR branch_id = $2)
          AND ($3::text IS NULL OR action = $3)
          AND ($4::uuid IS NULL OR actor_user_id = $4)
          AND ($5::timestamptz IS NULL OR (occurred_at, id) < ($5, $6::uuid))
        ORDER BY occurred_at DESC, id DESC LIMIT $7`,
      [context.organizationId, query.branchId ?? null, query.action ?? null,
        query.actorUserId ?? null, query.cursor?.sortValue ?? null,
        query.cursor?.id ?? null, query.limit + 1, membership.role, membership.id]);
      const rows = result.rows.slice(0, query.limit);
      const last = rows.at(-1);
      return {
        items: rows.map((row) => ({
          id: row.id, organizationId: row.organization_id, actorUserId: row.actor_user_id,
          branchId: row.branch_id, deviceId: row.device_id, requestId: row.request_id,
          operationId: row.operation_id, entityType: row.entity_type, entityId: row.entity_id,
          action: row.action, before: row.before_data, after: row.after_data,
          context: row.context_data, occurredAt: row.occurred_at.toISOString(),
        })),
        nextCursor: result.rows.length > query.limit && last
          ? encodeCursor({ id: last.id, sortValue: last.occurred_cursor }) : null,
      };
    });
  }

  private async membership(client: PoolClient, context: TenantTransactionContext) {
    const result = await client.query<{ id: string; role: string }>(`SELECT id, role FROM memberships
      WHERE organization_id = $1 AND user_id = $2 AND status = 'ACTIVE'
        AND revoked_at IS NULL`,
    [context.organizationId, context.userId]);
    return result.rows.at(0) ?? null;
  }
}
