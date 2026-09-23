import { randomUUID } from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runMigrations } from '../src/database/migrate.js';
import { TenantTransaction } from '../src/database/tenant-transaction.js';
import {
  CustomerManagementError,
  CustomerManagementService,
} from '../src/modules/customers/customer-management.service.js';

describe('customer creation (T082 / RF-68, RF-69, RF-265)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let runtimePool: Pool;
  let service: CustomerManagementService;
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
    service = new CustomerManagementService(new TenantTransaction(runtimePool));

    organizationA = randomUUID();
    organizationB = randomUUID();
    ownerUserId = randomUUID();
    adminUserId = randomUUID();
    cashierUserId = randomUUID();
    employeeUserId = randomUUID();

    await pool.query(
      `INSERT INTO users (id, email_normalized, password_hash, password_hash_version) VALUES
       ($1, 'cust-owner@example.com', '$argon2id$v=19$owner', 1),
       ($2, 'cust-admin@example.com', '$argon2id$v=19$admin', 1),
       ($3, 'cust-cashier@example.com', '$argon2id$v=19$cashier', 1),
       ($4, 'cust-employee@example.com', '$argon2id$v=19$employee', 1)`,
      [ownerUserId, adminUserId, cashierUserId, employeeUserId],
    );

    await pool.query(
      `INSERT INTO organizations (id, name, base_currency, timezone) VALUES
       ($1, 'Org Customers A', 'ARS', 'America/Argentina/Mendoza'),
       ($2, 'Org Customers B', 'ARS', 'America/Argentina/Mendoza')`,
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

  it('creates customer with only name (RF-68)', async () => {
    const context = {
      organizationId: organizationA,
      requestId: randomUUID(),
      userId: ownerUserId,
    };

    const customer = await service.create(context, {
      name: 'Consumidor Anónimo',
    });

    expect(customer.id).toBeDefined();
    expect(customer.name).toBe('Consumidor Anónimo');
    expect(customer.taxId).toBeNull();
    expect(customer.status).toBe('ACTIVE');
    expect(customer.version).toBe(1);

    const check = await pool.query(
      `SELECT name, tax_id, tax_id_norm, status FROM customers WHERE id = $1`,
      [customer.id],
    );
    expect(check.rows[0].name).toBe('Consumidor Anónimo');
    expect(check.rows[0].tax_id).toBeNull();
    expect(check.rows[0].tax_id_norm).toBeNull();
    expect(check.rows[0].status).toBe('ACTIVE');
  });

  it('creates customer with name and normalized tax ID (RF-69, RF-265)', async () => {
    const context = {
      organizationId: organizationA,
      requestId: randomUUID(),
      userId: adminUserId,
    };

    const customer = await service.create(context, {
      name: 'Acme Corp',
      taxId: ' 20-30405060-7 ',
      contact: 'contacto@acme.com',
      address: 'Av. Siempre Viva 742',
      notes: 'Cliente preferencial',
    });

    expect(customer.name).toBe('Acme Corp');
    expect(customer.taxId).toBe('20-30405060-7');
    expect(customer.contact).toBe('contacto@acme.com');
    expect(customer.address).toBe('Av. Siempre Viva 742');
    expect(customer.notes).toBe('Cliente preferencial');
    expect(customer.status).toBe('ACTIVE');

    const check = await pool.query(
      `SELECT tax_id_norm FROM customers WHERE id = $1`,
      [customer.id],
    );
    expect(check.rows[0].tax_id_norm).toBe('20-30405060-7');
  });

  it('rejects customer creation with empty or whitespace name (RF-68)', async () => {
    const context = {
      organizationId: organizationA,
      requestId: randomUUID(),
      userId: ownerUserId,
    };

    await expect(service.create(context, { name: '   ' })).rejects.toThrow(
      CustomerManagementError,
    );
  });

  it('rejects duplicate tax ID in same organization even with whitespace differences (RF-69, RF-265)', async () => {
    const context = {
      organizationId: organizationA,
      requestId: randomUUID(),
      userId: ownerUserId,
    };

    await service.create(context, {
      name: 'Empresa Uno',
      taxId: '30-11223344-5',
    });

    await expect(
      service.create(context, {
        name: 'Empresa Dos',
        taxId: ' 30-11223344-5 ',
      }),
    ).rejects.toThrow(CustomerManagementError);
  });

  it('rejects duplicate tax ID when existing customer is INACTIVE (RF-265)', async () => {
    const context = {
      organizationId: organizationA,
      requestId: randomUUID(),
      userId: ownerUserId,
    };

    const inactiveCust = await service.create(context, {
      name: 'Empresa Inactiva',
      taxId: '30-99887766-5',
    });

    await pool.query(
      `UPDATE customers SET status = 'INACTIVE' WHERE id = $1`,
      [inactiveCust.id],
    );

    await expect(
      service.create(context, {
        name: 'Empresa Nueva Intentando Reusar TaxID',
        taxId: '30-99887766-5',
      }),
    ).rejects.toThrow(CustomerManagementError);
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

    const custA = await service.create(contextA, {
      name: 'Tenant A Customer',
      taxId: '20-77777777-1',
    });
    const custB = await service.create(contextB, {
      name: 'Tenant B Customer',
      taxId: '20-77777777-1',
    });

    expect(custA.id).toBeDefined();
    expect(custB.id).toBeDefined();
    expect(custA.id).not.toBe(custB.id);
  });

  it('allows CASHIER to create customer (RF-212)', async () => {
    const context = {
      organizationId: organizationA,
      requestId: randomUUID(),
      userId: cashierUserId,
    };

    const customer = await service.create(context, {
      name: 'Cliente Creado por Cajero',
      contact: 'cajero@test.com',
    });

    expect(customer.name).toBe('Cliente Creado por Cajero');
    expect(customer.status).toBe('ACTIVE');
  });

  it('denies EMPLOYEE from creating customer (RF-213)', async () => {
    const context = {
      organizationId: organizationA,
      requestId: randomUUID(),
      userId: employeeUserId,
    };

    await expect(
      service.create(context, {
        name: 'Cliente Bloqueado para Empleado',
      }),
    ).rejects.toThrow(CustomerManagementError);
  });
});
