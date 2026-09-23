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

describe('supplier lifecycle (T086 / RF-215, RF-218, RF-219, RF-220)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let runtimePool: Pool;
  let service: SupplierManagementService;
  let organizationId: string;
  let ownerUserId: string;
  let adminUserId: string;

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
    adminUserId = randomUUID();

    await pool.query(
      `INSERT INTO users (id, email_normalized, password_hash, password_hash_version) VALUES
       ($1, 'supp-life-owner@example.com', '$argon2id$v=19$owner', 1),
       ($2, 'supp-life-admin@example.com', '$argon2id$v=19$admin', 1)`,
      [ownerUserId, adminUserId],
    );

    await pool.query(
      `INSERT INTO organizations (id, name, base_currency, timezone) VALUES
       ($1, 'Lifecycle Suppliers Org', 'ARS', 'America/Argentina/Mendoza')`,
      [organizationId],
    );

    await pool.query(
      `INSERT INTO memberships (id, organization_id, user_id, role) VALUES
       ($1, $2, $3, 'OWNER'),
       ($4, $5, $6, 'ADMIN')`,
      [
        randomUUID(), organizationId, ownerUserId,
        randomUUID(), organizationId, adminUserId,
      ],
    );
  });

  afterAll(async () => {
    await runtimePool?.end();
    await pool?.end();
    await container?.stop();
  });

  it('allows OWNER and ADMIN to consult supplier by id and list suppliers (RF-215)', async () => {
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
      name: 'Proveedor A Consultar',
      contact: 'contacto@proveedor.com',
    });

    const foundByAdmin = await service.findById(adminContext, created.id);
    expect(foundByAdmin.id).toBe(created.id);
    expect(foundByAdmin.name).toBe('Proveedor A Consultar');

    const list = await service.list(adminContext);
    expect(list.items.some((s) => s.id === created.id)).toBe(true);
  });

  it('allows ADMIN to update supplier details with optimistic concurrency (RF-215, RF-220)', async () => {
    const adminContext = {
      organizationId,
      requestId: randomUUID(),
      userId: adminUserId,
    };

    const created = await service.create(adminContext, {
      name: 'Proveedor Original',
      taxId: '30-12345678-9',
    });

    const updated = await service.update(adminContext, created.id, created.version, {
      name: 'Proveedor Modificado',
      contact: 'nuevo@proveedor.com',
    });

    expect(updated.name).toBe('Proveedor Modificado');
    expect(updated.contact).toBe('nuevo@proveedor.com');
    expect(updated.version).toBe(created.version + 1);

    // Stale version conflict
    await expect(
      service.update(adminContext, created.id, created.version, {
        name: 'Proveedor Reintento Conflicto',
      }),
    ).rejects.toThrow(SupplierManagementError);
  });

  it('allows OWNER to deactivate and reactivate supplier (RF-215, RF-218)', async () => {
    const ownerContext = {
      organizationId,
      requestId: randomUUID(),
      userId: ownerUserId,
    };

    const created = await service.create(ownerContext, {
      name: 'Proveedor Para Desactivar',
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

  it('allows physical deletion of supplier without history (RF-215, RF-219)', async () => {
    const ownerContext = {
      organizationId,
      requestId: randomUUID(),
      userId: ownerUserId,
    };

    const created = await service.create(ownerContext, {
      name: 'Proveedor Sin Historia',
    });

    const deleted = await service.deletePhysically(ownerContext, created.id, created.version);
    expect(deleted.id).toBe(created.id);
    expect(deleted.deleted).toBe(true);

    await expect(service.findById(ownerContext, created.id)).rejects.toThrow(
      SupplierManagementError,
    );
  });

  it('blocks physical deletion when supplier has history references (RF-219)', async () => {
    const ownerContext = {
      organizationId,
      requestId: randomUUID(),
      userId: ownerUserId,
    };

    const created = await service.create(ownerContext, {
      name: 'Proveedor Con Historial',
      taxId: '30-99112233-4',
    });

    // Record historical reference in supplier_history_references
    await pool.query(
      `INSERT INTO supplier_history_references (id, organization_id, supplier_id, reference_type, source_id)
       VALUES ($1, $2, $3, 'PURCHASE_CONFIRMED', $4)`,
      [randomUUID(), organizationId, created.id, randomUUID()],
    );

    await expect(
      service.deletePhysically(ownerContext, created.id, created.version),
    ).rejects.toThrow(SupplierManagementError);

    // Verify supplier still exists
    const stillThere = await service.findById(ownerContext, created.id);
    expect(stillThere.id).toBe(created.id);
  });
});
