import { randomUUID } from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runMigrations } from '../src/database/migrate.js';
import { TenantTransaction } from '../src/database/tenant-transaction.js';
import { CatalogItemCreationService } from '../src/modules/catalog/catalog-item-creation.service.js';
import { BranchManagementService } from '../src/modules/branches/branch-management.service.js';
import { InventoryIncreaseService } from '../src/modules/inventory/inventory-increase.service.js';
import { InventoryAdjustmentService } from '../src/modules/inventory/inventory-adjustment.service.js';

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

  it('T101 decrements under stock lock and rejects an insufficient balance without effects', async () => {
    const branch = await branches.create({ organizationId: organizationA, userId: ownerA, requestId: randomUUID() }, { name: 'Decrease stock' });
    const item = await catalog.create({ organizationId: organizationA, userId: ownerA, requestId: randomUUID() },
      { name: 'Decrease item', type: 'PRODUCT', trackInventory: true, baseUnit: 'FRACTIONAL' });
    const context = { organizationId: organizationA, userId: ownerA, requestId: randomUUID() };
    const increase = new InventoryIncreaseService(new TenantTransaction(runtime));
    await increase.confirm(context, { branchId: branch.id, itemId: item.id, quantity: '2.500', reason: 'INVENTARIO_INICIAL' }, randomUUID());
    const adjustment = new InventoryAdjustmentService(new TenantTransaction(runtime));
    const input = { branchId: branch.id, itemId: item.id, direction: 'DECREASE' as const,
      quantity: '1.250', reason: 'ROTURA', observation: 'Unidad dañada' };
    const result = await adjustment.confirm(context, input, randomUUID());
    expect(result.quantity).toBe('1.25');
    expect((await admin.query('SELECT quantity FROM branch_stocks WHERE item_id = $1 AND branch_id = $2',
      [item.id, branch.id])).rows[0]?.quantity).toBe('1.250');
    expect((await admin.query('SELECT direction, reason, observation FROM inventory_adjustments WHERE id = $1',
      [result.id])).rows[0]).toMatchObject({ direction: 'DECREASE', reason: 'ROTURA', observation: 'Unidad dañada' });
    expect((await admin.query('SELECT delta, effect_kind FROM inventory_movements WHERE source_id = $1',
      [result.id])).rows).toEqual([{ delta: '-1.250', effect_kind: 'DECREASE' }]);
    await expect(adjustment.confirm(context, { ...input, quantity: '1.251' }, randomUUID())).rejects.toThrow();
    expect((await admin.query('SELECT count(*)::int AS count FROM inventory_adjustments WHERE item_id = $1',
      [item.id])).rows[0]?.count).toBe(2);
    expect((await admin.query('SELECT quantity FROM branch_stocks WHERE item_id = $1 AND branch_id = $2',
      [item.id, branch.id])).rows[0]?.quantity).toBe('1.250');
  });

  it('T101 serializes competing decreases and never overdraws the same stock row', async () => {
    const branch = await branches.create({ organizationId: organizationA, userId: ownerA, requestId: randomUUID() }, { name: 'Concurrent decrease' });
    const item = await catalog.create({ organizationId: organizationA, userId: ownerA, requestId: randomUUID() },
      { name: 'Concurrent item', type: 'PRODUCT', trackInventory: true });
    const adjustment = new InventoryAdjustmentService(new TenantTransaction(runtime));
    const context = { organizationId: organizationA, userId: ownerA, requestId: randomUUID() };
    await adjustment.confirm(context, { branchId: branch.id, itemId: item.id,
      direction: 'INCREASE', quantity: '1', reason: 'INVENTARIO_INICIAL' }, randomUUID());
    const request = { branchId: branch.id, itemId: item.id,
      direction: 'DECREASE' as const, quantity: '1', reason: 'ROTURA' };
    const results = await Promise.allSettled([
      adjustment.confirm({ ...context, requestId: randomUUID() }, request, randomUUID()),
      adjustment.confirm({ ...context, requestId: randomUUID() }, request, randomUUID()),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect((await admin.query('SELECT quantity FROM branch_stocks WHERE branch_id = $1 AND item_id = $2',
      [branch.id, item.id])).rows[0]?.quantity).toBe('0.000');
    expect((await admin.query("SELECT id FROM inventory_movements WHERE item_id = $1 AND effect_kind = 'DECREASE'",
      [item.id])).rowCount).toBe(1);
  });

  it('T102 permits OWNER and scoped ADMIN reasons, rejecting unknown reasons and unassigned branches', async () => {
    const assigned = await branches.create({ organizationId: organizationA, userId: ownerA, requestId: randomUUID() }, { name: 'Adjustment assigned' });
    const unassigned = await branches.create({ organizationId: organizationA, userId: ownerA, requestId: randomUUID() }, { name: 'Adjustment unassigned' });
    const item = await catalog.create({ organizationId: organizationA, userId: ownerA, requestId: randomUUID() },
      { name: 'Admin stock item', type: 'PRODUCT', trackInventory: true });
    const adminId = randomUUID(); const membershipId = randomUUID();
    await admin.query('INSERT INTO users (id, email_normalized, password_hash, password_hash_version) VALUES ($1, $2, $3, 1)',
      [adminId, `${adminId}@example.com`, '$argon2id$v=19$admin']);
    await admin.query("INSERT INTO memberships (id, organization_id, user_id, role) VALUES ($1, $2, $3, 'ADMIN')",
      [membershipId, organizationA, adminId]);
    await admin.query('INSERT INTO membership_branches (organization_id, membership_id, branch_id) VALUES ($1, $2, $3)',
      [organizationA, membershipId, assigned.id]);
    const adjustment = new InventoryAdjustmentService(new TenantTransaction(runtime));
    const ownerContext = { organizationId: organizationA, userId: ownerA, requestId: randomUUID() };
    const adminContext = { organizationId: organizationA, userId: adminId, requestId: randomUUID() };
    for (const reason of ['INVENTARIO_INICIAL', 'CONTEO_FISICO', 'ROTURA', 'PERDIDA', 'VENCIMIENTO', 'CORRECCION', 'OTRO']) {
      await expect(adjustment.confirm(ownerContext, { branchId: assigned.id, itemId: item.id,
        direction: 'INCREASE', quantity: '1', reason }, randomUUID())).resolves.toBeDefined();
    }
    await expect(adjustment.confirm(adminContext, { branchId: assigned.id, itemId: item.id,
      direction: 'DECREASE', quantity: '1', reason: 'CORRECCION' }, randomUUID())).resolves.toBeDefined();
    await expect(adjustment.confirm(adminContext, { branchId: unassigned.id, itemId: item.id,
      direction: 'INCREASE', quantity: '1', reason: 'OTRO' }, randomUUID())).rejects.toThrow();
    await expect(adjustment.confirm(ownerContext, { branchId: assigned.id, itemId: item.id,
      direction: 'INCREASE', quantity: '1', reason: 'INVALIDO' }, randomUUID())).rejects.toThrow();
  });

  it('T103 permits scoped EMPLOYEE reasons and rejects initial inventory and another branch', async () => {
    const assigned = await branches.create({ organizationId: organizationA, userId: ownerA, requestId: randomUUID() }, { name: 'Employee assigned' });
    const unassigned = await branches.create({ organizationId: organizationA, userId: ownerA, requestId: randomUUID() }, { name: 'Employee unassigned' });
    const item = await catalog.create({ organizationId: organizationA, userId: ownerA, requestId: randomUUID() },
      { name: 'Employee adjustment item', type: 'PRODUCT', trackInventory: true });
    const employeeId = randomUUID(); const membershipId = randomUUID();
    await admin.query('INSERT INTO users (id, email_normalized, password_hash, password_hash_version) VALUES ($1, $2, $3, 1)',
      [employeeId, `${employeeId}@example.com`, '$argon2id$v=19$employee']);
    await admin.query("INSERT INTO memberships (id, organization_id, user_id, role) VALUES ($1, $2, $3, 'EMPLOYEE')",
      [membershipId, organizationA, employeeId]);
    await admin.query('INSERT INTO membership_branches (organization_id, membership_id, branch_id) VALUES ($1, $2, $3)',
      [organizationA, membershipId, assigned.id]);
    const context = { organizationId: organizationA, userId: employeeId, requestId: randomUUID() };
    const adjustment = new InventoryAdjustmentService(new TenantTransaction(runtime));
    for (const reason of ['CONTEO_FISICO', 'ROTURA', 'PERDIDA', 'VENCIMIENTO', 'CORRECCION', 'OTRO']) {
      await expect(adjustment.confirm(context, { branchId: assigned.id, itemId: item.id,
        direction: 'INCREASE', quantity: '1', reason }, randomUUID())).resolves.toBeDefined();
    }
    await expect(adjustment.confirm(context, { branchId: assigned.id, itemId: item.id,
      direction: 'DECREASE', quantity: '1', reason: 'ROTURA' }, randomUUID())).resolves.toBeDefined();
    await expect(adjustment.confirm(context, { branchId: assigned.id, itemId: item.id,
      direction: 'INCREASE', quantity: '1', reason: 'INVENTARIO_INICIAL' }, randomUUID())).rejects.toThrow();
    await expect(adjustment.confirm(context, { branchId: unassigned.id, itemId: item.id,
      direction: 'INCREASE', quantity: '1', reason: 'OTRO' }, randomUUID())).rejects.toThrow();
  });

  it('T104 rejects CASHIER adjustments in either direction without any effects', async () => {
    const branch = await branches.create({ organizationId: organizationA, userId: ownerA, requestId: randomUUID() }, { name: 'Cashier adjustment' });
    const item = await catalog.create({ organizationId: organizationA, userId: ownerA, requestId: randomUUID() },
      { name: 'Cashier item', type: 'PRODUCT', trackInventory: true });
    const cashierId = randomUUID(); const membershipId = randomUUID();
    await admin.query('INSERT INTO users (id, email_normalized, password_hash, password_hash_version) VALUES ($1, $2, $3, 1)',
      [cashierId, `${cashierId}@example.com`, '$argon2id$v=19$cashier']);
    await admin.query("INSERT INTO memberships (id, organization_id, user_id, role) VALUES ($1, $2, $3, 'CASHIER')",
      [membershipId, organizationA, cashierId]);
    await admin.query('INSERT INTO membership_branches (organization_id, membership_id, branch_id) VALUES ($1, $2, $3)',
      [organizationA, membershipId, branch.id]);
    const context = { organizationId: organizationA, userId: cashierId, requestId: randomUUID() };
    const adjustment = new InventoryAdjustmentService(new TenantTransaction(runtime));
    for (const direction of ['INCREASE', 'DECREASE'] as const) {
      await expect(adjustment.confirm(context, { branchId: branch.id, itemId: item.id,
        direction, quantity: '1', reason: 'CORRECCION' }, randomUUID())).rejects.toThrow();
    }
    expect((await admin.query('SELECT id FROM inventory_adjustments WHERE item_id = $1', [item.id])).rowCount).toBe(0);
    expect((await admin.query('SELECT id FROM inventory_movements WHERE item_id = $1', [item.id])).rowCount).toBe(0);
  });

  it('T105 compensates a confirmed adjustment once with an opposite linked movement', async () => {
    const branch = await branches.create({ organizationId: organizationA, userId: ownerA, requestId: randomUUID() }, { name: 'Compensation' });
    const item = await catalog.create({ organizationId: organizationA, userId: ownerA, requestId: randomUUID() },
      { name: 'Compensated item', type: 'PRODUCT', trackInventory: true });
    const context = { organizationId: organizationA, userId: ownerA, requestId: randomUUID() };
    const adjustment = new InventoryAdjustmentService(new TenantTransaction(runtime));
    const original = await adjustment.confirm(context, { branchId: branch.id, itemId: item.id,
      direction: 'INCREASE', quantity: '2', reason: 'CONTEO_FISICO' }, randomUUID());
    const key = randomUUID();
    const compensation = await adjustment.compensate(context, original.id, 'Recuento corregido', key);
    expect(await adjustment.compensate({ ...context, requestId: randomUUID() }, original.id,
      'Recuento corregido', key)).toEqual(compensation);
    expect((await admin.query('SELECT direction, quantity, reason, observation FROM inventory_adjustments WHERE id = $1',
      [original.id])).rows[0]).toMatchObject({ direction: 'INCREASE', quantity: '2.000', reason: 'CONTEO_FISICO' });
    expect((await admin.query('SELECT original_adjustment_id FROM inventory_adjustment_compensations WHERE compensation_adjustment_id = $1',
      [compensation.id])).rows[0]?.original_adjustment_id).toBe(original.id);
    expect((await admin.query('SELECT delta FROM inventory_movements WHERE source_id = $1',
      [compensation.id])).rows[0]?.delta).toBe('-2.000');
    expect((await admin.query('SELECT quantity FROM branch_stocks WHERE branch_id = $1 AND item_id = $2',
      [branch.id, item.id])).rows[0]?.quantity).toBe('0.000');
    await expect(adjustment.compensate(context, original.id, 'Otra corrección', randomUUID())).rejects.toThrow();
    await expect(admin.query('UPDATE inventory_adjustments SET reason = $1 WHERE id = $2',
      ['OTRO', original.id])).rejects.toMatchObject({ code: '55000' });
    await expect(adjustment.compensate({ organizationId: organizationB, userId: ownerB, requestId: randomUUID() },
      original.id, 'Ajeno', randomUUID())).rejects.toThrow();
  });

  it('T105 rolls back a compensation that would make stock negative', async () => {
    const branch = await branches.create({ organizationId: organizationA, userId: ownerA, requestId: randomUUID() }, { name: 'Compensation shortage' });
    const item = await catalog.create({ organizationId: organizationA, userId: ownerA, requestId: randomUUID() },
      { name: 'Short compensation item', type: 'PRODUCT', trackInventory: true });
    const context = { organizationId: organizationA, userId: ownerA, requestId: randomUUID() };
    const adjustment = new InventoryAdjustmentService(new TenantTransaction(runtime));
    const original = await adjustment.confirm(context, { branchId: branch.id, itemId: item.id,
      direction: 'INCREASE', quantity: '2', reason: 'CONTEO_FISICO' }, randomUUID());
    await adjustment.confirm(context, { branchId: branch.id, itemId: item.id,
      direction: 'DECREASE', quantity: '1', reason: 'ROTURA' }, randomUUID());
    await expect(adjustment.compensate(context, original.id, 'No alcanza', randomUUID())).rejects.toThrow();
    expect((await admin.query('SELECT original_adjustment_id FROM inventory_adjustment_compensations WHERE original_adjustment_id = $1',
      [original.id])).rowCount).toBe(0);
    expect((await admin.query('SELECT quantity FROM branch_stocks WHERE branch_id = $1 AND item_id = $2',
      [branch.id, item.id])).rows[0]?.quantity).toBe('1.000');
    expect((await admin.query('SELECT id FROM inventory_adjustments WHERE item_id = $1', [item.id])).rowCount).toBe(2);
  });
});
