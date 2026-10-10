import fc from 'fast-check';
import { expect, it } from 'vitest';

import { offlineConfigurationSchema, offlineGrantClaimsSchema } from './offline-contracts.js';

const id = '11111111-1111-4111-8111-111111111111';
const claims = { version: 1, grantId: id, organizationId: id, actorUserId: id, deviceId: id, branchId: id,
  epoch: '1', configurationVersion: '1', cashRegisterIds: [id], role: 'CASHIER', permissions: { canDiscount: false },
  thumbprint: 'registered', bootstrapHash: 'a'.repeat(64), iat: 1_000_000, exp: 1_000_000 + 72 * 60 * 60 };

it('rejects every generated grant lifetime above 72 hours', () => {
  fc.assert(fc.property(fc.integer({ min: 72 * 60 * 60 + 1, max: 365 * 24 * 60 * 60 }), duration => {
    expect(offlineGrantClaimsSchema.safeParse({ ...claims, exp: claims.iat + duration }).success).toBe(false);
  }));
  expect(offlineGrantClaimsSchema.safeParse(claims).success).toBe(true);
});

it('excludes private master data and noncanonical monetary values from the public offline contract', () => {
  const configuration = { currency: 'ARS', items: [], categories: [], branches: [], cashRegisters: [], paymentMethods: [] };
  expect(offlineConfigurationSchema.safeParse({ ...configuration, customers: [{ name: 'Private' }] }).success).toBe(false);
  const item = { id, name: 'Public item', sku: null, barcode: null, type: 'PRODUCT', baseUnit: 'UNIT', trackInventory: true,
    price: '1.00', priceVersion: 1 };
  expect(offlineConfigurationSchema.safeParse({ ...configuration, items: [{ ...item, cost: '0.50' }] }).success).toBe(false);
  expect(offlineConfigurationSchema.safeParse({ ...configuration, items: [{ ...item, price: 1 }] }).success).toBe(false);
  expect(offlineConfigurationSchema.safeParse({ ...configuration, items: [item] }).success).toBe(true);
});


it('T236J keeps legacy configuration exact and requires explicit category in v2', () => {
  const item = { id, name: 'Item', sku: null, barcode: null, type: 'PRODUCT', baseUnit: 'UNIT',
    trackInventory: true, price: '1.00', priceVersion: 1 };
  const legacy = { currency: 'ARS', items: [item], categories: [], branches: [], cashRegisters: [], paymentMethods: [] };
  expect(offlineConfigurationSchema.parse(legacy)).toEqual(legacy);
  for (const category of [null, { id, name: 'Original' }]) {
    const current = { ...legacy, schemaVersion: 2, items: [{ ...item, category }] };
    expect(offlineConfigurationSchema.parse(current)).toEqual(current);
    expect(offlineConfigurationSchema.safeParse({ ...legacy, items: [{ ...item, category }] }).success).toBe(false);
  }
  expect(offlineConfigurationSchema.safeParse({ ...legacy, schemaVersion: 2 }).success).toBe(false);
  expect(offlineConfigurationSchema.safeParse({ ...legacy, schemaVersion: 3 }).success).toBe(false);
});
