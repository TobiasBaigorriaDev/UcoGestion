import { sql } from 'drizzle-orm';
import { integer, jsonb, pgTable, primaryKey, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

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
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
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
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('branches_organization_id_id_key').on(table.organizationId, table.id)],
);

export const cashRegisters = pgTable('cash_registers', {
  id: uuid().primaryKey(),
  organizationId: uuid('organization_id').notNull(),
  branchId: uuid('branch_id').notNull(),
  name: text().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

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
    branchId: uuid('branch_id').notNull(),
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
