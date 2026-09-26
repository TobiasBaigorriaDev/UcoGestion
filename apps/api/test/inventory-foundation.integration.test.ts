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
import { StockThresholdService } from '../src/modules/inventory/stock-threshold.service.js';
import { InventoryTransferService } from '../src/modules/inventory/inventory-transfer.service.js';

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

  it('T106 stores an optional threshold by branch and flags stock at or below it', async () => {
    const first = await branches.create({ organizationId: organizationA, userId: ownerA, requestId: randomUUID() }, { name: 'Threshold one' });
    const second = await branches.create({ organizationId: organizationA, userId: ownerA, requestId: randomUUID() }, { name: 'Threshold two' });
    const item = await catalog.create({ organizationId: organizationA, userId: ownerA, requestId: randomUUID() },
      { name: 'Threshold item', type: 'PRODUCT', trackInventory: true });
    const context = { organizationId: organizationA, userId: ownerA, requestId: randomUUID() };
    const thresholds = new StockThresholdService(new TenantTransaction(runtime));
    const adjustment = new InventoryAdjustmentService(new TenantTransaction(runtime));
    expect(await thresholds.read(context, first.id, item.id)).toMatchObject({ quantity: '0.000', threshold: null, lowStock: false });
    await thresholds.set(context, first.id, item.id, '1', randomUUID());
    expect(await thresholds.read(context, first.id, item.id)).toMatchObject({ threshold: '1.000', lowStock: true });
    await adjustment.confirm(context, { branchId: first.id, itemId: item.id,
      direction: 'INCREASE', quantity: '1', reason: 'INVENTARIO_INICIAL' }, randomUUID());
    expect(await thresholds.read(context, first.id, item.id)).toMatchObject({ quantity: '1.000', lowStock: true });
    await adjustment.confirm(context, { branchId: first.id, itemId: item.id,
      direction: 'INCREASE', quantity: '1', reason: 'INVENTARIO_INICIAL' }, randomUUID());
    expect(await thresholds.read(context, first.id, item.id)).toMatchObject({ quantity: '2.000', lowStock: false });
    expect(await thresholds.read(context, second.id, item.id)).toMatchObject({ threshold: null, lowStock: false });
    await thresholds.set(context, first.id, item.id, null, randomUUID());
    expect(await thresholds.read(context, first.id, item.id)).toMatchObject({ threshold: null, lowStock: false });
    await thresholds.set(context, first.id, item.id, '0', randomUUID());
    expect(await thresholds.read(context, first.id, item.id)).toMatchObject({ threshold: '0.000', lowStock: false });
    await expect(thresholds.set(context, first.id, item.id, '-1', randomUUID())).rejects.toThrow();
    await expect(thresholds.set(context, first.id, item.id, '0.0000', randomUUID())).rejects.toThrow();
  });

  it('T107 scopes threshold writes and stock reads by role and assigned branch', async () => {
    const assigned = await branches.create({ organizationId: organizationA, userId: ownerA, requestId: randomUUID() }, { name: 'Scoped stock' });
    const other = await branches.create({ organizationId: organizationA, userId: ownerA, requestId: randomUUID() }, { name: 'Other stock' });
    const item = await catalog.create({ organizationId: organizationA, userId: ownerA, requestId: randomUUID() },
      { name: 'Visible stock item', type: 'PRODUCT', trackInventory: true });
    const thresholds = new StockThresholdService(new TenantTransaction(runtime));
    for (const role of ['ADMIN', 'EMPLOYEE', 'CASHIER'] as const) {
      const userId = randomUUID(); const membershipId = randomUUID();
      await admin.query('INSERT INTO users (id, email_normalized, password_hash, password_hash_version) VALUES ($1, $2, $3, 1)',
        [userId, `${userId}@example.com`, '$argon2id$v=19$scope']);
      await admin.query('INSERT INTO memberships (id, organization_id, user_id, role) VALUES ($1, $2, $3, $4)',
        [membershipId, organizationA, userId, role]);
      await admin.query('INSERT INTO membership_branches (organization_id, membership_id, branch_id) VALUES ($1, $2, $3)',
        [organizationA, membershipId, assigned.id]);
      const context = { organizationId: organizationA, userId, requestId: randomUUID() };
      expect(await thresholds.read(context, assigned.id, item.id)).toMatchObject({ branchId: assigned.id, itemId: item.id });
      await expect(thresholds.read(context, other.id, item.id)).rejects.toThrow();
      if (role === 'CASHIER') {
        await expect(thresholds.set(context, assigned.id, item.id, '1', randomUUID())).rejects.toThrow();
      } else {
        await expect(thresholds.set(context, assigned.id, item.id, '1', randomUUID())).resolves.toBeDefined();
        await expect(thresholds.set(context, other.id, item.id, '1', randomUUID())).rejects.toThrow();
      }
    }
    expect(await thresholds.read({ organizationId: organizationA, userId: ownerA, requestId: randomUUID() },
      other.id, item.id)).toMatchObject({ threshold: null });
    await expect(thresholds.read({ organizationId: organizationB, userId: ownerB, requestId: randomUUID() },
      assigned.id, item.id)).rejects.toThrow();
  });

  it('T108 accepts only distinct active in-scope branches and tenant-owned inventoried items', async () => {
    const origin = await branches.create({ organizationId: organizationA, userId: ownerA, requestId: randomUUID() }, { name: 'Policy origin' });
    const destination = await branches.create({ organizationId: organizationA, userId: ownerA, requestId: randomUUID() }, { name: 'Policy destination' });
    const foreign = await branches.create({ organizationId: organizationB, userId: ownerB, requestId: randomUUID() }, { name: 'Foreign destination' });
    const item = await catalog.create({ organizationId: organizationA, userId: ownerA, requestId: randomUUID() },
      { name: 'Transfer policy item', type: 'PRODUCT', trackInventory: true });
    const foreignItem = await catalog.create({ organizationId: organizationB, userId: ownerB, requestId: randomUUID() },
      { name: 'Foreign transfer item', type: 'PRODUCT', trackInventory: true });
    const service = new InventoryTransferService(new TenantTransaction(runtime));
    const context = { organizationId: organizationA, userId: ownerA, requestId: randomUUID() };
    const input = { originBranchId: origin.id, destinationBranchId: destination.id,
      lines: [{ itemId: item.id, quantity: '1' }] };
    await expect(service.validate(context, input)).resolves.toMatchObject(input);
    await expect(service.validate(context, { ...input, destinationBranchId: origin.id })).rejects.toThrow();
    await expect(service.validate(context, { ...input, destinationBranchId: foreign.id })).rejects.toThrow();
    await expect(service.validate(context, { ...input, lines: [{ itemId: foreignItem.id, quantity: '1' }] })).rejects.toThrow();
    await expect(service.validate(context, { ...input, lines: [{ itemId: item.id, quantity: '-1' }] })).rejects.toThrow();
    await expect(service.validate(context, { ...input, lines: [
      { itemId: item.id, quantity: '1' }, { itemId: item.id, quantity: '1' },
    ] })).rejects.toThrow();
    const outsider = randomUUID(); const membership = randomUUID();
    await admin.query('INSERT INTO users (id, email_normalized, password_hash, password_hash_version) VALUES ($1, $2, $3, 1)',
      [outsider, `${outsider}@example.com`, '$argon2id$v=19$transfer']);
    await admin.query("INSERT INTO memberships (id, organization_id, user_id, role) VALUES ($1, $2, $3, 'EMPLOYEE')",
      [membership, organizationA, outsider]);
    await admin.query('INSERT INTO membership_branches (organization_id, membership_id, branch_id) VALUES ($1, $2, $3)',
      [organizationA, membership, origin.id]);
    await expect(service.validate({ ...context, userId: outsider }, input)).rejects.toThrow();
    await admin.query('INSERT INTO membership_branches (organization_id, membership_id, branch_id) VALUES ($1, $2, $3)',
      [organizationA, membership, destination.id]);
    await expect(service.validate({ ...context, userId: outsider }, input)).resolves.toBeDefined();
    const cashier = randomUUID(); const cashierMembership = randomUUID();
    await admin.query('INSERT INTO users (id, email_normalized, password_hash, password_hash_version) VALUES ($1, $2, $3, 1)',
      [cashier, `${cashier}@example.com`, '$argon2id$v=19$cashier']);
    await admin.query("INSERT INTO memberships (id, organization_id, user_id, role) VALUES ($1, $2, $3, 'CASHIER')",
      [cashierMembership, organizationA, cashier]);
    await admin.query('INSERT INTO membership_branches (organization_id, membership_id, branch_id) VALUES ($1, $2, $3), ($1, $2, $4)',
      [organizationA, cashierMembership, origin.id, destination.id]);
    await expect(service.validate({ ...context, userId: cashier }, input)).rejects.toThrow();
  });

  it('T109 locks the global branch/item set and rejects any insufficient origin line', async () => {
    const origin = await branches.create({ organizationId: organizationA, userId: ownerA, requestId: randomUUID() }, { name: 'Lock origin' });
    const destination = await branches.create({ organizationId: organizationA, userId: ownerA, requestId: randomUUID() }, { name: 'Lock destination' });
    const first = await catalog.create({ organizationId: organizationA, userId: ownerA, requestId: randomUUID() },
      { name: 'Lock item 1', type: 'PRODUCT', trackInventory: true });
    const second = await catalog.create({ organizationId: organizationA, userId: ownerA, requestId: randomUUID() },
      { name: 'Lock item 2', type: 'PRODUCT', trackInventory: true });
    const context = { organizationId: organizationA, userId: ownerA, requestId: randomUUID() };
    const adjustment = new InventoryAdjustmentService(new TenantTransaction(runtime));
    await adjustment.confirm(context, { branchId: origin.id, itemId: first.id,
      direction: 'INCREASE', quantity: '2', reason: 'INVENTARIO_INICIAL' }, randomUUID());
    await adjustment.confirm(context, { branchId: origin.id, itemId: second.id,
      direction: 'INCREASE', quantity: '1', reason: 'INVENTARIO_INICIAL' }, randomUUID());
    const transfer = new InventoryTransferService(new TenantTransaction(runtime));
    const input = { originBranchId: origin.id, destinationBranchId: destination.id,
      lines: [{ itemId: second.id, quantity: '2' }, { itemId: first.id, quantity: '1' }] };
    await expect(transfer.checkAvailability(context, input)).rejects.toThrow(/stock/i);
    expect((await admin.query('SELECT quantity FROM branch_stocks WHERE branch_id = $1 AND item_id = $2',
      [origin.id, first.id])).rows[0]?.quantity).toBe('2.000');
    expect((await admin.query("SELECT id FROM inventory_movements WHERE source_type = 'TRANSFER' AND item_id = ANY($1::uuid[])",
      [[first.id, second.id]])).rowCount).toBe(0);
    await expect(transfer.checkAvailability(context, { ...input,
      lines: [{ itemId: second.id, quantity: '1' }, { itemId: first.id, quantity: '1' }] })).resolves.toBeDefined();
  });

  it('T110 commits every transfer line and effect together or none when one line lacks stock', async () => {
    const origin = await branches.create({ organizationId: organizationA, userId: ownerA, requestId: randomUUID() }, { name: 'Atomic origin' });
    const destination = await branches.create({ organizationId: organizationA, userId: ownerA, requestId: randomUUID() }, { name: 'Atomic destination' });
    const first = await catalog.create({ organizationId: organizationA, userId: ownerA, requestId: randomUUID() },
      { name: 'Atomic item 1', type: 'PRODUCT', trackInventory: true });
    const second = await catalog.create({ organizationId: organizationA, userId: ownerA, requestId: randomUUID() },
      { name: 'Atomic item 2', type: 'PRODUCT', trackInventory: true });
    const context = { organizationId: organizationA, userId: ownerA, requestId: randomUUID() };
    const adjustment = new InventoryAdjustmentService(new TenantTransaction(runtime));
    await adjustment.confirm(context, { branchId: origin.id, itemId: first.id,
      direction: 'INCREASE', quantity: '2', reason: 'INVENTARIO_INICIAL' }, randomUUID());
    const transfer = new InventoryTransferService(new TenantTransaction(runtime));
    const input = { originBranchId: origin.id, destinationBranchId: destination.id,
      lines: [{ itemId: first.id, quantity: '1' }, { itemId: second.id, quantity: '1' }] };
    await expect(transfer.confirm(context, input, randomUUID())).rejects.toThrow(/stock/i);
    expect((await admin.query('SELECT id FROM stock_transfers WHERE origin_branch_id = $1', [origin.id])).rowCount).toBe(0);
    expect((await admin.query('SELECT quantity FROM branch_stocks WHERE branch_id = $1 AND item_id = $2',
      [origin.id, first.id])).rows[0]?.quantity).toBe('2.000');
    await adjustment.confirm(context, { branchId: origin.id, itemId: second.id,
      direction: 'INCREASE', quantity: '1', reason: 'INVENTARIO_INICIAL' }, randomUUID());
    const key = randomUUID();
    const result = await transfer.confirm(context, input, key);
    expect(await transfer.confirm({ ...context, requestId: randomUUID() }, input, key)).toEqual(result);
    expect((await admin.query('SELECT id FROM stock_transfer_lines WHERE transfer_id = $1', [result.id])).rowCount).toBe(2);
    expect((await admin.query('SELECT id FROM inventory_movements WHERE source_id = $1', [result.id])).rowCount).toBe(4);
    expect((await admin.query('SELECT quantity FROM branch_stocks WHERE branch_id = $1 AND item_id = $2',
      [destination.id, second.id])).rows[0]?.quantity).toBe('1.000');
    const foreignClient = await runtime.connect();
    try {
      await foreignClient.query('BEGIN READ ONLY');
      await foreignClient.query("SELECT set_config('app.organization_id', $1, true)", [organizationB]);
      expect((await foreignClient.query('SELECT id FROM stock_transfers WHERE id = $1', [result.id])).rowCount).toBe(0);
      expect((await foreignClient.query('SELECT id FROM stock_transfer_lines WHERE transfer_id = $1', [result.id])).rowCount).toBe(0);
      await foreignClient.query('COMMIT');
    } finally { foreignClient.release(); }
  });

  it('T111 corrects a transfer only through one linked reverse transfer', async () => {
    const origin = await branches.create({ organizationId: organizationA, userId: ownerA, requestId: randomUUID() }, { name: 'Correction origin' });
    const destination = await branches.create({ organizationId: organizationA, userId: ownerA, requestId: randomUUID() }, { name: 'Correction destination' });
    const item = await catalog.create({ organizationId: organizationA, userId: ownerA, requestId: randomUUID() },
      { name: 'Correction item', type: 'PRODUCT', trackInventory: true });
    const context = { organizationId: organizationA, userId: ownerA, requestId: randomUUID() };
    const adjustment = new InventoryAdjustmentService(new TenantTransaction(runtime));
    await adjustment.confirm(context, { branchId: origin.id, itemId: item.id,
      direction: 'INCREASE', quantity: '3', reason: 'INVENTARIO_INICIAL' }, randomUUID());
    const transfer = new InventoryTransferService(new TenantTransaction(runtime));
    const original = await transfer.confirm(context, { originBranchId: origin.id,
      destinationBranchId: destination.id, lines: [{ itemId: item.id, quantity: '2' }] }, randomUUID());
    await expect(transfer.compensate({ organizationId: organizationB, userId: ownerB,
      requestId: randomUUID() }, original.id, randomUUID())).rejects.toThrow();
    const key = randomUUID();
    const correction = await transfer.compensate(context, original.id, key);
    expect(correction).toMatchObject({ originBranchId: destination.id, destinationBranchId: origin.id,
      lines: [{ itemId: item.id, quantity: '2' }] });
    expect(await transfer.compensate({ ...context, requestId: randomUUID() }, original.id, key)).toEqual(correction);
    await expect(transfer.compensate(context, original.id, randomUUID())).rejects.toThrow();
    await expect(transfer.compensate(context, correction.id, randomUUID())).rejects.toThrow();
    expect((await admin.query('SELECT original_transfer_id FROM stock_transfer_compensations WHERE compensation_transfer_id = $1',
      [correction.id])).rows[0]?.original_transfer_id).toBe(original.id);
    expect((await admin.query('SELECT quantity FROM branch_stocks WHERE branch_id = $1 AND item_id = $2',
      [origin.id, item.id])).rows[0]?.quantity).toBe('3.000');
    expect((await admin.query('SELECT count(*)::int AS n FROM inventory_movements WHERE source_id = ANY($1::uuid[])',
      [[original.id, correction.id]])).rows[0]?.n).toBe(4);
    await expect(admin.query('UPDATE stock_transfers SET origin_branch_id = $1 WHERE id = $2',
      [destination.id, original.id])).rejects.toMatchObject({ code: '55000' });
  });

  it('T112 retries a transient inventory deadlock with one idempotency key', async () => {
    const origin = await branches.create({ organizationId: organizationA, userId: ownerA, requestId: randomUUID() }, { name: 'Retry origin' });
    const destination = await branches.create({ organizationId: organizationA, userId: ownerA, requestId: randomUUID() }, { name: 'Retry destination' });
    const item = await catalog.create({ organizationId: organizationA, userId: ownerA, requestId: randomUUID() },
      { name: 'Retry item', type: 'PRODUCT', trackInventory: true });
    const context = { organizationId: organizationA, userId: ownerA, requestId: randomUUID() };
    await new InventoryAdjustmentService(new TenantTransaction(runtime)).confirm(context,
      { branchId: origin.id, itemId: item.id, direction: 'INCREASE', quantity: '2', reason: 'INVENTARIO_INICIAL' }, randomUUID());
    await admin.query('CREATE SEQUENCE inventory_deadlock_attempts');
    await admin.query(`CREATE FUNCTION inject_inventory_deadlock() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF nextval('inventory_deadlock_attempts') <= 2 THEN
        RAISE EXCEPTION 'injected deadlock' USING ERRCODE = '40P01';
      END IF; RETURN NEW; END $$`);
    await admin.query(`CREATE TRIGGER inject_inventory_deadlock BEFORE INSERT ON stock_transfers
      FOR EACH ROW EXECUTE FUNCTION inject_inventory_deadlock()`);
    try {
      const transfer = new InventoryTransferService(new TenantTransaction(runtime));
      const key = randomUUID();
      const input = { originBranchId: origin.id, destinationBranchId: destination.id,
        lines: [{ itemId: item.id, quantity: '1' }] };
      const created = await transfer.confirm(context, input, key);
      expect((await admin.query("SELECT last_value FROM inventory_deadlock_attempts")).rows[0]?.last_value).toBe('3');
      expect(await transfer.confirm(context, input, key)).toEqual(created);
      expect((await admin.query('SELECT count(*)::int AS n FROM stock_transfers WHERE id = $1',
        [created.id])).rows[0]?.n).toBe(1);
    } finally {
      await admin.query('DROP TRIGGER inject_inventory_deadlock ON stock_transfers');
      await admin.query('DROP FUNCTION inject_inventory_deadlock()');
      await admin.query('DROP SEQUENCE inventory_deadlock_attempts');
    }
  });

  it('T112 stops after three deadlocks and leaves no inventory effects', async () => {
    const origin = await branches.create({ organizationId: organizationA, userId: ownerA, requestId: randomUUID() }, { name: 'Exhaust origin' });
    const destination = await branches.create({ organizationId: organizationA, userId: ownerA, requestId: randomUUID() }, { name: 'Exhaust destination' });
    const item = await catalog.create({ organizationId: organizationA, userId: ownerA, requestId: randomUUID() },
      { name: 'Exhaust item', type: 'PRODUCT', trackInventory: true });
    const context = { organizationId: organizationA, userId: ownerA, requestId: randomUUID() };
    await new InventoryAdjustmentService(new TenantTransaction(runtime)).confirm(context,
      { branchId: origin.id, itemId: item.id, direction: 'INCREASE', quantity: '1', reason: 'INVENTARIO_INICIAL' }, randomUUID());
    await admin.query('CREATE SEQUENCE inventory_exhaust_attempts');
    await admin.query(`CREATE FUNCTION inject_inventory_exhaust() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM nextval('inventory_exhaust_attempts');
        RAISE EXCEPTION 'injected deadlock' USING ERRCODE = '40P01'; END $$`);
    await admin.query(`CREATE TRIGGER inject_inventory_exhaust BEFORE INSERT ON stock_transfers
      FOR EACH ROW EXECUTE FUNCTION inject_inventory_exhaust()`);
    try {
      const transfer = new InventoryTransferService(new TenantTransaction(runtime));
      await expect(transfer.confirm(context, { originBranchId: origin.id, destinationBranchId: destination.id,
        lines: [{ itemId: item.id, quantity: '1' }] }, randomUUID()))
        .rejects.toThrow('Concurrent inventory modification.');
      expect((await admin.query('SELECT last_value FROM inventory_exhaust_attempts')).rows[0]?.last_value).toBe('3');
      expect((await admin.query('SELECT count(*)::int AS n FROM stock_transfers WHERE origin_branch_id = $1',
        [origin.id])).rows[0]?.n).toBe(0);
      expect((await admin.query('SELECT quantity FROM branch_stocks WHERE branch_id = $1 AND item_id = $2',
        [origin.id, item.id])).rows[0]?.quantity).toBe('1.000');
    } finally {
      await admin.query('DROP TRIGGER inject_inventory_exhaust ON stock_transfers');
      await admin.query('DROP FUNCTION inject_inventory_exhaust()');
      await admin.query('DROP SEQUENCE inventory_exhaust_attempts');
    }
  });

  it('T113 rejects one of two competing multi-line transfers without partial effects', async () => {
    const origin = await branches.create({ organizationId: organizationA, userId: ownerA, requestId: randomUUID() }, { name: 'Race origin' });
    const destination = await branches.create({ organizationId: organizationA, userId: ownerA, requestId: randomUUID() }, { name: 'Race destination' });
    const first = await catalog.create({ organizationId: organizationA, userId: ownerA, requestId: randomUUID() },
      { name: 'Race first', type: 'PRODUCT', trackInventory: true });
    const second = await catalog.create({ organizationId: organizationA, userId: ownerA, requestId: randomUUID() },
      { name: 'Race second', type: 'PRODUCT', trackInventory: true });
    const context = { organizationId: organizationA, userId: ownerA, requestId: randomUUID() };
    const adjustment = new InventoryAdjustmentService(new TenantTransaction(runtime));
    for (const item of [first, second]) await adjustment.confirm(context,
      { branchId: origin.id, itemId: item.id, direction: 'INCREASE', quantity: '1', reason: 'INVENTARIO_INICIAL' }, randomUUID());
    const transfer = new InventoryTransferService(new TenantTransaction(runtime));
    const lines = [{ itemId: first.id, quantity: '1' }, { itemId: second.id, quantity: '1' }];
    const results = await Promise.allSettled([
      transfer.confirm(context, { originBranchId: origin.id, destinationBranchId: destination.id, lines }, randomUUID()),
      transfer.confirm({ ...context, requestId: randomUUID() }, { originBranchId: origin.id,
        destinationBranchId: destination.id, lines: [...lines].reverse() }, randomUUID()),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const transfers = await admin.query<{ id: string }>(
      'SELECT id FROM stock_transfers WHERE origin_branch_id = $1 AND destination_branch_id = $2',
      [origin.id, destination.id]);
    expect(transfers.rowCount).toBe(1);
    expect((await admin.query('SELECT count(*)::int AS n FROM inventory_movements WHERE source_id = $1',
      [transfers.rows[0]?.id])).rows[0]?.n).toBe(4);
    for (const item of [first, second]) {
      expect((await admin.query('SELECT branch_id, quantity FROM branch_stocks WHERE item_id = $1 ORDER BY branch_id',
        [item.id])).rows).toEqual(expect.arrayContaining([
        { branch_id: origin.id, quantity: '0.000' }, { branch_id: destination.id, quantity: '1.000' },
      ]));
    }
  });

  it('T113 confirms opposite A-to-B and B-to-A transfers without inverse-order deadlock', async () => {
    const a = await branches.create({ organizationId: organizationA, userId: ownerA, requestId: randomUUID() }, { name: 'Opposite A' });
    const b = await branches.create({ organizationId: organizationA, userId: ownerA, requestId: randomUUID() }, { name: 'Opposite B' });
    const items = await Promise.all(['Opposite item 1', 'Opposite item 2'].map((name) => catalog.create(
      { organizationId: organizationA, userId: ownerA, requestId: randomUUID() },
      { name, type: 'PRODUCT', trackInventory: true })));
    const context = { organizationId: organizationA, userId: ownerA, requestId: randomUUID() };
    const adjustment = new InventoryAdjustmentService(new TenantTransaction(runtime));
    for (const branch of [a, b]) for (const item of items) await adjustment.confirm(context,
      { branchId: branch.id, itemId: item.id, direction: 'INCREASE', quantity: '2', reason: 'INVENTARIO_INICIAL' }, randomUUID());
    const transfer = new InventoryTransferService(new TenantTransaction(runtime));
    const lines = items.map((item) => ({ itemId: item.id, quantity: '1' }));
    const [forward, reverse] = await Promise.all([
      transfer.confirm(context, { originBranchId: a.id, destinationBranchId: b.id, lines }, randomUUID()),
      transfer.confirm({ ...context, requestId: randomUUID() }, { originBranchId: b.id,
        destinationBranchId: a.id, lines: [...lines].reverse() }, randomUUID()),
    ]);
    expect((await admin.query('SELECT count(*)::int AS n FROM inventory_movements WHERE source_id = ANY($1::uuid[])',
      [[forward.id, reverse.id]])).rows[0]?.n).toBe(8);
    for (const branch of [a, b]) for (const item of items) expect((await admin.query(
      'SELECT quantity FROM branch_stocks WHERE branch_id = $1 AND item_id = $2',
      [branch.id, item.id])).rows[0]?.quantity).toBe('2.000');
  });
});
