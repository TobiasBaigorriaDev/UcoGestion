import { describe, expect, it } from 'vitest';

import {
  NonOwnerMembershipPolicy,
  NonOwnerMembershipPolicyError,
} from '../src/modules/users/non-owner-membership.policy.js';

const organizationId = '00000000-0000-4000-8000-000000000001';
const otherOrganizationId = '00000000-0000-4000-8000-000000000002';
const firstBranchId = '00000000-0000-4000-8000-000000000003';
const secondBranchId = '00000000-0000-4000-8000-000000000004';
const inactiveBranchId = '00000000-0000-4000-8000-000000000005';
const foreignBranchId = '00000000-0000-4000-8000-000000000006';

const branches = [
  { id: firstBranchId, organizationId, status: 'ACTIVE' },
  { id: secondBranchId, organizationId, status: 'ACTIVE' },
  { id: inactiveBranchId, organizationId, status: 'INACTIVE' },
  { id: foreignBranchId, organizationId: otherOrganizationId, status: 'ACTIVE' },
] as const;

describe('non-owner membership policy', () => {
  const policy = new NonOwnerMembershipPolicy();

  it.each(['ADMIN', 'CASHIER', 'EMPLOYEE'] as const)(
    'prepares the fixed %s role for an OWNER using active branches from the organization',
    (targetRole) => {
      expect(policy.prepare({
        actorBranchIds: [],
        actorRole: 'OWNER',
        availableBranches: branches,
        organizationId,
        targetBranchIds: [secondBranchId, firstBranchId],
        targetRole,
      })).toEqual({
        branchIds: [firstBranchId, secondBranchId],
        role: targetRole,
      });
    },
  );

  it('allows ADMIN only when every assigned branch belongs to its own scope', () => {
    expect(policy.prepare({
      actorBranchIds: [secondBranchId, firstBranchId],
      actorRole: 'ADMIN',
      availableBranches: branches,
      organizationId,
      targetBranchIds: [firstBranchId],
      targetRole: 'CASHIER',
    })).toEqual({ branchIds: [firstBranchId], role: 'CASHIER' });

    expectPolicyError(() => policy.prepare({
      actorBranchIds: [firstBranchId],
      actorRole: 'ADMIN',
      availableBranches: branches,
      organizationId,
      targetBranchIds: [secondBranchId],
      targetRole: 'EMPLOYEE',
    }), 'MEMBERSHIP_BRANCH_SCOPE_FORBIDDEN');
  });

  it.each(['OWNER', 'MANAGER'])('rejects the non-owner target role %s', (targetRole) => {
    expectPolicyError(() => policy.prepare({
      actorBranchIds: [],
      actorRole: 'OWNER',
      availableBranches: branches,
      organizationId,
      targetBranchIds: [firstBranchId],
      targetRole,
    }), 'MEMBERSHIP_ROLE_INVALID');
  });

  it('rejects empty, duplicate, inactive, missing and cross-tenant branch assignments', () => {
    const invalidScopes = [
      { branchIds: [], code: 'MEMBERSHIP_BRANCH_SCOPE_REQUIRED' },
      { branchIds: [firstBranchId, firstBranchId], code: 'MEMBERSHIP_BRANCH_DUPLICATED' },
      { branchIds: [inactiveBranchId], code: 'MEMBERSHIP_BRANCH_INVALID' },
      { branchIds: ['00000000-0000-4000-8000-000000000099'], code: 'MEMBERSHIP_BRANCH_INVALID' },
      { branchIds: [foreignBranchId], code: 'MEMBERSHIP_BRANCH_INVALID' },
    ] as const;

    for (const { branchIds, code } of invalidScopes) {
      expectPolicyError(() => policy.prepare({
        actorBranchIds: [],
        actorRole: 'OWNER',
        availableBranches: branches,
        organizationId,
        targetBranchIds: branchIds,
        targetRole: 'ADMIN',
      }), code);
    }
  });

  it.each(['CASHIER', 'EMPLOYEE'])('does not allow %s to prepare memberships', (actorRole) => {
    expectPolicyError(() => policy.prepare({
      actorBranchIds: [firstBranchId],
      actorRole,
      availableBranches: branches,
      organizationId,
      targetBranchIds: [firstBranchId],
      targetRole: 'EMPLOYEE',
    }), 'MEMBERSHIP_MANAGEMENT_FORBIDDEN');
  });
});

function expectPolicyError(
  action: () => unknown,
  code: NonOwnerMembershipPolicyError['code'],
): void {
  try {
    action();
    throw new Error('Expected NonOwnerMembershipPolicyError.');
  } catch (error) {
    expect(error).toBeInstanceOf(NonOwnerMembershipPolicyError);
    expect((error as NonOwnerMembershipPolicyError).code).toBe(code);
  }
}
