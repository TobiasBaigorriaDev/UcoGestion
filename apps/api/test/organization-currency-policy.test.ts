import { describe, expect, it } from 'vitest';

import {
  OrganizationCurrencyChangeDeniedError,
  OrganizationCurrencyChangePolicy,
  organizationCurrencyChangeSchema,
} from '../src/modules/organizations/organization-currency-change.policy.js';
import { OrganizationsController } from '../src/modules/organizations/organizations.controller.js';

describe('organization base currency change policy', () => {
  const policy = new OrganizationCurrencyChangePolicy();

  it('allows only OWNER without server history and returns a canonical ISO 4217 code', () => {
    expect(policy.authorize({ actorRole: 'OWNER', hasServerHistory: false, targetCurrency: ' usd ' }))
      .toEqual({ targetCurrency: 'USD' });

    for (const actorRole of ['ADMIN', 'MANAGER', 'CASHIER', 'EMPLOYEE']) {
      expect(() => policy.authorize({ actorRole, hasServerHistory: false, targetCurrency: 'USD' }))
        .toThrow(OrganizationCurrencyChangeDeniedError);
    }
  });

  it('rejects known history and invalid currencies without exposing a mutation endpoint yet', () => {
    expect(() => policy.authorize({ actorRole: 'OWNER', hasServerHistory: true, targetCurrency: 'USD' }))
      .toThrow(OrganizationCurrencyChangeDeniedError);
    expect(() => organizationCurrencyChangeSchema.parse({ targetCurrency: 'ZZZ' })).toThrow();
    expect('updateCurrency' in OrganizationsController.prototype).toBe(false);
  });
});
