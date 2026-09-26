import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  foreignKey,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const schemaMigrationsProbe = pgTable('schema_migrations_probe', {
  id: integer().primaryKey(),
  version: integer().notNull().default(1),
});

export const users = pgTable(
  'users',
  {
    id: uuid().primaryKey(),
    emailNormalized: text('email_normalized').notNull(),
    passwordHash: text('password_hash').notNull(),
    passwordHashVersion: integer('password_hash_version').notNull(),
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('users_email_normalized_key').on(table.emailNormalized)],
);

export const authSessions = pgTable(
  'auth_sessions',
  {
    id: uuid().primaryKey(),
    userId: uuid('user_id').notNull().references(() => users.id),
    tokenHash: text('token_hash').notNull(),
    csrfToken: text('csrf_token'),
    idleExpiresAt: timestamp('idle_expires_at', { withTimezone: true }).notNull(),
    absoluteExpiresAt: timestamp('absolute_expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('auth_sessions_token_hash_key').on(table.tokenHash)],
);

export const securityRateLimits = pgTable('security_rate_limits', {
  scope: text().notNull(),
  identityHash: text('identity_hash').notNull(),
  ipHash: text('ip_hash').notNull(),
  windowStartedAt: timestamp('window_started_at', { withTimezone: true }).notNull(),
  attempts: integer().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const passwordResetTokens = pgTable(
  'password_reset_tokens',
  {
    id: uuid().primaryKey(),
    userId: uuid('user_id').notNull().references(() => users.id),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('password_reset_tokens_token_hash_key').on(table.tokenHash)],
);

export const identityOutboxJobs = pgTable(
  'identity_outbox_jobs',
  {
    id: uuid().primaryKey(),
    jobKey: text('job_key').notNull(),
    jobType: text('job_type').notNull(),
    payload: jsonb().notNull(),
    status: text().notNull().default('PENDING'),
    attemptCount: integer('attempt_count').notNull().default(0),
    availableAt: timestamp('available_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [unique('identity_outbox_jobs_job_key_key').on(table.jobKey)],
);

export const organizations = pgTable('organizations', {
  id: uuid().primaryKey(),
  name: text().notNull().default('Organización'),
  countryCode: text('country_code').notNull().default('AR'),
  baseCurrency: text('base_currency').notNull(),
  timezone: text().notNull(),
  status: text().notNull().default('ACTIVE'),
  profile: jsonb().notNull().default({}),
  version: integer().notNull().default(1),
  operationalHistoryStartedAt: timestamp('operational_history_started_at', { withTimezone: true }),
  currencyPermanentlyLockedAt: timestamp('currency_permanently_locked_at', { withTimezone: true }),
  currencyLockDeclarationId: uuid('currency_lock_declaration_id'),
  configEpoch: bigint('config_epoch', { mode: 'number' }).notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const organizationHistoryReferences = pgTable(
  'organization_history_references',
  {
    id: uuid().notNull(),
    organizationId: uuid('organization_id').notNull().references(() => organizations.id),
    referenceDomain: text('reference_domain').notNull(),
    referenceType: text('reference_type').notNull(),
    sourceId: uuid('source_id').notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.id] }),
    unique('organization_history_references_source_key')
      .on(table.organizationId, table.referenceDomain, table.referenceType, table.sourceId),
  ],
);

export const memberships = pgTable(
  'memberships',
  {
    id: uuid().primaryKey(),
    organizationId: uuid('organization_id').notNull().references(() => organizations.id),
    userId: uuid('user_id').notNull().references(() => users.id),
    role: text().notNull(),
    status: text().notNull().default('ACTIVE'),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    deactivatedAt: timestamp('deactivated_at', { withTimezone: true }),
    version: bigint({ mode: 'number' }).notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('memberships_organization_id_id_key').on(table.organizationId, table.id),
    uniqueIndex('memberships_active_organization_user_key')
      .on(table.organizationId, table.userId)
      .where(sql`${table.revokedAt} IS NULL`),
  ],
);

export const branches = pgTable(
  'branches',
  {
    id: uuid().primaryKey(),
    organizationId: uuid('organization_id').notNull().references(() => organizations.id),
    name: text().notNull(),
    nameNormalized: text('name_norm').notNull(),
    status: text().notNull().default('ACTIVE'),
    version: bigint({ mode: 'number' }).notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('branches_organization_id_id_key').on(table.organizationId, table.id)],
);

export const membershipBranches = pgTable(
  'membership_branches',
  {
    organizationId: uuid('organization_id').notNull(),
    membershipId: uuid('membership_id').notNull(),
    branchId: uuid('branch_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.membershipId, table.branchId] }),
    foreignKey({
      columns: [table.organizationId, table.membershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
      name: 'membership_branches_membership_tenant_fk',
    }),
    foreignKey({
      columns: [table.organizationId, table.branchId],
      foreignColumns: [branches.organizationId, branches.id],
      name: 'membership_branches_branch_tenant_fk',
    }),
  ],
);

export const invitations = pgTable(
  'invitations',
  {
    id: uuid().primaryKey(),
    organizationId: uuid('organization_id').notNull().references(() => organizations.id),
    emailNormalized: text('email_normalized').notNull(),
    role: text().notNull(),
    status: text().notNull().default('PENDING'),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    invitedByMembershipId: uuid('invited_by_membership_id').notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('invitations_organization_id_id_key').on(table.organizationId, table.id),
    unique('invitations_token_hash_key').on(table.tokenHash),
    foreignKey({
      columns: [table.organizationId, table.invitedByMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
      name: 'invitations_inviter_tenant_fk',
    }),
  ],
);

export const invitationBranches = pgTable(
  'invitation_branches',
  {
    organizationId: uuid('organization_id').notNull(),
    invitationId: uuid('invitation_id').notNull(),
    branchId: uuid('branch_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.invitationId, table.branchId] }),
    foreignKey({
      columns: [table.organizationId, table.invitationId],
      foreignColumns: [invitations.organizationId, invitations.id],
      name: 'invitation_branches_invitation_tenant_fk',
    }),
    foreignKey({
      columns: [table.organizationId, table.branchId],
      foreignColumns: [branches.organizationId, branches.id],
      name: 'invitation_branches_branch_tenant_fk',
    }),
  ],
);

export const membershipRevocationDeviceKnowledge = pgTable(
  'membership_revocation_device_knowledge',
  {
    organizationId: uuid('organization_id').notNull(),
    membershipId: uuid('membership_id').notNull(),
    deviceId: uuid('device_id').notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }).notNull(),
    knownAt: timestamp('known_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.membershipId, table.deviceId] }),
    foreignKey({
      columns: [table.organizationId, table.membershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
      name: 'membership_revocation_knowledge_membership_tenant_fk',
    }),
  ],
);

export const cashRegisters = pgTable('cash_registers', {
  id: uuid().primaryKey(),
  organizationId: uuid('organization_id').notNull(),
  branchId: uuid('branch_id').notNull(),
  name: text().notNull(),
  nameNormalized: text('name_norm').notNull(),
  status: text().notNull().default('ACTIVE'),
  version: bigint({ mode: 'number' }).notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [unique('cash_registers_organization_id_id_key').on(table.organizationId, table.id)]);

export const paymentMethodSettings = pgTable(
  'payment_method_settings',
  {
    organizationId: uuid('organization_id').notNull().references(() => organizations.id),
    method: text().notNull(),
    enabled: boolean().notNull().default(true),
    version: bigint({ mode: 'number' }).notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.organizationId, table.method] })],
);

export const catalogCategories = pgTable(
  'catalog_categories',
  {
    id: uuid().primaryKey(),
    organizationId: uuid('organization_id').notNull().references(() => organizations.id),
    name: text().notNull(),
    status: text().notNull().default('ACTIVE'),
    version: bigint({ mode: 'number' }).notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('catalog_categories_organization_id_id_key').on(table.organizationId, table.id)],
);

export const catalogItems = pgTable(
  'catalog_items',
  {
    id: uuid().primaryKey(),
    organizationId: uuid('organization_id').notNull().references(() => organizations.id),
    name: text().notNull(),
    type: text().notNull(),
    trackInventory: boolean('track_inventory').notNull().default(false),
    baseUnit: text('base_unit').notNull().default('UNIT'),
    sku: text(),
    skuNormalized: text('sku_norm'),
    barcode: text(),
    barcodeNormalized: text('barcode_norm'),
    price: numeric('price', { precision: 20, scale: 2 }),
    priceVersion: bigint('price_version', { mode: 'number' }).notNull().default(0),
    status: text().notNull().default('ACTIVE'),
    version: bigint({ mode: 'number' }).notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('catalog_items_organization_id_id_key').on(table.organizationId, table.id),
    uniqueIndex('catalog_items_organization_sku_norm_key')
      .on(table.organizationId, table.skuNormalized)
      .where(sql`${table.skuNormalized} IS NOT NULL`),
    uniqueIndex('catalog_items_organization_barcode_norm_key')
      .on(table.organizationId, table.barcodeNormalized)
      .where(sql`${table.barcodeNormalized} IS NOT NULL`),
  ],
);

export const branchStocks = pgTable(
  'branch_stocks',
  {
    organizationId: uuid('organization_id').notNull(),
    branchId: uuid('branch_id').notNull(),
    itemId: uuid('item_id').notNull(),
    quantity: numeric('quantity', { precision: 20, scale: 3 }).notNull().default('0'),
    version: bigint({ mode: 'number' }).notNull().default(1),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.branchId, table.itemId] }),
    foreignKey({ columns: [table.organizationId, table.branchId],
      foreignColumns: [branches.organizationId, branches.id], name: 'branch_stocks_branch_tenant_fk' }),
    foreignKey({ columns: [table.organizationId, table.itemId],
      foreignColumns: [catalogItems.organizationId, catalogItems.id], name: 'branch_stocks_item_tenant_fk' }),
  ],
);

export const inventoryAdjustments = pgTable(
  'inventory_adjustments',
  {
    id: uuid().primaryKey(),
    organizationId: uuid('organization_id').notNull(),
    branchId: uuid('branch_id').notNull(),
    itemId: uuid('item_id').notNull(),
    actorUserId: uuid('actor_user_id').notNull().references(() => users.id),
    direction: text().notNull(),
    quantity: numeric('quantity', { precision: 20, scale: 3 }).notNull(),
    reason: text().notNull(),
    observation: text(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('inventory_adjustments_tenant_identity').on(table.organizationId, table.id),
    foreignKey({ columns: [table.organizationId, table.branchId],
      foreignColumns: [branches.organizationId, branches.id], name: 'inventory_adjustments_branch_tenant_fk' }),
    foreignKey({ columns: [table.organizationId, table.itemId],
      foreignColumns: [catalogItems.organizationId, catalogItems.id], name: 'inventory_adjustments_item_tenant_fk' }),
  ],
);

export const inventoryAdjustmentCompensations = pgTable(
  'inventory_adjustment_compensations',
  {
    organizationId: uuid('organization_id').notNull(),
    originalAdjustmentId: uuid('original_adjustment_id').notNull(),
    compensationAdjustmentId: uuid('compensation_adjustment_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.originalAdjustmentId] }),
    unique('inventory_adjustment_compensations_organization_id_compensation_adjustment_id_key')
      .on(table.organizationId, table.compensationAdjustmentId),
    foreignKey({ columns: [table.organizationId, table.originalAdjustmentId],
      foreignColumns: [inventoryAdjustments.organizationId, inventoryAdjustments.id],
      name: 'inventory_compensation_original_fk' }),
    foreignKey({ columns: [table.organizationId, table.compensationAdjustmentId],
      foreignColumns: [inventoryAdjustments.organizationId, inventoryAdjustments.id],
      name: 'inventory_compensation_new_fk' }),
  ],
);

export const inventoryMovements = pgTable(
  'inventory_movements',
  {
    id: uuid().primaryKey(),
    organizationId: uuid('organization_id').notNull(),
    branchId: uuid('branch_id').notNull(),
    itemId: uuid('item_id').notNull(),
    actorUserId: uuid('actor_user_id').notNull().references(() => users.id),
    delta: numeric('delta', { precision: 20, scale: 3 }).notNull(),
    sourceType: text('source_type').notNull(),
    sourceId: uuid('source_id').notNull(),
    sourceLineId: uuid('source_line_id').notNull(),
    effectKind: text('effect_kind').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('inventory_movements_source_effect_key').on(table.organizationId, table.sourceType,
      table.sourceId, table.sourceLineId, table.effectKind),
    foreignKey({ columns: [table.organizationId, table.branchId, table.itemId],
      foreignColumns: [branchStocks.organizationId, branchStocks.branchId, branchStocks.itemId],
      name: 'inventory_movements_stock_tenant_fk' }),
  ],
);

export const catalogPriceVersions = pgTable(
  'catalog_price_versions',
  {
    id: uuid().primaryKey(),
    organizationId: uuid('organization_id').notNull(),
    itemId: uuid('item_id').notNull(),
    priceVersion: bigint('price_version', { mode: 'number' }).notNull(),
    price: numeric('price', { precision: 20, scale: 2 }).notNull(),
    currency: text().notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.organizationId, table.itemId],
      foreignColumns: [catalogItems.organizationId, catalogItems.id],
      name: 'catalog_price_versions_item_fk',
    }),
    unique('catalog_price_versions_item_version_key')
      .on(table.organizationId, table.itemId, table.priceVersion),
  ],
);

export const devices = pgTable('devices', {
  id: uuid().primaryKey(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id),
  status: text().notNull(),
  publicKey: text('public_key').notNull(),
  lastConfigVersion: bigint('last_config_version', { mode: 'number' }).notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [unique('devices_organization_id_id_key').on(table.organizationId, table.id)]);

export const configurationVersions = pgTable('configuration_versions', {
  id: uuid().primaryKey(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id),
  version: bigint({ mode: 'number' }).notNull(),
  snapshot: jsonb().notNull(),
  canonicalPayload: text('canonical_payload').notNull(),
  signature: text().notNull(),
  signingKeyId: text('signing_key_id').notNull(),
  publicKeyPem: text('public_key_pem').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [unique('configuration_versions_org_version_key').on(table.organizationId, table.version)]);

export const offlineGrants = pgTable('offline_grants', {
  id: uuid().primaryKey(),
  organizationId: uuid('organization_id').notNull(),
  deviceId: uuid('device_id').notNull(),
  epoch: bigint({ mode: 'number' }).notNull(),
  configurationVersion: bigint('configuration_version', { mode: 'number' }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  foreignKey({ columns: [table.organizationId, table.deviceId],
    foreignColumns: [devices.organizationId, devices.id], name: 'offline_grants_device_fk' }),
  foreignKey({ columns: [table.organizationId, table.configurationVersion],
    foreignColumns: [configurationVersions.organizationId, configurationVersions.version],
    name: 'offline_grants_configuration_fk' }),
  unique('offline_grants_organization_id_id_key').on(table.organizationId, table.id),
  unique('offline_grants_exposure_identity_key')
    .on(table.organizationId, table.id, table.deviceId, table.epoch, table.configurationVersion),
  unique('offline_grants_device_epoch_key')
    .on(table.organizationId, table.id, table.deviceId, table.epoch),
]);

export const configurationBarriers = pgTable('configuration_barriers', {
  id: uuid().primaryKey(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id),
  epoch: bigint({ mode: 'number' }).notNull(),
  status: text().notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
}, (table) => [unique('configuration_barriers_org_id_key').on(table.organizationId, table.id)]);

export const syncOperations = pgTable('sync_operations', {
  id: uuid().primaryKey(),
  organizationId: uuid('organization_id').notNull(),
  deviceId: uuid('device_id').notNull(),
  grantId: uuid('grant_id').notNull(),
  epoch: bigint({ mode: 'number' }).notNull(),
  sequence: bigint({ mode: 'number' }).notNull(),
  prevHash: text('prev_hash').notNull(),
  operationHash: text('operation_hash').notNull(),
  status: text().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  foreignKey({ columns: [table.organizationId, table.grantId, table.deviceId, table.epoch],
    foreignColumns: [offlineGrants.organizationId, offlineGrants.id, offlineGrants.deviceId, offlineGrants.epoch],
    name: 'sync_operations_grant_fk' }),
  unique('sync_operations_device_epoch_sequence_key')
    .on(table.organizationId, table.deviceId, table.epoch, table.sequence),
]);

export const configurationCheckpoints = pgTable('configuration_checkpoints', {
  id: uuid().primaryKey(),
  organizationId: uuid('organization_id').notNull(),
  barrierId: uuid('barrier_id').notNull(),
  grantId: uuid('grant_id').notNull(),
  deviceId: uuid('device_id').notNull(),
  epoch: bigint({ mode: 'number' }).notNull(),
  sequence: bigint({ mode: 'number' }).notNull(),
  headHash: text('head_hash').notNull(),
  canonicalPayload: text('canonical_payload').notNull(),
  signature: text().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  foreignKey({ columns: [table.organizationId, table.barrierId],
    foreignColumns: [configurationBarriers.organizationId, configurationBarriers.id],
    name: 'configuration_checkpoints_barrier_fk' }),
  foreignKey({ columns: [table.organizationId, table.grantId, table.deviceId, table.epoch],
    foreignColumns: [offlineGrants.organizationId, offlineGrants.id, offlineGrants.deviceId, offlineGrants.epoch],
    name: 'configuration_checkpoints_grant_fk' }),
]);

export const offlineConfigurationExposures = pgTable('offline_configuration_exposures', {
  id: uuid().primaryKey(),
  organizationId: uuid('organization_id').notNull(),
  deviceId: uuid('device_id').notNull(),
  grantId: uuid('grant_id').notNull(),
  epoch: bigint({ mode: 'number' }).notNull(),
  configurationVersion: bigint('configuration_version', { mode: 'number' }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  clearedAt: timestamp('cleared_at', { withTimezone: true }),
}, (table) => [
  foreignKey({
    columns: [table.organizationId, table.grantId, table.deviceId, table.epoch, table.configurationVersion],
    foreignColumns: [offlineGrants.organizationId, offlineGrants.id, offlineGrants.deviceId,
      offlineGrants.epoch, offlineGrants.configurationVersion],
    name: 'offline_configuration_exposures_grant_fk',
  }),
  unique('offline_configuration_exposures_org_id_key').on(table.organizationId, table.id),
  unique('offline_configuration_exposures_grant_key').on(table.organizationId, table.grantId),
]);

export const offlineExposureResources = pgTable('offline_exposure_resources', {
  id: uuid().primaryKey(),
  organizationId: uuid('organization_id').notNull(),
  exposureId: uuid('exposure_id').notNull(),
  catalogItemId: uuid('catalog_item_id'),
  catalogCategoryId: uuid('catalog_category_id'),
  branchId: uuid('branch_id'),
  cashRegisterId: uuid('cash_register_id'),
  paymentMethod: text('payment_method'),
}, (table) => [
  foreignKey({ columns: [table.organizationId, table.exposureId],
    foreignColumns: [offlineConfigurationExposures.organizationId, offlineConfigurationExposures.id],
    name: 'offline_exposure_resources_exposure_fk' }),
  foreignKey({ columns: [table.organizationId, table.catalogItemId],
    foreignColumns: [catalogItems.organizationId, catalogItems.id],
    name: 'offline_exposure_resources_catalog_item_fk' }),
  foreignKey({ columns: [table.organizationId, table.catalogCategoryId],
    foreignColumns: [catalogCategories.organizationId, catalogCategories.id],
    name: 'offline_exposure_resources_catalog_category_fk' }),
  foreignKey({ columns: [table.organizationId, table.branchId],
    foreignColumns: [branches.organizationId, branches.id],
    name: 'offline_exposure_resources_branch_fk' }),
  foreignKey({ columns: [table.organizationId, table.cashRegisterId],
    foreignColumns: [cashRegisters.organizationId, cashRegisters.id],
    name: 'offline_exposure_resources_cash_register_fk' }),
  foreignKey({ columns: [table.organizationId, table.paymentMethod],
    foreignColumns: [paymentMethodSettings.organizationId, paymentMethodSettings.method],
    name: 'offline_exposure_resources_payment_method_fk' }),
]);

export const resourceHistoryReferences = pgTable('resource_history_references', {
  id: uuid().primaryKey(),
  organizationId: uuid('organization_id').notNull(),
  catalogItemId: uuid('catalog_item_id'),
  catalogCategoryId: uuid('catalog_category_id'),
  branchId: uuid('branch_id'),
  cashRegisterId: uuid('cash_register_id'),
  paymentMethod: text('payment_method'),
  referenceType: text('reference_type').notNull(),
  sourceId: uuid('source_id').notNull(),
  recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  foreignKey({ columns: [table.organizationId, table.catalogItemId],
    foreignColumns: [catalogItems.organizationId, catalogItems.id],
    name: 'resource_history_references_catalog_item_fk' }),
  foreignKey({ columns: [table.organizationId, table.catalogCategoryId],
    foreignColumns: [catalogCategories.organizationId, catalogCategories.id],
    name: 'resource_history_references_catalog_category_fk' }),
  foreignKey({ columns: [table.organizationId, table.branchId],
    foreignColumns: [branches.organizationId, branches.id],
    name: 'resource_history_references_branch_fk' }),
  foreignKey({ columns: [table.organizationId, table.cashRegisterId],
    foreignColumns: [cashRegisters.organizationId, cashRegisters.id],
    name: 'resource_history_references_cash_register_fk' }),
  foreignKey({ columns: [table.organizationId, table.paymentMethod],
    foreignColumns: [paymentMethodSettings.organizationId, paymentMethodSettings.method],
    name: 'resource_history_references_payment_method_fk' }),
]);

export const unrecoverableDeviceDeclarations = pgTable('unrecoverable_device_declarations', {
  id: uuid().primaryKey(),
  organizationId: uuid('organization_id').notNull(),
  deviceId: uuid('device_id').notNull(),
  declaredBy: uuid('declared_by').notNull().references(() => users.id),
  requestId: text('request_id').notNull(),
  possibleUnknownHistory: boolean('possible_unknown_history').notNull(),
  declaredAt: timestamp('declared_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  foreignKey({ columns: [table.organizationId, table.deviceId],
    foreignColumns: [devices.organizationId, devices.id],
    name: 'unrecoverable_device_declarations_device_fk' }),
  unique('unrecoverable_device_declarations_org_id_key').on(table.organizationId, table.id),
  unique('unrecoverable_device_declarations_request_key')
    .on(table.organizationId, table.deviceId, table.requestId),
]);

export const catalogCategoryHistoryReferences = pgTable(
  'catalog_category_history_references',
  {
    id: uuid().notNull(),
    organizationId: uuid('organization_id').notNull(),
    categoryId: uuid('category_id').notNull(),
    referenceType: text('reference_type').notNull(),
    sourceId: uuid('source_id').notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.id] }),
    foreignKey({
      columns: [table.organizationId, table.categoryId],
      foreignColumns: [catalogCategories.organizationId, catalogCategories.id],
      name: 'catalog_category_history_references_category_tenant_fk',
    }),
    unique('catalog_category_history_references_source_key')
      .on(table.organizationId, table.categoryId, table.referenceType, table.sourceId),
  ],
);

export const expenseCategories = pgTable(
  'expense_categories',
  {
    id: uuid().primaryKey(),
    organizationId: uuid('organization_id').notNull().references(() => organizations.id),
    name: text().notNull(),
    status: text().notNull().default('ACTIVE'),
    version: bigint({ mode: 'number' }).notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('expense_categories_organization_id_id_key').on(table.organizationId, table.id)],
);

export const expenseCategoryHistoryReferences = pgTable(
  'expense_category_history_references',
  {
    id: uuid().notNull(),
    organizationId: uuid('organization_id').notNull(),
    categoryId: uuid('category_id').notNull(),
    referenceType: text('reference_type').notNull(),
    sourceId: uuid('source_id').notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.id] }),
    foreignKey({
      columns: [table.organizationId, table.categoryId],
      foreignColumns: [expenseCategories.organizationId, expenseCategories.id],
      name: 'expense_category_history_references_category_tenant_fk',
    }),
    unique('expense_category_history_references_source_key')
      .on(table.organizationId, table.categoryId, table.referenceType, table.sourceId),
  ],
);


