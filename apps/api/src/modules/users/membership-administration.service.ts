import type { PoolClient } from 'pg';

import { TenantTransaction, type TenantTransactionContext } from '../../database/tenant-transaction.js';
import {
  type MembershipBranchSnapshot,
  type MembershipRole,
  NonOwnerMembershipPolicy,
  NonOwnerMembershipPolicyError,
} from './non-owner-membership.policy.js';

interface MembershipAdministrationOptions {
  readonly now?: () => Date;
}

interface MembershipRow {
  readonly id: string;
  readonly role: MembershipRole;
  readonly status: string;
  readonly version: number;
}

export interface MembershipRoleChange {
  readonly branchIds: readonly string[];
  readonly expectedVersion: number;
  readonly role: MembershipRole;
}

export interface MembershipStatusChange {
  readonly expectedVersion: number;
  readonly status: 'ACTIVE' | 'INACTIVE';
}

export type MembershipAdministrationErrorCode =
  | 'MEMBERSHIP_MANAGEMENT_FORBIDDEN'
  | 'MEMBERSHIP_NOT_MUTABLE'
  | 'MEMBERSHIP_VERSION_CONFLICT'
  | 'ORGANIZATION_OWNER_REQUIRED'
  | 'OWNER_MEMBERSHIP_FORBIDDEN';

export class MembershipAdministrationError extends Error {
  constructor(
    readonly code: MembershipAdministrationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'MembershipAdministrationError';
  }
}

export class MembershipAdministrationService {
  private readonly now: () => Date;
  private readonly nonOwnerPolicy = new NonOwnerMembershipPolicy();

