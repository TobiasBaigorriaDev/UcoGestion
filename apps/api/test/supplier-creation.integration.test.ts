import { randomUUID } from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runMigrations } from '../src/database/migrate.js';
import { TenantTransaction } from '../src/database/tenant-transaction.js';
import {
  SupplierManagementError,
  SupplierManagementService,
} from '../src/modules/suppliers/supplier-management.service.js';

describe('supplier creation (T085 / RF-70, RF-71, RF-265)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let runtimePool: Pool;
  let service: SupplierManagementService;
  let organizationA: string;
  let organizationB: string;
  let ownerUserId: string;
  let adminUserId: string;
  let cashierUserId: string;
  let employeeUserId: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    await runMigrations(container.getConnectionUri());
    pool = new Pool({ connectionString: container.getConnectionUri() });
    await pool.query("CREATE ROLE uco_runtime LOGIN PASSWORD 'runtime-password' IN ROLE uco_app");
    const runtimeUrl = new URL(container.getConnectionUri());
    runtimeUrl.username = 'uco_runtime';
    runtimeUrl.password = 'runtime-password';
    runtimePool = new Pool({ connectionString: runtimeUrl.toString() });
    service = new SupplierManagementService(new TenantTransaction(runtimePool));

    organizationA = randomUUID();
    organizationB = randomUUID();
    ownerUserId = randomUUID();
    adminUserId = randomUUID();
    cashierUserId = randomUUID();
    employeeUserId = randomUUID();

    await pool.query(
      `INSERT INTO users (id, email_normalized, password_hash, password_hash_version) VALUES
       ($1, 'supp-owner@example.com', '$argon2id$v=19$owner', 1),
       ($2, 'supp-admin@example.com', '$argon2id$v=19$admin', 1),
       ($3, 'supp-cashier@example.com', '$argon2id$v=19$cashier', 1),
       ($4, 'supp-employee@example.com', '$argon2id$v=19$employee', 1)`,
      [ownerUserId, adminUserId, cashierUserId, employeeUserId],
    );

    await pool.query(
      `INSERT INTO organizations (id, name, base_currency, timezone) VALUES
       ($1, 'Org Suppliers A', 'ARS', 'America/Argentina/Mendoza'),
       ($2, 'Org Suppliers B', 'ARS', 'America/Argentina/Mendoza')`,
      [organizationA, organizationB],
    );

    await pool.query(
      `INSERT INTO memberships (id, organization_id, user_id, role) VALUES
       ($1, $2, $3, 'OWNER'),
       ($4, $5, $6, 'ADMIN'),
       ($7, $8, $9, 'CASHIER'),
       ($10, $11, $12, 'EMPLOYEE'),
       ($13, $14, $15, 'OWNER')`,
      [
        randomUUID(), organizationA, ownerUserId,
        randomUUID(), organizationA, adminUserId,
        randomUUID(), organizationA, cashierUserId,
        randomUUID(), organizationA, employeeUserId,
        randomUUID(), organizationB, ownerUserId,
      ],
    );
  });

  afterAll(async () => {
    await runtimePool?.end();
    await pool?.end();
    await container?.stop();
  });

  it('creates supplier with only name (RF-70)', async () => {
    const context = {
      organizationId: organizationA,
      requestId: randomUUID(),
      userId: ownerUserId,
    };

    const supplier = await service.create(context, {
      name: 'Distribuidora Central',
    });

    expect(supplier.id).toBeDefined();
    expect(supplier.name).toBe('Distribuidora Central');
    expect(supplier.taxId).toBeNull();
    expect(supplier.status).toBe('ACTIVE');
    expect(supplier.version).toBe(1);

    const check = await pool.query(
      `SELECT name, tax_id, tax_id_norm, status FROM suppliers WHERE id = $1`,
      [supplier.id],
    );
    expect(check.rows[0].name).toBe('Distribuidora Central');
    expect(check.rows[0].tax_id).toBeNull();
    expect(check.rows[0].tax_id_norm).toBeNull();
    expect(check.rows[0].status).toBe('ACTIVE');
  });

  it('replays an identical create without duplicating the supplier or audit event', async () => {
    const context = { organizationId: organizationA, requestId: randomUUID(), userId: ownerUserId };
    const key = randomUUID();
    const first = await service.create(context, { name: 'Proveedor idempotente' }, key);
    const replay = await service.create(context, { name: 'Proveedor idempotente' }, key);
    expect(replay).toEqual(first);
    const suppliers = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM suppliers WHERE organization_id = $1 AND name = $2',
      [organizationA, 'Proveedor idempotente'],
    );
    expect(suppliers.rows[0]?.count).toBe('1');
    const audit = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM audit_events WHERE organization_id = $1 AND entity_id = $2 AND action = 'supplier.created'",
      [organizationA, first.id],
    );
    expect(audit.rows[0]?.count).toBe('1');
    await expect(service.create(context, { name: 'Otro proveedor' }, key)).rejects.toMatchObject({
      code: 'IDEMPOTENCY_KEY_REUSED',
    });
  });

  it('creates supplier with name and normalized tax ID (RF-71, RF-265)', async () => {
    const context = {
      organizationId: organizationA,
      requestId: randomUUID(),
      userId: adminUserId,
    };

    const supplier = await service.create(context, {
      name: 'Proveedor Mayorista S.A.',
      taxId: ' 30-55667788-9 ',
      contact: 'ventas@mayorista.com',
      address: 'Parque Industrial Lote 5',
      notes: 'Plazo 30 días',
    });

    expect(supplier.name).toBe('Proveedor Mayorista S.A.');
    expect(supplier.taxId).toBe('30-55667788-9');
    expect(supplier.contact).toBe('ventas@mayorista.com');
    expect(supplier.address).toBe('Parque Industrial Lote 5');
    expect(supplier.notes).toBe('Plazo 30 días');
    expect(supplier.status).toBe('ACTIVE');

    const check = await pool.query(
      `SELECT tax_id_norm FROM suppliers WHERE id = $1`,
      [supplier.id],
    );
    expect(check.rows[0].tax_id_norm).toBe('30-55667788-9');
    const audit = await pool.query<{ after_data: Record<string, unknown> }>(
      "SELECT after_data FROM audit_events WHERE entity_id = $1 AND action = 'supplier.created'",
      [supplier.id],
    );
    expect(JSON.stringify(audit.rows[0]?.after_data)).not.toContain('30-55667788-9');
    expect(JSON.stringify(audit.rows[0]?.after_data)).not.toContain('ventas@mayorista.com');
    expect(JSON.stringify(audit.rows[0]?.after_data)).not.toContain('Parque Industrial');
  });

  it('rejects supplier creation with empty or whitespace name (RF-70)', async () => {
    const context = {
      organizationId: organizationA,
      requestId: randomUUID(),
      userId: ownerUserId,
    };

    await expect(service.create(context, { name: '   ' })).rejects.toThrow(
      SupplierManagementError,
    );
  });

  it('rejects duplicate tax ID in same organization (RF-71, RF-265)', async () => {
    const context = {
      organizationId: organizationA,
      requestId: randomUUID(),
      userId: ownerUserId,
    };

    await service.create(context, {
      name: 'Proveedor Uno',
      taxId: '30-44445555-6',
    });

    await expect(
      service.create(context, {
        name: 'Proveedor Dos',
        taxId: ' 30-44445555-6 ',
      }),
    ).rejects.toThrow(SupplierManagementError);
  });

  it('rejects duplicate tax ID when existing supplier is INACTIVE (RF-265)', async () => {
    const context = {
      organizationId: organizationA,
      requestId: randomUUID(),
      userId: ownerUserId,
    };

    const inactiveSupp = await service.create(context, {
      name: 'Proveedor Inactivo',
      taxId: '30-88889999-0',
    });

    await pool.query(
      `UPDATE suppliers SET status = 'INACTIVE' WHERE id = $1`,
      [inactiveSupp.id],
    );

    await expect(
      service.create(context, {
        name: 'Proveedor Nuevo Reusando TaxId',
        taxId: '30-88889999-0',
      }),
    ).rejects.toThrow(SupplierManagementError);
  });

  it('permits same tax ID in different organization (tenant isolation)', async () => {
    const contextA = {
      organizationId: organizationA,
      requestId: randomUUID(),
      userId: ownerUserId,
    };
    const contextB = {
      organizationId: organizationB,
      requestId: randomUUID(),
      userId: ownerUserId,
    };

    const suppA = await service.create(contextA, {
      name: 'Tenant A Supplier',
      taxId: '30-12341234-5',
    });
    const suppB = await service.create(contextB, {
      name: 'Tenant B Supplier',
      taxId: '30-12341234-5',
    });

    expect(suppA.id).toBeDefined();
    expect(suppB.id).toBeDefined();
    expect(suppA.id).not.toBe(suppB.id);
    await expect(service.findById(contextB, suppA.id)).rejects.toMatchObject({
      code: 'SUPPLIER_NOT_FOUND',
    });
    const crossTenantRows = await new TenantTransaction(runtimePool).read(contextB, async (client) =>
      client.query<{ id: string }>('SELECT id FROM suppliers WHERE id = $1', [suppA.id]));
    expect(crossTenantRows.rows).toEqual([]);
  });

  it('denies CASHIER from creating supplier (RF-217)', async () => {
    const context = {
      organizationId: organizationA,
      requestId: randomUUID(),
      userId: cashierUserId,
    };

    await expect(
      service.create(context, {
        name: 'Proveedor Intento Cajero',
      }),
    ).rejects.toMatchObject({
      code: 'SUPPLIER_ACCESS_FORBIDDEN',
    });
  });

  it('denies EMPLOYEE from creating supplier (RF-216)', async () => {
    const context = {
      organizationId: organizationA,
      requestId: randomUUID(),
      userId: employeeUserId,
    };

    await expect(
      service.create(context, {
        name: 'Proveedor Intento Empleado',
      }),
    ).rejects.toMatchObject({
      code: 'SUPPLIER_ACCESS_FORBIDDEN',
    });
  });
});
