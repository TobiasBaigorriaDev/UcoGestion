import { randomUUID } from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runMigrations } from '../src/database/migrate.js';
import { TenantTransaction } from '../src/database/tenant-transaction.js';
import { CatalogItemCreationService } from '../src/modules/catalog/catalog-item-creation.service.js';
import { BranchManagementService } from '../src/modules/branches/branch-management.service.js';
import { InventoryIncreaseService } from '../src/modules/inventory/inventory-increase.service.js';

describe('inventory foundation', () => {
  let container: StartedPostgreSqlContainer;
  let admin: Pool;
  let runtime: Pool;
  let catalog: CatalogItemCreationService;
  let branches: BranchManagementService;
  const organizationA = randomUUID();
  const organizationB = randomUUID();
  const ownerA = randomUUID();
  const ownerB = randomUUID();

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    await runMigrations(container.getConnectionUri());
    admin = new Pool({ connectionString: container.getConnectionUri() });
    await admin.query("CREATE ROLE uco_runtime LOGIN PASSWORD 'runtime-password' IN ROLE uco_app");
    const url = new URL(container.getConnectionUri());
    url.username = 'uco_runtime';
    url.password = 'runtime-password';
    runtime = new Pool({ connectionString: url.toString() });
    const transactions = new TenantTransaction(runtime);
    catalog = new CatalogItemCreationService(transactions);
    branches = new BranchManagementService(transactions);
    await admin.query(`INSERT INTO users (id, email_normalized, password_hash, password_hash_version)
      VALUES ($1, 'inventory-a@example.com', '$argon2id$v=19$a', 1), ($2, 'inventory-b@example.com', '$argon2id$v=19$b', 1)`, [ownerA, ownerB]);
    await admin.query(`INSERT INTO organizations (id, name, base_currency, timezone)
      VALUES ($1, 'Inventory A', 'ARS', 'America/Argentina/Mendoza'),
             ($2, 'Inventory B', 'ARS', 'America/Argentina/Mendoza')`, [organizationA, organizationB]);
    await admin.query(`INSERT INTO memberships (id, organization_id, user_id, role)
      VALUES ($1, $2, $3, 'OWNER'), ($4, $5, $6, 'OWNER')`,
    [randomUUID(), organizationA, ownerA, randomUUID(), organizationB, ownerB]);
  });

  afterAll(async () => {
    await runtime?.end();
    await admin?.end();
    await container?.stop();
  });

  it('T096 creates tenant stock with decimal quantity and denies direct runtime edits', async () => {
    const branch = await branches.create({ organizationId: organizationA, userId: ownerA, requestId: randomUUID() }, { name: 'Stock foundation' });
    const item = await catalog.create({ organizationId: organizationA, userId: ownerA, requestId: randomUUID() },
      { name: 'Fractional stock', type: 'PRODUCT', trackInventory: true, baseUnit: 'FRACTIONAL' });
    const row = await admin.query<{ quantity: string; version: string }>(
      'SELECT quantity, version FROM branch_stocks WHERE organization_id = $1 AND branch_id = $2 AND item_id = $3',
      [organizationA, branch.id, item.id]);
    expect(row.rows).toEqual([{ quantity: '0.000', version: '1' }]);
    await expect(runtime.query('UPDATE branch_stocks SET quantity = 1 WHERE item_id = $1', [item.id]))
      .rejects.toMatchObject({ code: '42501' });
    await expect(admin.query('INSERT INTO branch_stocks (organization_id, branch_id, item_id, quantity) VALUES ($1, $2, $3, 0)',
      [organizationB, branch.id, item.id])).rejects.toMatchObject({ code: '23503' });
  });

  it('T097 keeps movements append-only and permits two distinct transfer effects per line', async () => {
    const origin = await branches.create({ organizationId: organizationA, userId: ownerA, requestId: randomUUID() }, { name: 'Transfer origin' });
    const destination = await branches.create({ organizationId: organizationA, userId: ownerA, requestId: randomUUID() }, { name: 'Transfer destination' });
    const item = await catalog.create({ organizationId: organizationA, userId: ownerA, requestId: randomUUID() },
      { name: 'Transfer item', type: 'PRODUCT', trackInventory: true });
    const sourceId = randomUUID();
    const lineId = randomUUID();
    const insert = (branchId: string, effect: string, delta: string) => admin.query(
      `INSERT INTO inventory_movements
       (id, organization_id, branch_id, item_id, actor_user_id, delta, source_type, source_id, source_line_id, effect_kind)
       VALUES ($1, $2, $3, $4, $5, $6, 'TRANSFER', $7, $8, $9)`,
      [randomUUID(), organizationA, branchId, item.id, ownerA, delta, sourceId, lineId, effect]);
    await insert(origin.id, 'TRANSFER_OUT', '-1.250');
    await insert(destination.id, 'TRANSFER_IN', '1.250');
    await expect(insert(destination.id, 'TRANSFER_IN', '1.250')).rejects.toMatchObject({ code: '23505' });
    await expect(admin.query('UPDATE inventory_movements SET delta = 2 WHERE source_id = $1', [sourceId]))
      .rejects.toMatchObject({ code: '55000' });
    await expect(admin.query('DELETE FROM inventory_movements WHERE source_id = $1', [sourceId]))
      .rejects.toMatchObject({ code: '55000' });
    const client = await runtime.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.organization_id', $1, true)", [organizationB]);
      expect((await client.query('SELECT id FROM inventory_movements WHERE source_id = $1', [sourceId])).rowCount).toBe(0);
      await client.query('ROLLBACK');
    } finally { client.release(); }
  });

  it('T098 and T099 initialize only inventoried products to zero without movements', async () => {
    const first = await branches.create({ organizationId: organizationB, userId: ownerB, requestId: randomUUID() }, { name: 'Before product' });
    const tracked = await catalog.create({ organizationId: organizationB, userId: ownerB, requestId: randomUUID() },
      { name: 'Tracked B', type: 'PRODUCT', trackInventory: true });
    const untracked = await catalog.create({ organizationId: organizationB, userId: ownerB, requestId: randomUUID() },
      { name: 'Untracked B', type: 'PRODUCT' });
    const service = await catalog.create({ organizationId: organizationB, userId: ownerB, requestId: randomUUID() },
      { name: 'Service B', type: 'SERVICE' });
    const second = await branches.create({ organizationId: organizationB, userId: ownerB, requestId: randomUUID() }, { name: 'After product' });
    const rows = await admin.query<{ branch_id: string; item_id: string; quantity: string }>(
      'SELECT branch_id, item_id, quantity FROM branch_stocks WHERE organization_id = $1 AND branch_id = ANY($2::uuid[])',
      [organizationB, [first.id, second.id]]);
    expect(rows.rows).toEqual(expect.arrayContaining([
      { branch_id: first.id, item_id: tracked.id, quantity: '0.000' },
      { branch_id: second.id, item_id: tracked.id, quantity: '0.000' },
    ]));
    expect(rows.rowCount).toBe(2);
    expect(rows.rows.some((row) => [untracked.id, service.id].includes(row.item_id))).toBe(false);
    expect((await admin.query('SELECT id FROM inventory_movements WHERE organization_id = $1 AND item_id = $2',
      [organizationB, tracked.id])).rowCount).toBe(0);
  });

  it('T100 confirms an initial increase with metadata, audit and atomic stock movement', async () => {
    const branch = await branches.create({ organizationId: organizationA, userId: ownerA, requestId: randomUUID() }, { name: 'Initial stock' });
    const item = await catalog.create({ organizationId: organizationA, userId: ownerA, requestId: randomUUID() },
      { name: 'Initial fractional stock', type: 'PRODUCT', trackInventory: true, baseUnit: 'FRACTIONAL' });
    const increase = new InventoryIncreaseService(new TenantTransaction(runtime));
    const context = { organizationId: organizationA, userId: ownerA, requestId: randomUUID() };
    const request = { branchId: branch.id, itemId: item.id,
      quantity: '1.250', reason: 'INVENTARIO_INICIAL', observation: 'Carga inicial' };
    const key = randomUUID();
    const result = await increase.confirm(context, request, key);
    expect(await increase.confirm({ ...context, requestId: randomUUID() }, { ...request, quantity: '1.25' }, key)).toEqual(result);
    await expect(increase.confirm(context, { ...request, quantity: '2' }, key)).rejects.toThrow();
    expect(result).toMatchObject({ branchId: branch.id, itemId: item.id, quantity: '1.25' });
    expect((await admin.query<{ quantity: string }>('SELECT quantity FROM branch_stocks WHERE organization_id = $1 AND branch_id = $2 AND item_id = $3',
      [organizationA, branch.id, item.id])).rows[0]?.quantity).toBe('1.250');
    const movements = await admin.query<{ delta: string; effect_kind: string }>(
      'SELECT delta, effect_kind FROM inventory_movements WHERE source_id = $1', [result.id]);
    expect(movements.rows).toEqual([{ delta: '1.250', effect_kind: 'INCREASE' }]);
    expect((await admin.query('SELECT observation, reason, actor_user_id FROM inventory_adjustments WHERE id = $1',
      [result.id])).rows[0]).toMatchObject({ observation: 'Carga inicial', reason: 'INVENTARIO_INICIAL', actor_user_id: ownerA });
    expect((await admin.query('SELECT action FROM audit_events WHERE entity_id = $1', [result.id])).rows)
      .toEqual([{ action: 'inventory.adjustment.increased' }]);
    expect((await admin.query('SELECT id FROM inventory_movements WHERE source_id = $1', [result.id])).rowCount).toBe(1);
    const beforeInvalid = await admin.query<{ quantity: string }>(
      'SELECT quantity FROM branch_stocks WHERE organization_id = $1 AND branch_id = $2 AND item_id = $3',
      [organizationA, branch.id, item.id]);
    await expect(increase.confirm(context, { ...request, quantity: '999999999999999999' }, randomUUID())).rejects.toThrow();
    expect((await admin.query<{ quantity: string }>(
      'SELECT quantity FROM branch_stocks WHERE organization_id = $1 AND branch_id = $2 AND item_id = $3',
      [organizationA, branch.id, item.id])).rows).toEqual(beforeInvalid.rows);
    await expect(increase.confirm(context, { branchId: branch.id, itemId: item.id, quantity: '0.001',
      reason: 'INVENTARIO_INICIAL' }, randomUUID())).resolves.toBeDefined();
    await expect(increase.confirm(context, { branchId: branch.id, itemId: item.id, quantity: '-1',
      reason: 'INVENTARIO_INICIAL' }, randomUUID())).rejects.toThrow();
    const foreignItem = await catalog.create({ organizationId: organizationB, userId: ownerB, requestId: randomUUID() },
      { name: 'Foreign initial item', type: 'PRODUCT', trackInventory: true });
    await expect(increase.confirm(context, { branchId: branch.id, itemId: foreignItem.id, quantity: '1',
      reason: 'INVENTARIO_INICIAL' }, randomUUID())).rejects.toThrow();
  });

  it('T100 rolls back the adjustment and movement when updating stock fails', async () => {
    const branch = await branches.create({ organizationId: organizationA, userId: ownerA, requestId: randomUUID() },
      { name: 'Overflow stock' });
    const item = await catalog.create({ organizationId: organizationA, userId: ownerA, requestId: randomUUID() },
      { name: 'Overflow item', type: 'PRODUCT', trackInventory: true, baseUnit: 'FRACTIONAL' });
    await admin.query('UPDATE branch_stocks SET quantity = $1 WHERE organization_id = $2 AND branch_id = $3 AND item_id = $4',
      ['99999999999999999.999', organizationA, branch.id, item.id]);
    const increase = new InventoryIncreaseService(new TenantTransaction(runtime));
    await expect(increase.confirm({ organizationId: organizationA, userId: ownerA, requestId: randomUUID() },
      { branchId: branch.id, itemId: item.id, quantity: '0.001', reason: 'INVENTARIO_INICIAL' }, randomUUID()))
      .rejects.toThrow();
    expect((await admin.query('SELECT id FROM inventory_adjustments WHERE item_id = $1', [item.id])).rowCount).toBe(0);
    expect((await admin.query('SELECT id FROM inventory_movements WHERE item_id = $1', [item.id])).rowCount).toBe(0);
    expect((await admin.query<{ quantity: string }>('SELECT quantity FROM branch_stocks WHERE item_id = $1 AND branch_id = $2',
      [item.id, branch.id]))
      .rows[0]?.quantity).toBe('99999999999999999.999');
  });
});