  constructor(
    private readonly transactions: TenantTransaction,
    options: MembershipAdministrationOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async changeRole(
    context: TenantTransactionContext,
    membershipId: string,
    change: MembershipRoleChange,
  ): Promise<{ readonly role: MembershipRole; readonly version: number }> {
    return this.transactions.run(
      context,
      this.auditEvent('membership.role_changed', membershipId, { role: change.role }),
      async (client) => {
        const organizationIsActive = await this.lockOrganization(client, context.organizationId);
        const { actor, target } = await this.loadActorAndTarget(client, context, membershipId);
        this.authorizeOwnerMutation(actor, target, change.role);
        await this.requireRemainingOwner(
          client,
          context.organizationId,
          organizationIsActive,
          target,
          change.role,
        );

        const branchIds = change.role === 'OWNER'
          ? this.requireOwnerScope(change.branchIds)
          : await this.prepareNonOwnerScope(
            client,
            context.organizationId,
            actor,
            target.id,
            change,
          );

        const updated = await client.query<{ role: MembershipRole; version: number }>(
          `UPDATE memberships
           SET role = $1, version = version + 1
           WHERE organization_id = $2 AND id = $3 AND status = 'ACTIVE' AND version = $4
           RETURNING role, version::integer AS version`,
          [change.role, context.organizationId, membershipId, change.expectedVersion],
        );
        const row = updated.rows.at(0);
        if (!row) {
          throw new MembershipAdministrationError(
            'MEMBERSHIP_VERSION_CONFLICT',
            'La membresía cambió o dejó de estar activa.',
          );
        }

        await client.query(
          'DELETE FROM membership_branches WHERE organization_id = $1 AND membership_id = $2',
          [context.organizationId, membershipId],
        );
        for (const branchId of branchIds) {
          await client.query(
            `INSERT INTO membership_branches (organization_id, membership_id, branch_id)
             VALUES ($1, $2, $3)`,
            [context.organizationId, membershipId, branchId],
          );
        }
        return row;
      },
    );
  }

  async revoke(
    context: TenantTransactionContext,
    membershipId: string,
    expectedVersion: number,
  ): Promise<{ readonly revokedAt: string; readonly version: number }> {
    const revokedAt = this.now();
    return this.transactions.run(
      context,
      this.auditEvent('membership.revoked', membershipId, { status: 'REVOKED' }),
      async (client) => {
        const organizationIsActive = await this.lockOrganization(client, context.organizationId);
        const { actor, target } = await this.loadActorAndTarget(client, context, membershipId);
        this.authorizeOwnerMutation(actor, target, target.role);
        await this.requireRemainingOwner(
          client,
          context.organizationId,
          organizationIsActive,
          target,
          null,
        );
        const updated = await client.query<{ version: number }>(
          `UPDATE memberships
           SET status = 'REVOKED', revoked_at = $1, deactivated_at = NULL, version = version + 1
           WHERE organization_id = $2 AND id = $3 AND status = 'ACTIVE' AND version = $4
           RETURNING version::integer AS version`,
          [revokedAt, context.organizationId, membershipId, expectedVersion],
        );
        const row = updated.rows.at(0);
        if (!row) {
          throw new MembershipAdministrationError(
            'MEMBERSHIP_VERSION_CONFLICT',
            'La membresía cambió o dejó de estar activa.',
          );
        }
        return { revokedAt: revokedAt.toISOString(), version: row.version };
      },
    );
  }

  async setStatus(
    context: TenantTransactionContext,
    membershipId: string,
    change: MembershipStatusChange,
  ): Promise<{ readonly status: 'ACTIVE' | 'INACTIVE'; readonly version: number }> {
    const changedAt = this.now();
    const expectedStatus = change.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE';
    return this.transactions.run(
      context,
      this.auditEvent('membership.status_changed', membershipId, { status: change.status }),
      async (client) => {
        const organizationIsActive = await this.lockOrganization(client, context.organizationId);
        const { actor, target } = await this.loadActorAndTarget(
          client,
          context,
          membershipId,
          [expectedStatus],
        );
        this.authorizeOwnerMutation(actor, target, target.role);
        await this.requireRemainingOwner(
          client,
          context.organizationId,
          organizationIsActive,
          target,
          change.status === 'ACTIVE' ? target.role : null,
        );

        const updated = await client.query<{ status: 'ACTIVE' | 'INACTIVE'; version: number }>(
          `UPDATE memberships
           SET status = $1::text,
               deactivated_at = CASE
                 WHEN $1::text = 'INACTIVE' THEN $2::timestamptz
                 ELSE NULL::timestamptz
               END,
               version = version + 1
           WHERE organization_id = $3 AND id = $4 AND status = $5 AND version = $6
           RETURNING status, version::integer AS version`,
          [
            change.status,
            changedAt,
            context.organizationId,
            membershipId,
            expectedStatus,
            change.expectedVersion,
          ],
        );
        const row = updated.rows.at(0);
        if (!row) {
          throw new MembershipAdministrationError(
            'MEMBERSHIP_VERSION_CONFLICT',
            'La membresía cambió de estado o versión.',
          );
        }
        return row;
      },
    );
  }

  async recordDeviceRevocationKnowledge(
    context: TenantTransactionContext,
    membershipId: string,
    deviceId: string,
  ): Promise<{ readonly knownAt: string }> {
    const knownAt = this.now();
    return this.transactions.run(
      context,
      {
        action: 'membership.revocation_known_by_device',
        after: { knownAt: knownAt.toISOString() },
        afterAllowlist: ['knownAt'],
        before: {},
        beforeAllowlist: [],
        branchId: null,
        context: {},
        contextAllowlist: [],
        deviceId,
        entityId: membershipId,
        entityType: 'membership',
        operationId: `${membershipId}:${deviceId}`,
      },
      async (client) => {
        const membership = await client.query<{ revoked_at: Date }>(
          `SELECT revoked_at
           FROM memberships
           WHERE organization_id = $1 AND id = $2 AND status = 'REVOKED'
           FOR UPDATE`,
          [context.organizationId, membershipId],
        );
        const revokedAt = membership.rows.at(0)?.revoked_at;
        if (!revokedAt) {
          throw new MembershipAdministrationError(
            'MEMBERSHIP_NOT_MUTABLE',
            'La membresía no posee una revocación vigente.',
          );
        }

        await client.query(
          `INSERT INTO membership_revocation_device_knowledge (
             organization_id, membership_id, device_id, revoked_at, known_at
           ) VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (organization_id, membership_id, device_id) DO NOTHING`,
          [context.organizationId, membershipId, deviceId, revokedAt, knownAt],
        );
        const stored = await client.query<{ known_at: Date }>(
          `SELECT known_at
           FROM membership_revocation_device_knowledge
           WHERE organization_id = $1 AND membership_id = $2 AND device_id = $3`,
          [context.organizationId, membershipId, deviceId],
        );
        const firstKnownAt = stored.rows.at(0)?.known_at;
        if (!firstKnownAt) {
          throw new Error('El conocimiento de revocación no fue persistido.');
        }
        return { knownAt: firstKnownAt.toISOString() };
      },
    );
  }

  private async lockOrganization(client: PoolClient, organizationId: string): Promise<boolean> {
    const result = await client.query<{ status: string }>(
      'SELECT status FROM organizations WHERE id = $1 FOR UPDATE',
      [organizationId],
    );
    return result.rows.at(0)?.status === 'ACTIVE';
  }

  private async requireRemainingOwner(
    client: PoolClient,
    organizationId: string,
    organizationIsActive: boolean,
    target: MembershipRow,
    resultingRole: MembershipRole | null,
  ): Promise<void> {
    if (!organizationIsActive || target.role !== 'OWNER' || resultingRole === 'OWNER') {
      return;
    }
    const remaining = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM memberships
         WHERE organization_id = $1
           AND id <> $2
           AND role = 'OWNER'
           AND status = 'ACTIVE'
       ) AS exists`,
      [organizationId, target.id],
    );
    if (remaining.rows.at(0)?.exists !== true) {
      throw new MembershipAdministrationError(
        'ORGANIZATION_OWNER_REQUIRED',
        'La organización activa debe conservar al menos un OWNER activo.',
      );
    }
  }

  private async loadActorAndTarget(
    client: PoolClient,
    context: TenantTransactionContext,
    targetMembershipId: string,
    allowedTargetStatuses: readonly string[] = ['ACTIVE'],
  ): Promise<{ actor: MembershipRow; target: MembershipRow }> {
    const result = await client.query<MembershipRow>(
      `SELECT id, role, status, version::integer AS version
       FROM memberships
       WHERE organization_id = $1
         AND (user_id = $2 OR id = $3)
       FOR UPDATE`,
      [context.organizationId, context.userId, targetMembershipId],
    );
    const actor = result.rows.find((row) => row.id !== targetMembershipId)
      ?? result.rows.find((row) => row.id === targetMembershipId);
    const target = result.rows.find((row) => row.id === targetMembershipId);
    if (
      !actor
      || actor.status !== 'ACTIVE'
      || !target
      || !allowedTargetStatuses.includes(target.status)
    ) {
      throw new MembershipAdministrationError(
        'MEMBERSHIP_NOT_MUTABLE',
        'La membresía activa no está disponible.',
      );
    }
    return { actor, target };
  }

  private authorizeOwnerMutation(
    actor: MembershipRow,
    target: MembershipRow,
    resultingRole: MembershipRole,
  ): void {
    if (actor.role !== 'OWNER' && actor.role !== 'ADMIN') {
      throw new MembershipAdministrationError(
        'MEMBERSHIP_MANAGEMENT_FORBIDDEN',
        'Solo OWNER o ADMIN pueden administrar membresías.',
      );
    }
    if (actor.role !== 'OWNER' && (target.role === 'OWNER' || resultingRole === 'OWNER')) {
      throw new MembershipAdministrationError(
        'OWNER_MEMBERSHIP_FORBIDDEN',
        'Solo OWNER puede administrar una membresía OWNER.',
      );
    }
  }

  private requireOwnerScope(branchIds: readonly string[]): readonly string[] {
    if (branchIds.length !== 0) {
      throw new NonOwnerMembershipPolicyError(
        'MEMBERSHIP_BRANCH_INVALID',
        'OWNER obtiene alcance global y no admite sucursales explícitas.',
      );
    }
    return [];
  }

  private async prepareNonOwnerScope(
    client: PoolClient,
    organizationId: string,
    actor: MembershipRow,
    targetMembershipId: string,
    change: MembershipRoleChange,
  ): Promise<readonly string[]> {
    const branches = await client.query<MembershipBranchSnapshot>(
      `SELECT id, organization_id AS "organizationId", status
       FROM branches WHERE organization_id = $1`,
      [organizationId],
    );
    const actorScope = await client.query<{ branchId: string }>(
      `SELECT branch_id AS "branchId"
       FROM effective_membership_branch_scope
       WHERE organization_id = $1 AND membership_id = $2`,
      [organizationId, actor.id],
    );
    const targetScope = await client.query<{ branchId: string }>(
      `SELECT branch_id AS "branchId"
       FROM membership_branches
       WHERE organization_id = $1 AND membership_id = $2`,
      [organizationId, targetMembershipId],
    );
    const actorBranchIds = actorScope.rows.map(({ branchId }) => branchId);
    const requested = this.nonOwnerPolicy.prepare({
      actorBranchIds,
      actorRole: actor.role,
      allowEmptyScope: actor.role === 'ADMIN',
      availableBranches: branches.rows,
      organizationId,
      targetBranchIds: change.branchIds,
      targetRole: change.role,
    }).branchIds;
    if (actor.role !== 'ADMIN') {
      return requested;
    }

    const actorScopeSet = new Set(actorBranchIds);
    const preservedOutsideScope = targetScope.rows
      .map(({ branchId }) => branchId)
      .filter((branchId) => !actorScopeSet.has(branchId));
    const finalScope = [...new Set([...requested, ...preservedOutsideScope])].sort();
    if (finalScope.length === 0) {
      throw new NonOwnerMembershipPolicyError(
        'MEMBERSHIP_BRANCH_SCOPE_REQUIRED',
        'La membresía debe conservar al menos una sucursal asignada.',
      );
    }
    return finalScope;
  }

  private auditEvent(action: string, membershipId: string, after: Record<string, string>) {
    return {
      action,
      after,
      afterAllowlist: Object.keys(after),
      before: {},
      beforeAllowlist: [],
      branchId: null,
      context: {},
      contextAllowlist: [],
      entityId: membershipId,
      entityType: 'membership',
      operationId: membershipId,
    };
  }
}
