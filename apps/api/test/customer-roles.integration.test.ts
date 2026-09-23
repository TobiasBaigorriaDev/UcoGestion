import { randomUUID } from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runMigrations } from '../src/database/migrate.js';
import { TenantTransaction } from '../src/database/tenant-transaction.js';
import { CustomerManagementService } from '../src/modules/customers/customer-management.service.js';

describe('customer role permissions (T084 / RF-212, RF-213)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let runtimePool: Pool;
  let service: CustomerManagementService;
  let organizationId: string;
  let ownerUserId: string;
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

    organizationId = randomUUID();
    ownerUserId = randomUUID();
    cashierUserId = randomUUID();
    employeeUserId = randomUUID();

    await pool.query(
      `INSERT INTO users (id, email_normalized, password_hash, password_hash_version) VALUES
       ($1, 'cust-role-owner@example.com', '$argon2id$v=19$owner', 1),
       ($2, 'cust-role-cashier@example.com', '$argon2id$v=19$cashier', 1),
       ($3, 'cust-role-employee@example.com', '$argon2id$v=19$employee', 1)`,
      [ownerUserId, cashierUserId, employeeUserId],
    );

    await pool.query(
      `INSERT INTO organizations (id, name, base_currency, timezone) VALUES
       ($1, 'Role Customers Org', 'ARS', 'America/Argentina/Mendoza')`,
      [organizationId],
    );

    await pool.query(
      `INSERT INTO memberships (id, organization_id, user_id, role) VALUES
       ($1, $2, $3, 'OWNER'),
       ($4, $5, $6, 'CASHIER'),
       ($7, $8, $9, 'EMPLOYEE')`,
      [
        randomUUID(), organizationId, ownerUserId,
        randomUUID(), organizationId, cashierUserId,
        randomUUID(), organizationId, employeeUserId,
      ],
    );
  });

  afterAll(async () => {
    await runtimePool?.end();
    await pool?.end();
    await container?.stop();
  });

  it('allows CASHIER to edit allowed customer fields (RF-212)', async () => {
    const ownerContext = {
      organizationId,
      requestId: randomUUID(),
      userId: ownerUserId,
    };
    const cashierContext = {
      organizationId,
      requestId: randomUUID(),
      userId: cashierUserId,
    };

    const created = await service.create(ownerContext, {
      name: 'Cliente Base',
      contact: 'antiguo@test.com',
    });

    const updated = await service.update(cashierContext, created.id, created.version, {
      name: 'Cliente Actualizado por Cajero',
      contact: 'nuevo@test.com',
      taxId: '20-98765432-1',
      address: 'Calle Falsa 123',
      notes: 'Nota del cajero',
    });

    expect(updated.name).toBe('Cliente Actualizado por Cajero');
    expect(updated.contact).toBe('nuevo@test.com');
    expect(updated.taxId).toBe('20-98765432-1');
    expect(updated.address).toBe('Calle Falsa 123');
    expect(updated.notes).toBe('Nota del cajero');
  });

  it('denies CASHIER from changing customer status (RF-212)', async () => {
    const ownerContext = {
      organizationId,
      requestId: randomUUID(),
      userId: ownerUserId,
    };
    const cashierContext = {
      organizationId,
      requestId: randomUUID(),
      userId: cashierUserId,
    };

    const created = await service.create(ownerContext, {
      name: 'Cliente Para Test Estado',
    });

    await expect(
      service.changeStatus(cashierContext, created.id, created.version, 'INACTIVE'),
    ).rejects.toMatchObject({
      code: 'CUSTOMER_STATUS_CHANGE_FORBIDDEN',
    });
  });

  it('denies CASHIER from deleting customer (RF-212)', async () => {
    const ownerContext = {
      organizationId,
      requestId: randomUUID(),
      userId: ownerUserId,
    };
    const cashierContext = {
      organizationId,
      requestId: randomUUID(),
      userId: cashierUserId,
    };

    const created = await service.create(ownerContext, {
      name: 'Cliente Para Test Borrado',
    });

    await expect(
      service.deletePhysically(cashierContext, created.id, created.version),
    ).rejects.toMatchObject({
      code: 'CUSTOMER_ACCESS_FORBIDDEN',
    });
  });

  it('denies EMPLOYEE from all customer operations (RF-213)', async () => {
    const ownerContext = {
      organizationId,
      requestId: randomUUID(),
      userId: ownerUserId,
    };
    const employeeContext = {
      organizationId,
      requestId: randomUUID(),
      userId: employeeUserId,
    };

    const created = await service.create(ownerContext, {
      name: 'Cliente Inaccesible para Empleado',
    });

    // Read by id denied
    await expect(service.findById(employeeContext, created.id)).rejects.toMatchObject({
      code: 'CUSTOMER_ACCESS_FORBIDDEN',
    });

    // List denied
    await expect(service.list(employeeContext)).rejects.toMatchObject({
      code: 'CUSTOMER_ACCESS_FORBIDDEN',
    });

    // Create denied
    await expect(
      service.create(employeeContext, { name: 'Intento Empleado' }),
    ).rejects.toMatchObject({
      code: 'CUSTOMER_ACCESS_FORBIDDEN',
    });

    // Update denied
    await expect(
      service.update(employeeContext, created.id, created.version, { name: 'Modificado' }),
    ).rejects.toMatchObject({
      code: 'CUSTOMER_ACCESS_FORBIDDEN',
    });

    // Status change denied
    await expect(
      service.changeStatus(employeeContext, created.id, created.version, 'INACTIVE'),
    ).rejects.toMatchObject({
      code: 'CUSTOMER_STATUS_CHANGE_FORBIDDEN',
    });

    // Delete denied
    await expect(
      service.deletePhysically(employeeContext, created.id, created.version),
    ).rejects.toMatchObject({
      code: 'CUSTOMER_ACCESS_FORBIDDEN',
    });
  });
});
