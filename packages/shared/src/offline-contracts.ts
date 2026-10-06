import { z } from 'zod';

const counter = z.string().regex(/^(?:0|[1-9]\d*)$/);
const positiveCounter = z.string().regex(/^[1-9]\d*$/);
const namedResource = z.strictObject({ id: z.uuid(), name: z.string().min(1) });
export const signedOfflineDocumentSchema = z.strictObject({ payload: z.string(), signature: z.string(), signingKeyId: z.string().min(1) });
export const offlineConfigurationSchema = z.strictObject({
  currency: z.string().regex(/^[A-Z]{3}$/),
  items: z.array(z.strictObject({ id: z.uuid(), name: z.string().min(1), sku: z.string().nullable(), barcode: z.string().nullable(),
    type: z.enum(['PRODUCT', 'SERVICE']), baseUnit: z.enum(['UNIT', 'FRACTIONAL']), trackInventory: z.boolean(),
    price: z.string().regex(/^(?:0|[1-9]\d{0,17})\.\d{2}$/).nullable(), priceVersion: z.number().int().nonnegative() })),
  categories: z.array(namedResource), branches: z.array(namedResource),
  cashRegisters: z.array(namedResource.extend({ branchId: z.uuid() })),
  paymentMethods: z.array(z.enum(['CASH', 'DEBIT_CARD', 'CREDIT_CARD', 'TRANSFER', 'QR'])),
});
export const offlineBootstrapPayloadSchema = z.strictObject({
  version: z.literal(1), organizationId: z.uuid(), actorUserId: z.uuid(), deviceId: z.uuid(), branchId: z.uuid(),
  grantId: z.uuid(), epoch: positiveCounter, configurationVersion: positiveCounter,
  configuration: offlineConfigurationSchema,
  stock: z.array(z.strictObject({ itemId: z.uuid(), quantity: z.string().regex(/^-?(?:0|[1-9]\d{0,16})\.\d{3}$/) })),
  timezone: z.string().min(1), role: z.enum(['OWNER', 'ADMIN', 'CASHIER']),
  permissions: z.strictObject({ canDiscount: z.boolean() }), serverTime: z.iso.datetime(),
  ingestionKey: signedOfflineDocumentSchema,
  ackKey: z.strictObject({ keyId: z.string().min(1), algorithm: z.literal('ES256'), publicKeyPem: z.string().min(1) }),
});
export type OfflineBootstrapPayload = z.infer<typeof offlineBootstrapPayloadSchema>;

export const offlineGrantProofSchema = z.strictObject({
  grantId: z.uuid(), bootstrapHash: z.string().regex(/^[0-9a-f]{64}$/), deviceSequence: counter,
  headHash: z.string().regex(/^[0-9a-f]{64}$/).nullable(), proof: z.string().min(1).max(200),
});
export type OfflineGrantProof = z.infer<typeof offlineGrantProofSchema>;
export function offlineGrantProofPayload(input: Omit<OfflineGrantProof, 'proof'>): string {
  return JSON.stringify({ domain: 'UcoNext:grant-sync:v1', grantId: input.grantId,
    bootstrapHash: input.bootstrapHash, deviceSequence: input.deviceSequence, headHash: input.headHash });
}

export const offlineGrantClaimsSchema = z.strictObject({
  version: z.literal(1), grantId: z.uuid(), organizationId: z.uuid(), actorUserId: z.uuid(), deviceId: z.uuid(),
  branchId: z.uuid(), epoch: positiveCounter, configurationVersion: positiveCounter,
  cashRegisterIds: z.array(z.uuid()), role: z.enum(['OWNER', 'ADMIN', 'CASHIER']),
  permissions: z.strictObject({ canDiscount: z.boolean() }), thumbprint: z.string().min(1), bootstrapHash: z.string().regex(/^[0-9a-f]{64}$/),
  iat: z.number().int().nonnegative(), exp: z.number().int().nonnegative(),
}).refine(value => value.exp > value.iat && value.exp - value.iat <= 72 * 60 * 60, { message: 'Invalid grant lifetime.' });
export type OfflineGrantClaims = z.infer<typeof offlineGrantClaimsSchema>;