export const idempotencyRecords = pgTable(
  'idempotency_records',
  {
    id: uuid().primaryKey(),
    organizationId: uuid('organization_id').notNull().references(() => organizations.id),
    scope: text().notNull(),
    key: text().notNull(),
    requestHash: text('request_hash').notNull(),
    status: text().notNull(),
    responseCode: integer('response_code'),
    responseBody: jsonb('response_body'),
    resourceId: uuid('resource_id'),
    actorUserId: uuid('actor_user_id').notNull(),
    branchId: uuid('branch_id'),
    authorizationClass: text('authorization_class').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [unique('idempotency_records_organization_scope_key_key').on(table.organizationId, table.scope, table.key)],
);

export const auditEvents = pgTable('audit_events', {
  id: uuid().primaryKey(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id),
  actorUserId: uuid('actor_user_id').notNull(),
  branchId: uuid('branch_id'),
  deviceId: uuid('device_id'),
  requestId: text('request_id').notNull(),
  operationId: text('operation_id').notNull(),
  entityType: text('entity_type').notNull(),
  entityId: uuid('entity_id').notNull(),
  action: text().notNull(),
  beforeData: jsonb('before_data').notNull().default({}),
  afterData: jsonb('after_data').notNull().default({}),
  contextData: jsonb('context_data').notNull().default({}),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
});

export const outboxJobs = pgTable(
  'outbox_jobs',
  {
    id: uuid().primaryKey(),
    organizationId: uuid('organization_id').notNull().references(() => organizations.id),
    jobKey: text('job_key').notNull(),
    jobType: text('job_type').notNull(),
    payload: jsonb().notNull(),
    actorUserId: uuid('actor_user_id').notNull(),
    branchId: uuid('branch_id'),
    authorizationClass: text('authorization_class').notNull(),
    status: text().notNull().default('PENDING'),
    attemptCount: integer('attempt_count').notNull().default(0),
    availableAt: timestamp('available_at', { withTimezone: true }).notNull().defaultNow(),
    leaseId: uuid('lease_id'),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    lastErrorCode: text('last_error_code'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [unique('outbox_jobs_organization_job_key_key').on(table.organizationId, table.jobKey)],
);

export const customers = pgTable(
  'customers',
  {
    id: uuid().primaryKey(),
    organizationId: uuid('organization_id').notNull().references(() => organizations.id),
    name: text().notNull(),
    taxId: text('tax_id'),
    taxIdNormalized: text('tax_id_norm'),
    contact: text(),
    address: text(),
    notes: text(),
    status: text().notNull().default('ACTIVE'),
    version: bigint({ mode: 'number' }).notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('customers_organization_id_id_key').on(table.organizationId, table.id),
    uniqueIndex('customers_organization_tax_id_norm_key')
      .on(table.organizationId, table.taxIdNormalized)
      .where(sql`${table.taxIdNormalized} IS NOT NULL`),
  ],
);

export const customerHistoryReferences = pgTable(
  'customer_history_references',
  {
    id: uuid().notNull(),
    organizationId: uuid('organization_id').notNull(),
    customerId: uuid('customer_id').notNull(),
    referenceType: text('reference_type').notNull(),
    sourceId: uuid('source_id').notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.id] }),
    foreignKey({
      columns: [table.organizationId, table.customerId],
      foreignColumns: [customers.organizationId, customers.id],
      name: 'customer_history_references_customer_tenant_fk',
    }),
    unique('customer_history_references_source_key').on(
      table.organizationId,
      table.customerId,
      table.referenceType,
      table.sourceId,
    ),
  ],
);

