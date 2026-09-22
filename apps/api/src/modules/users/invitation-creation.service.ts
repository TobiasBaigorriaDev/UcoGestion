import { createHash, randomBytes, randomUUID } from 'node:crypto';

import type { PoolClient } from 'pg';

import { normalizeEmail } from '../auth/global-user.repository.js';
import {
  NonOwnerMembershipPolicy,
  type MembershipBranchSnapshot,
  type MembershipRole,
} from './non-owner-membership.policy.js';
import { TenantTransaction, type TenantTransactionContext } from '../../database/tenant-transaction.js';

const invitationLifetimeMs = 7 * 24 * 60 * 60 * 1_000;

export interface CreateInvitationInput {
  readonly branchIds: readonly string[];
  readonly email: string;
  readonly role: string;
}

export interface CreateInvitationResult {
  readonly expiresAt: string;
  readonly invitationId: string;
}

interface InvitationCreationOptions {
  readonly now?: () => Date;
}

interface ActorMembership {
  readonly id: string;
  readonly role: MembershipRole;
}

export class InvitationCreationPolicyError extends Error {
  readonly code: 'INVITATION_OWNER_BRANCH_SCOPE_INVALID' | 'INVITATION_OWNER_FORBIDDEN';

  constructor(
    code: 'INVITATION_OWNER_BRANCH_SCOPE_INVALID' | 'INVITATION_OWNER_FORBIDDEN',
    message: string,
  ) {
    super(message);
    this.name = 'InvitationCreationPolicyError';
    this.code = code;
  }
}

export class InvitationCreationService {
  private readonly now: () => Date;
  private readonly nonOwnerPolicy = new NonOwnerMembershipPolicy();

  constructor(
    private readonly transactions: TenantTransaction,
    options: InvitationCreationOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async create(
    context: TenantTransactionContext,
    input: CreateInvitationInput,
  ): Promise<CreateInvitationResult> {
    const invitationId = randomUUID();
    const email = normalizeEmail(input.email);
    const createdAt = this.now();
    const expiresAt = new Date(createdAt.getTime() + invitationLifetimeMs);
    const token = randomBytes(32).toString('base64url');
    const tokenHash = createHash('sha256').update(token).digest('hex');

    return this.transactions.run(
      context,
      {
        action: 'invitation.created',
        after: { branchCount: input.branchIds.length, email, role: input.role, status: 'PENDING' },
        afterAllowlist: ['branchCount', 'email', 'role', 'status'],
        before: {},
        beforeAllowlist: [],
        branchId: null,
        context: {},
        contextAllowlist: [],
        entityId: invitationId,
        entityType: 'invitation',
        operationId: invitationId,
      },
      async (client) => {
        const actor = await this.loadActor(client, context);
        const branchIds = await this.authorizeScope(client, context.organizationId, actor, input);
        await client.query(
          `INSERT INTO invitations (
             id, organization_id, email_normalized, role, status, token_hash,
             expires_at, invited_by_membership_id, created_at
           ) VALUES ($1, $2, $3, $4, 'PENDING', $5, $6, $7, $8)`,
          [
            invitationId,
            context.organizationId,
            email,
            input.role,
            tokenHash,
            expiresAt,
            actor.id,
            createdAt,
          ],
        );
        for (const branchId of branchIds) {
          await client.query(
            `INSERT INTO invitation_branches (organization_id, invitation_id, branch_id, created_at)
             VALUES ($1, $2, $3, $4)`,
            [context.organizationId, invitationId, branchId, createdAt],
          );
        }
        await client.query(
          `INSERT INTO outbox_jobs (
             id, organization_id, job_key, job_type, payload, actor_user_id,
             branch_id, authorization_class, available_at, created_at
           ) VALUES ($1, $2, $3, 'INVITATION_EMAIL', $4::jsonb, $5, NULL, 'MEMBERSHIP_ADMINISTRATION', $6, $6)`,
          [
            randomUUID(),
            context.organizationId,
            `invitation-email:${invitationId}`,
            JSON.stringify({ branchIds, email, invitationId, role: input.role, token }),
            context.userId,
            createdAt,
          ],
        );
        await client.query(
          `INSERT INTO outbox_jobs (
             id, organization_id, job_key, job_type, payload, actor_user_id,
             branch_id, authorization_class, available_at, created_at
           ) VALUES ($1, $2, $3, 'INVITATION_EXPIRATION', $4::jsonb, $5, NULL, 'MEMBERSHIP_ADMINISTRATION', $6, $7)`,
          [
            randomUUID(),
            context.organizationId,
            `invitation-expiration:${invitationId}:${expiresAt.toISOString()}`,
            JSON.stringify({ expiresAt: expiresAt.toISOString(), invitationId }),
            context.userId,
            expiresAt,
            createdAt,
          ],
        );
        return { expiresAt: expiresAt.toISOString(), invitationId };
      },
    );
  }

  private async loadActor(
    client: PoolClient,
    context: TenantTransactionContext,
  ): Promise<ActorMembership> {
    const result = await client.query<ActorMembership>(
      `SELECT id, role
       FROM memberships
       WHERE organization_id = $1
         AND user_id = $2
         AND status = 'ACTIVE'
         AND revoked_at IS NULL
       FOR UPDATE`,
      [context.organizationId, context.userId],
    );
    const actor = result.rows.at(0);
    if (!actor) {
      throw new InvitationCreationPolicyError('INVITATION_OWNER_FORBIDDEN', 'La membresía activa no está disponible.');
    }
    return actor;
  }

  private async authorizeScope(
    client: PoolClient,
    organizationId: string,
    actor: ActorMembership,
    input: CreateInvitationInput,
  ): Promise<readonly string[]> {
    if (input.role === 'OWNER') {
      if (actor.role !== 'OWNER') {
        throw new InvitationCreationPolicyError(
          'INVITATION_OWNER_FORBIDDEN',
          'Solo OWNER puede invitar otra membresía OWNER.',
        );
      }
      if (input.branchIds.length !== 0) {
        throw new InvitationCreationPolicyError(
          'INVITATION_OWNER_BRANCH_SCOPE_INVALID',
          'OWNER obtiene todas las sucursales y no admite asignaciones redundantes.',
        );
      }
      return [];
    }

    const [availableBranches, actorScope] = await Promise.all([
      client.query<MembershipBranchSnapshot>(
        `SELECT id, organization_id AS "organizationId", status
         FROM branches WHERE organization_id = $1`,
        [organizationId],
      ),
      client.query<{ branchId: string }>(
        `SELECT branch_id AS "branchId"
         FROM effective_membership_branch_scope
         WHERE organization_id = $1 AND membership_id = $2`,
        [organizationId, actor.id],
      ),
    ]);
    return this.nonOwnerPolicy.prepare({
      actorBranchIds: actorScope.rows.map(({ branchId }) => branchId),
      actorRole: actor.role,
      availableBranches: availableBranches.rows,
      organizationId,
      targetBranchIds: input.branchIds,
      targetRole: input.role,
    }).branchIds;
  }
}
