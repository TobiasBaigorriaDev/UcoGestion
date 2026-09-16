import { integer, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';

export const schemaMigrationsProbe = pgTable('schema_migrations_probe', {
  id: integer().primaryKey(),
  version: integer().notNull().default(1),
});

export const organizations = pgTable('organizations', {
  id: uuid().primaryKey(),
  baseCurrency: text('base_currency').notNull(),
  timezone: text().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const branches = pgTable(
  'branches',
  {
    id: uuid().primaryKey(),
    organizationId: uuid('organization_id').notNull().references(() => organizations.id),
    name: text().notNull(),
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
