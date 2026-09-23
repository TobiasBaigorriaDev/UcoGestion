import { randomUUID } from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runMigrations } from '../src/database/migrate.js';
import { TenantTransaction } from '../src/database/tenant-transaction.js';
import { SupplierManagementService } from '../src/modules/suppliers/supplier-management.service.js';

describe('supplier role permissions (T087 / RF-216, RF-217)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let runtimePool: Pool;
  let service: SupplierManagementService;
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
    service = new SupplierManagementService(new TenantTransaction(runtimePool));

    organizationId = randomUUID();
    ownerUserId = randomUUID();
    cashierUserId = randomUUID();
    employeeUserId = randomUUID();

    await pool.query(
      `INSERT INTO users (id, email_normalized, password_hash, password_hash_version) VALUES
       ($1, 'supp-role-owner@example.com', '$argon2id$v=19$owner', 1),
       ($2, 'supp-role-cashier@example.com', '$argon2id$v=19$cashier', 1),
       ($3, 'supp-role-employee@example.com', '$argon2id$v=19$employee', 1)`,
      [ownerUserId, cashierUserId, employeeUserId],
    );

    await pool.query(
      `INSERT INTO organizations (id, name, base_currency, timezone) VALUES
       ($1, 'Role Suppliers Org', 'ARS', 'America/Argentina/Mendoza')`,
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

  it('allows EMPLOYEE read-only access to suppliers for reception (RF-216)', async () => {
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
      name: 'Proveedor de Granos',
      taxId: '30-66778899-0',
      contact: 'granos@campo.com',
    });

    const readByEmployee = await service.findById(employeeContext, created.id);
    expect(readByEmployee.id).toBe(created.id);
    expect(readByEmployee.name).toBe('Proveedor de Granos');

    const listByEmployee = await service.list(employeeContext);
    expect(listByEmployee.items.some((s) => s.id === created.id)).toBe(true);
  });

  it('denies EMPLOYEE from mutating suppliers (RF-216)', async () => {
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
      name: 'Proveedor Intocable',
    });

    // Update denied
    await expect(
      service.update(employeeContext, created.id, created.version, { name: 'Modificado' }),
    ).rejects.toMatchObject({
      code: 'SUPPLIER_ACCESS_FORBIDDEN',
    });

    // Status change denied
    await expect(
      service.changeStatus(employeeContext, created.id, created.version, 'INACTIVE'),
    ).rejects.toMatchObject({
      code: 'SUPPLIER_STATUS_CHANGE_FORBIDDEN',
    });

    // Delete denied
    await expect(
      service.deletePhysically(employeeContext, created.id, created.version),
    ).rejects.toMatchObject({
      code: 'SUPPLIER_ACCESS_FORBIDDEN',
    });
  });

  it('denies CASHIER from all supplier operations (RF-217)', async () => {
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
      name: 'Proveedor Oculto para Cajero',
    });

    // Read by id denied
    await expect(service.findById(cashierContext, created.id)).rejects.toMatchObject({
      code: 'SUPPLIER_ACCESS_FORBIDDEN',
    });

    // List denied
    await expect(service.list(cashierContext)).rejects.toMatchObject({
      code: 'SUPPLIER_ACCESS_FORBIDDEN',
    });

    // Create denied
    await expect(
      service.create(cashierContext, { name: 'Intento de Cajero' }),
    ).rejects.toMatchObject({
      code: 'SUPPLIER_ACCESS_FORBIDDEN',
    });

    // Update denied
    await expect(
      service.update(cashierContext, created.id, created.version, { name: 'Modificado' }),
    ).rejects.toMatchObject({
      code: 'SUPPLIER_ACCESS_FORBIDDEN',
    });

    // Status change denied
    await expect(
      service.changeStatus(cashierContext, created.id, created.version, 'INACTIVE'),
    ).rejects.toMatchObject({
      code: 'SUPPLIER_STATUS_CHANGE_FORBIDDEN',
    });

    // Delete denied
    await expect(
      service.deletePhysically(cashierContext, created.id, created.version),
    ).rejects.toMatchObject({
      code: 'SUPPLIER_ACCESS_FORBIDDEN',
    });
  });
});