export const suppliers = pgTable(
  'suppliers',
  {
    id: uuid().primaryKey(),
    organizationId: uuid('organization_id').notNull().references(() => organizations.id),
    name: text().notNull(),
    taxId: text('tax_id'),
    taxIdNormalized: text('tax_id_norm'),
    contact: text(),
    address: text(),
    notes: text(),
    status: text().notNull().default('ACTIVE'),
    version: bigint({ mode: 'number' }).notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('suppliers_organization_id_id_key').on(table.organizationId, table.id),
    uniqueIndex('suppliers_organization_tax_id_norm_key')
      .on(table.organizationId, table.taxIdNormalized)
      .where(sql`${table.taxIdNormalized} IS NOT NULL`),
  ],
);

export const supplierHistoryReferences = pgTable(
  'supplier_history_references',
  {
    id: uuid().notNull(),
    organizationId: uuid('organization_id').notNull(),
    supplierId: uuid('supplier_id').notNull(),
    referenceType: text('reference_type').notNull(),
    sourceId: uuid('source_id').notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.id] }),
    foreignKey({
      columns: [table.organizationId, table.supplierId],
      foreignColumns: [suppliers.organizationId, suppliers.id],
      name: 'supplier_history_references_supplier_tenant_fk',
    }),
    unique('supplier_history_references_source_key').on(
      table.organizationId,
      table.supplierId,
      table.referenceType,
      table.sourceId,
    ),
  ],
);
