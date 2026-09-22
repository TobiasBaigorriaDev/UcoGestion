export const membershipRoles = ['OWNER', 'ADMIN', 'CASHIER', 'EMPLOYEE'] as const;
export type MembershipRole = (typeof membershipRoles)[number];

export const nonOwnerMembershipRoles = ['ADMIN', 'CASHIER', 'EMPLOYEE'] as const;
export type NonOwnerMembershipRole = (typeof nonOwnerMembershipRoles)[number];

export interface MembershipBranchSnapshot {
  readonly id: string;
  readonly organizationId: string;
  readonly status: string;
}

export interface PrepareNonOwnerMembershipRequest {
  readonly actorBranchIds: readonly string[];
  readonly actorRole: string;
  readonly availableBranches: readonly MembershipBranchSnapshot[];
  readonly organizationId: string;
  readonly targetBranchIds: readonly string[];
  readonly targetRole: string;
}

export interface PreparedNonOwnerMembership {
  readonly branchIds: readonly string[];
  readonly role: NonOwnerMembershipRole;
}

export type NonOwnerMembershipPolicyErrorCode =
  | 'MEMBERSHIP_BRANCH_DUPLICATED'
  | 'MEMBERSHIP_BRANCH_INVALID'
  | 'MEMBERSHIP_BRANCH_SCOPE_FORBIDDEN'
  | 'MEMBERSHIP_BRANCH_SCOPE_REQUIRED'
  | 'MEMBERSHIP_MANAGEMENT_FORBIDDEN'
  | 'MEMBERSHIP_ROLE_INVALID';

export class NonOwnerMembershipPolicyError extends Error {
  constructor(
    readonly code: NonOwnerMembershipPolicyErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'NonOwnerMembershipPolicyError';
  }
}

export class NonOwnerMembershipPolicy {
  prepare(request: PrepareNonOwnerMembershipRequest): PreparedNonOwnerMembership {
    if (request.actorRole !== 'OWNER' && request.actorRole !== 'ADMIN') {
      throw new NonOwnerMembershipPolicyError(
        'MEMBERSHIP_MANAGEMENT_FORBIDDEN',
        'Solo OWNER o ADMIN pueden preparar una membresía no propietaria.',
      );
    }

    if (!isNonOwnerMembershipRole(request.targetRole)) {
      throw new NonOwnerMembershipPolicyError(
        'MEMBERSHIP_ROLE_INVALID',
        'La membresía debe usar un rol no propietario fijo.',
      );
    }

    if (request.targetBranchIds.length === 0) {
      throw new NonOwnerMembershipPolicyError(
        'MEMBERSHIP_BRANCH_SCOPE_REQUIRED',
        'La membresía debe tener al menos una sucursal asignada.',
      );
    }

    const targetBranchIds = new Set(request.targetBranchIds);
    if (targetBranchIds.size !== request.targetBranchIds.length) {
      throw new NonOwnerMembershipPolicyError(
        'MEMBERSHIP_BRANCH_DUPLICATED',
        'El alcance no puede repetir sucursales.',
      );
    }

    const validBranchIds = new Set(
      request.availableBranches
        .filter((branch) => branch.organizationId === request.organizationId && branch.status === 'ACTIVE')
        .map((branch) => branch.id),
    );
    if (request.targetBranchIds.some((branchId) => !validBranchIds.has(branchId))) {
      throw new NonOwnerMembershipPolicyError(
        'MEMBERSHIP_BRANCH_INVALID',
        'Todas las sucursales asignadas deben estar activas y pertenecer a la organización.',
      );
    }

    if (request.actorRole === 'ADMIN') {
      const actorBranchIds = new Set(request.actorBranchIds);
      if (request.targetBranchIds.some((branchId) => !actorBranchIds.has(branchId))) {
        throw new NonOwnerMembershipPolicyError(
          'MEMBERSHIP_BRANCH_SCOPE_FORBIDDEN',
          'ADMIN no puede conceder sucursales fuera de su propio alcance.',
        );
      }
    }

    return {
      branchIds: [...targetBranchIds].sort(),
      role: request.targetRole,
    };
  }
}

function isNonOwnerMembershipRole(role: string): role is NonOwnerMembershipRole {
  return nonOwnerMembershipRoles.some((candidate) => candidate === role);
}
