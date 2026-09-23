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

describe('customer lifecycle (T083 / RF-211, RF-214, RF-219, RF-220)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let runtimePool: Pool;
  let service: CustomerManagementService;
  let organizationId: string;
  let ownerUserId: string;
  let adminUserId: string;
  let cashierUserId: string;

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
    adminUserId = randomUUID();
    cashierUserId = randomUUID();

    await pool.query(
      `INSERT INTO users (id, email_normalized, password_hash, password_hash_version) VALUES
       ($1, 'lifecycle-owner@example.com', '$argon2id$v=19$owner', 1),
       ($2, 'lifecycle-admin@example.com', '$argon2id$v=19$admin', 1),
       ($3, 'lifecycle-cashier@example.com', '$argon2id$v=19$cashier', 1)`,
      [ownerUserId, adminUserId, cashierUserId],
    );

    await pool.query(
      `INSERT INTO organizations (id, name, base_currency, timezone) VALUES
       ($1, 'Lifecycle Customers Org', 'ARS', 'America/Argentina/Mendoza')`,
      [organizationId],
    );

    await pool.query(
      `INSERT INTO memberships (id, organization_id, user_id, role) VALUES
       ($1, $2, $3, 'OWNER'),
       ($4, $5, $6, 'ADMIN'),
       ($7, $8, $9, 'CASHIER')`,
      [
        randomUUID(), organizationId, ownerUserId,
        randomUUID(), organizationId, adminUserId,
        randomUUID(), organizationId, cashierUserId,
      ],
    );
  });

  afterAll(async () => {
    await runtimePool?.end();
    await pool?.end();
    await container?.stop();
  });

  it('allows OWNER and ADMIN to consult customer by id and list customers (RF-211)', async () => {
    const ownerContext = {
      organizationId,
      requestId: randomUUID(),
      userId: ownerUserId,
    };
    const adminContext = {
      organizationId,
      requestId: randomUUID(),
      userId: adminUserId,
    };

    const created = await service.create(ownerContext, {
      name: 'Cliente Para Consultar',
      contact: 'test@consultar.com',
    });

    const foundByAdmin = await service.findById(adminContext, created.id);
    expect(foundByAdmin.id).toBe(created.id);
    expect(foundByAdmin.name).toBe('Cliente Para Consultar');

    const list = await service.list(adminContext);
    expect(list.items.some((c) => c.id === created.id)).toBe(true);
  });

  it('allows ADMIN to update customer details with optimistic concurrency (RF-211, RF-220)', async () => {
    const adminContext = {
      organizationId,
      requestId: randomUUID(),
      userId: adminUserId,
    };

    const created = await service.create(adminContext, {
      name: 'Cliente Original',
      taxId: '20-11112222-3',
    });

    const updated = await service.update(adminContext, created.id, created.version, {
      name: 'Cliente Modificado',
      contact: 'nuevo@correo.com',
    });

    expect(updated.name).toBe('Cliente Modificado');
    expect(updated.contact).toBe('nuevo@correo.com');
    expect(updated.version).toBe(created.version + 1);

    // Conflict on stale version
    await expect(
      service.update(adminContext, created.id, created.version, {
        name: 'Cliente Intento Obsoleto',
      }),
    ).rejects.toThrow(CustomerManagementError);
  });

  it('allows OWNER to deactivate and reactivate customer (RF-211, RF-214)', async () => {
    const ownerContext = {
      organizationId,
      requestId: randomUUID(),
      userId: ownerUserId,
    };

    const created = await service.create(ownerContext, {
      name: 'Cliente a Desactivar',
    });
    expect(created.status).toBe('ACTIVE');

    const deactivated = await service.changeStatus(
      ownerContext,
      created.id,
      created.version,
      'INACTIVE',
    );
    expect(deactivated.status).toBe('INACTIVE');
    expect(deactivated.version).toBe(created.version + 1);

    const reactivated = await service.changeStatus(
      ownerContext,
      created.id,
      deactivated.version,
      'ACTIVE',
    );
    expect(reactivated.status).toBe('ACTIVE');
    expect(reactivated.version).toBe(deactivated.version + 1);
  });

  it('allows physical deletion of customer without history (RF-211, RF-219)', async () => {
    const ownerContext = {
      organizationId,
      requestId: randomUUID(),
      userId: ownerUserId,
    };

    const created = await service.create(ownerContext, {
      name: 'Cliente Sin Historia',
    });

    const deleted = await service.deletePhysically(ownerContext, created.id, created.version);
    expect(deleted.id).toBe(created.id);
    expect(deleted.deleted).toBe(true);

    await expect(service.findById(ownerContext, created.id)).rejects.toThrow(
      CustomerManagementError,
    );
  });

  it('blocks physical deletion when customer has history references (RF-219)', async () => {
    const ownerContext = {
      organizationId,
      requestId: randomUUID(),
      userId: ownerUserId,
    };

    const created = await service.create(ownerContext, {
      name: 'Cliente Con Historial',
      taxId: '30-44556677-8',
    });

    // Record historical reference in customer_history_references
    await pool.query(
      `INSERT INTO customer_history_references (id, organization_id, customer_id, reference_type, source_id)
       VALUES ($1, $2, $3, 'SALE_CONFIRMED', $4)`,
      [randomUUID(), organizationId, created.id, randomUUID()],
    );

    await expect(
      service.deletePhysically(ownerContext, created.id, created.version),
    ).rejects.toThrow(CustomerManagementError);

    // Verify customer still exists
    const stillThere = await service.findById(ownerContext, created.id);
    expect(stillThere.id).toBe(created.id);
  });
});
