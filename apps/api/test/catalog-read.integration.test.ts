import { randomUUID } from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runMigrations } from '../src/database/migrate.js';
import { TenantTransaction } from '../src/database/tenant-transaction.js';
import { CatalogReadService } from '../src/modules/catalog/catalog-read.service.js';

describe('catalog read permissions', () => {
  let container: StartedPostgreSqlContainer;
  let admin: Pool;
  let runtime: Pool;
  let reader: CatalogReadService;
  const organization = randomUUID();
  const otherOrganization = randomUUID();
  const branch = randomUUID();
  const otherBranch = randomUUID();
  const cashier = randomUUID();
  const employee = randomUUID();
  const outsider = randomUUID();
  const activeItem = randomUUID();
  const inactiveItem = randomUUID();

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    await runMigrations(container.getConnectionUri());
    admin = new Pool({ connectionString: container.getConnectionUri() });
    await admin.query("CREATE ROLE uco_catalog_reader LOGIN PASSWORD 'runtime-password' IN ROLE uco_app");
    const url = new URL(container.getConnectionUri()); url.username = 'uco_catalog_reader'; url.password = 'runtime-password';
    runtime = new Pool({ connectionString: url.toString() });
    reader = new CatalogReadService(new TenantTransaction(runtime));
    await admin.query("INSERT INTO organizations (id, name, base_currency, timezone) VALUES ($1, 'A', 'ARS', 'UTC'), ($2, 'B', 'ARS', 'UTC')", [organization, otherOrganization]);
    await admin.query("INSERT INTO branches (id, organization_id, name) VALUES ($1, $2, 'Principal'), ($3, $4, 'Ajena')", [branch, organization, otherBranch, otherOrganization]);
    await admin.query("INSERT INTO users (id, email_normalized, password_hash, password_hash_version) VALUES ($1, 'cashier@catalog.test', '$argon2id$v=19$cashier', 1), ($2, 'employee@catalog.test', '$argon2id$v=19$employee', 1), ($3, 'outsider@catalog.test', '$argon2id$v=19$outsider', 1)", [cashier, employee, outsider]);
    const cashierMembership = randomUUID(); const employeeMembership = randomUUID();
    await admin.query("INSERT INTO memberships (id, organization_id, user_id, role) VALUES ($1, $2, $3, 'CASHIER'), ($4, $2, $5, 'EMPLOYEE'), ($6, $7, $8, 'EMPLOYEE')", [cashierMembership, organization, cashier, employeeMembership, employee, randomUUID(), otherOrganization, outsider]);
    await admin.query('INSERT INTO membership_branches (organization_id, membership_id, branch_id) VALUES ($1, $2, $3), ($1, $4, $3)', [organization, cashierMembership, branch, employeeMembership]);
    await admin.query("INSERT INTO catalog_items (id, organization_id, name, type, status) VALUES ($1, $2, 'Yerba', 'PRODUCT', 'ACTIVE'), ($3, $2, 'Antiguo', 'PRODUCT', 'INACTIVE'), ($4, $5, 'Ajeno', 'PRODUCT', 'ACTIVE')", [activeItem, organization, inactiveItem, randomUUID(), otherOrganization]);
    await admin.query("INSERT INTO catalog_price_versions (id, organization_id, item_id, price_version, price, currency) VALUES ($1, $2, $3, 1, '123.45', 'ARS')", [randomUUID(), organization, activeItem]);
    await admin.query("UPDATE catalog_items SET price = '123.45', price_version = 1, version = 2 WHERE id = $1", [activeItem]);
    await admin.query("INSERT INTO catalog_categories (id, organization_id, name) VALUES ($1, $2, 'Almacén')", [randomUUID(), organization]);
  });

  afterAll(async () => { await runtime?.end(); await admin?.end(); await container?.stop(); });

  const context = (userId: string) => ({ organizationId: organization, userId, requestId: randomUUID() });

  it('returns only active items, prices and categories to CASHIER or EMPLOYEE, without cost or margin', async () => {
    for (const user of [cashier, employee]) {
      const result = await reader.read(context(user));
      expect(result.items.map((item) => item.id)).toEqual([activeItem]);
      expect(result.items[0]?.price).toBe('123.45');
      expect(result.categories.map((category) => category.name)).toEqual(['Almacén']);
      expect(JSON.stringify(result)).not.toMatch(/cost|margin/i);
    }
    await expect(reader.read(context(outsider))).rejects.toMatchObject({ status: 403 });
  });

  it('allows inactive item context only to EMPLOYEE in an assigned branch', async () => {
    const result = await reader.read(context(employee), { mode: 'HISTORICAL', branchId: branch });
    expect(result.items.map((item) => item.id)).toContain(inactiveItem);
    await expect(reader.read(context(employee), { mode: 'HISTORICAL', branchId: otherBranch })).rejects.toMatchObject({ status: 403 });
    await expect(reader.read(context(cashier), { mode: 'HISTORICAL', branchId: branch })).rejects.toMatchObject({ status: 403 });
  });
});
