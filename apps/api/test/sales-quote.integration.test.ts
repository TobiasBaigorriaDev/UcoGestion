import { randomUUID } from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runMigrations } from '../src/database/migrate.js';
import { TenantTransaction } from '../src/database/tenant-transaction.js';
import { SalesQuoteService } from '../src/modules/sales/sales-quote.service.js';
import { SalesPersistence } from '../src/modules/sales/sales-persistence.js';
import { SalesOperationsService } from '../src/modules/sales/sales-operations.service.js';
import { fingerprintSaleQuote } from '../src/modules/sales/sales-price-acceptance.js';
import { CatalogPriceService } from '../src/modules/catalog/catalog-price.service.js';
import { OrganizationTimezoneService } from '../src/modules/organizations/organization-timezone.service.js';
import { OrganizationCurrencyChangeService } from '../src/modules/organizations/organization-currency-change.service.js';

describe('sales quote', () => {
  let container: StartedPostgreSqlContainer;
  let admin: Pool;
  let runtime: Pool;
  let quotes: SalesQuoteService;
  const organizationId = randomUUID();
  const otherOrganizationId = randomUUID();
  const ownerId = randomUUID();
  const cashierId = randomUUID();
  const adminId = randomUUID();
  const employeeId = randomUUID();
  const cashierMembershipId = randomUUID();
  const adminMembershipId = randomUUID();
  const branchId = randomUUID();
  const unitId = randomUUID();
  const fractionalId = randomUUID();
  const deviceId = randomUUID();
  const registerId = randomUUID();
  const sessionId = randomUUID();
  const closingSessionId = randomUUID();
  const otherRegisterId = randomUUID();
  const otherBranchId = randomUUID();
  const customerId = randomUUID();
  const inactiveCustomerId = randomUUID();
  const foreignCustomerId = randomUUID();
  const context = (organization: string = organizationId, userId: string = ownerId) =>
    ({ organizationId: organization, userId, requestId: randomUUID() });

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    await runMigrations(container.getConnectionUri());
    admin = new Pool({ connectionString: container.getConnectionUri() });
    await admin.query("CREATE ROLE uco_sales_quote_runtime LOGIN PASSWORD 'runtime-password' IN ROLE uco_app");
    const url = new URL(container.getConnectionUri());
    url.username = 'uco_sales_quote_runtime';
    url.password = 'runtime-password';
    runtime = new Pool({ connectionString: url.toString() });
    quotes = new SalesQuoteService(new TenantTransaction(runtime));
    await admin.query("INSERT INTO users (id, email_normalized, password_hash, password_hash_version) VALUES ($1, 'sales-quote-owner@example.com', '$argon2id$v=19$owner', 1)", [ownerId]);
    await admin.query("INSERT INTO users (id, email_normalized, password_hash, password_hash_version) VALUES ($1, 'sales-quote-cashier@example.com', '$argon2id$v=19$cashier', 1)", [cashierId]);
    await admin.query("INSERT INTO users (id, email_normalized, password_hash, password_hash_version) VALUES ($1, 'sales-quote-admin@example.com', '$argon2id$v=19$admin', 1), ($2, 'sales-quote-employee@example.com', '$argon2id$v=19$employee', 1)", [adminId, employeeId]);
    await admin.query("INSERT INTO organizations (id, base_currency, timezone) VALUES ($1, 'ARS', 'UTC'), ($2, 'USD', 'UTC')", [organizationId, otherOrganizationId]);
    await admin.query("INSERT INTO memberships (id, organization_id, user_id, role) VALUES ($1, $2, $3, 'OWNER')", [randomUUID(), organizationId, ownerId]);
    await admin.query("INSERT INTO memberships (id, organization_id, user_id, role) VALUES ($1, $2, $3, 'CASHIER')", [cashierMembershipId, organizationId, cashierId]);
    await admin.query("INSERT INTO memberships (id, organization_id, user_id, role) VALUES ($1, $2, $3, 'ADMIN'), ($4, $2, $5, 'EMPLOYEE')", [adminMembershipId, organizationId, adminId, randomUUID(), employeeId]);
    await admin.query("INSERT INTO branches (id, organization_id, name) VALUES ($1, $2, 'Local')", [branchId, organizationId]);
    await admin.query("INSERT INTO branches (id, organization_id, name) VALUES ($1, $2, 'Otro')", [otherBranchId, organizationId]);
    await admin.query(`INSERT INTO catalog_items (id, organization_id, name, type, base_unit, price, price_version)
      VALUES ($1, $3, 'Unidad', 'PRODUCT', 'UNIT', '0.05', 1),
             ($2, $3, 'Fraccionable', 'PRODUCT', 'FRACTIONAL', '10.05', 2)`, [unitId, fractionalId, organizationId]);
    await admin.query(`INSERT INTO devices (id, organization_id, branch_id, authorized_by_user_id, authorized_at, status)
      VALUES ($1, $2, $3, $4, now(), 'ACTIVE')`, [deviceId, organizationId, branchId, ownerId]);
    await admin.query(`INSERT INTO cash_registers (id, organization_id, branch_id, name) VALUES ($1, $2, $3, 'Caja')`,
      [registerId, organizationId, branchId]);
    await admin.query(`INSERT INTO cash_registers (id, organization_id, branch_id, name) VALUES ($1, $2, $3, 'Otra caja')`,
      [otherRegisterId, organizationId, branchId]);
    await admin.query(`INSERT INTO cash_sessions (id, organization_id, branch_id, cash_register_id, owner_user_id,
      device_id, origin, status, opening_cash, expected_cash, currency_code)
      VALUES ($1, $2, $3, $4, $5, $6, 'ONLINE', 'OPEN', '0.00', '0.00', 'ARS')`,
    [sessionId, organizationId, branchId, registerId, ownerId, deviceId]);
    await admin.query(`INSERT INTO cash_sessions (id, organization_id, branch_id, cash_register_id, owner_user_id,
      device_id, origin, status, opening_cash, expected_cash, currency_code)
      VALUES ($1, $2, $3, $4, $5, $6, 'ONLINE', 'OPEN', '0.00', '0.00', 'ARS')`,
    [closingSessionId, organizationId, branchId, otherRegisterId, ownerId, deviceId]);
    await admin.query(`INSERT INTO cash_session_state_transitions
      (id, organization_id, cash_session_id, actor_user_id, from_status, to_status)
      VALUES ($1, $2, $3, $4, 'OPEN', 'CLOSING')`,
    [randomUUID(), organizationId, closingSessionId, ownerId]);
    await admin.query(`INSERT INTO customers (id, organization_id, name, status)
      VALUES ($1, $3, 'Cliente', 'ACTIVE'), ($2, $3, 'Inactivo', 'INACTIVE')`,
    [customerId, inactiveCustomerId, organizationId]);
    await admin.query(`INSERT INTO customers (id, organization_id, name, status)
      VALUES ($1, $2, 'Foreign', 'ACTIVE')`, [foreignCustomerId, otherOrganizationId]);
  });
  afterAll(async () => { await runtime?.end(); await admin?.end(); await container?.stop(); });

  it('T132 computes each line HALF_UP and validates quantities under tenant RLS', async () => {
    const quote = await quotes.quote(context(), branchId, [
      { itemId: unitId, quantity: '1' }, { itemId: unitId, quantity: '1' },
      { itemId: fractionalId, quantity: '0.5' },
    ]);
    expect(quote).toMatchObject({ currency: 'ARS', subtotal: '5.13', total: '5.13' });
    expect(quote.lines.map((line) => line.lineTotal)).toEqual(['0.05', '0.05', '5.03']);
    await expect(quotes.quote(context(), branchId, [{ itemId: unitId, quantity: '1.5' }]))
      .rejects.toMatchObject({ code: 'SALE_QUANTITY_INVALID' });
    await expect(quotes.quote(context(), branchId, [{ itemId: fractionalId, quantity: '0.0001' }]))
      .rejects.toMatchObject({ code: 'SALE_QUANTITY_INVALID' });
    await expect(quotes.quote(context(), branchId, [{ itemId: fractionalId, quantity: '100000000000000000' }]))
      .rejects.toMatchObject({ code: 'SALE_QUANTITY_INVALID' });
    await expect(quotes.quote(context(otherOrganizationId), branchId, [{ itemId: unitId, quantity: '1' }]))
      .rejects.toMatchObject({ code: 'SALE_BRANCH_NOT_FOUND' });
  });

  it('T133 accepts one global discount and rejects excess or unauthorized discounts', async () => {
    const lines = [{ itemId: unitId, quantity: '1' }];
    expect(await quotes.quote(context(), branchId, lines, { kind: 'PERCENTAGE', value: '50' }))
      .toMatchObject({ subtotal: '0.05', discount: '0.03', total: '0.02' });
    expect(await quotes.quote(context(), branchId, lines, { kind: 'FIXED', value: '0.05' }))
      .toMatchObject({ discount: '0.05', total: '0.00' });
    await expect(quotes.quote(context(), branchId, lines, { kind: 'PERCENTAGE', value: '100.01' }))
      .rejects.toMatchObject({ code: 'SALE_DISCOUNT_INVALID' });
    await expect(quotes.quote(context(), branchId, lines, { kind: 'FIXED', value: '0.06' }))
      .rejects.toMatchObject({ code: 'SALE_DISCOUNT_INVALID' });
    await expect(quotes.quote(context(organizationId, cashierId), branchId, lines, { kind: 'FIXED', value: '0.01' }))
      .rejects.toMatchObject({ code: 'SALE_DISCOUNT_FORBIDDEN' });
    await expect(quotes.quote(context(organizationId, employeeId), branchId, lines, { kind: 'FIXED', value: '0.01' }))
      .rejects.toMatchObject({ code: 'SALE_DISCOUNT_FORBIDDEN' });
  });

  it('T135 persists a confirmed sale with immutable item and receipt snapshots', async () => {
    const quote = await quotes.quote(context(), branchId, [{ itemId: unitId, quantity: '1' }]);
    const saleId = randomUUID();
    const transaction = new TenantTransaction(runtime);
    await transaction.runWithOptionalAudit(context(), async (client) => ({ result: await new SalesPersistence().persist(
      client, context(), { id: saleId, branchId, cashSessionId: sessionId, deviceId,
        clientOperationId: randomUUID(), customerId: null, quote,
        payments: [{ method: 'CASH', appliedAmount: quote.total }] }),
    }));
    const sale = await admin.query(`SELECT status, currency_code, customer_id, receipt_snapshot
      FROM sales WHERE id = $1`, [saleId]);
    expect(sale.rows[0]).toMatchObject({ status: 'CONFIRMED', currency_code: 'ARS', customer_id: null,
      receipt_snapshot: { organization: { name: 'Organización' }, branch: { name: 'Local' }, customer: null } });
    const item = await admin.query(`SELECT item_name, unit_price::text, line_total::text, currency_code
      FROM sale_items WHERE sale_id = $1`, [saleId]);
    expect(item.rows[0]).toMatchObject({ item_name: 'Unidad', unit_price: '0.05', line_total: '0.05', currency_code: 'ARS' });
    const priceService = new CatalogPriceService(transaction);
    const version = (await admin.query<{ version: string }>('SELECT version FROM catalog_items WHERE id=$1', [unitId])).rows[0];
    if (!version) throw new Error('Missing item fixture');
    const changed = await priceService.setPrice(context(), unitId, Number(version.version), '25.00');
    expect((await admin.query('SELECT price::text FROM catalog_items WHERE id=$1', [unitId])).rows).toEqual([{ price: '25.00' }]);
    expect((await admin.query(`SELECT status,currency_code,customer_id,receipt_snapshot FROM sales WHERE id=$1`, [saleId])).rows).toEqual(sale.rows);
    expect((await admin.query(`SELECT item_name,unit_price::text,line_total::text,currency_code FROM sale_items WHERE sale_id=$1`, [saleId])).rows).toEqual(item.rows);
    await priceService.setPrice(context(), unitId, changed.version, '0.05');
    const documentsBefore = (await admin.query('SELECT * FROM sales WHERE id=$1', [saleId])).rows;
    const movementsBefore = (await admin.query('SELECT * FROM cash_movements WHERE source_id=$1 ORDER BY id', [saleId])).rows;
    expect(movementsBefore).toHaveLength(1);
    const organizationVersion = (await admin.query<{ version: string }>('SELECT version FROM organizations WHERE id=$1', [organizationId])).rows[0];
    if (!organizationVersion) throw new Error('Missing organization fixture');
    const timezones = new OrganizationTimezoneService(transaction);
    const timezone = await timezones.update(context(), Number(organizationVersion.version), { timezone: 'America/Argentina/Buenos_Aires' });
    expect((await admin.query('SELECT * FROM sales WHERE id=$1', [saleId])).rows).toEqual(documentsBefore);
    expect((await admin.query('SELECT * FROM cash_movements WHERE source_id=$1 ORDER BY id', [saleId])).rows).toEqual(movementsBefore);
    await timezones.update(context(), timezone.version, { timezone: 'UTC' });
    await expect(new OrganizationCurrencyChangeService(transaction).change(context(), timezone.version + 1, 'USD', randomUUID()))
      .rejects.toMatchObject({ code: 'CURRENCY_LOCKED_BY_HISTORY' });
    expect((await admin.query('SELECT * FROM sales WHERE id=$1', [saleId])).rows).toEqual(documentsBefore);
    expect((await admin.query('SELECT * FROM cash_movements WHERE source_id=$1 ORDER BY id', [saleId])).rows).toEqual(movementsBefore);
    expect((await admin.query('SELECT operational_history_started_at FROM organizations WHERE id = $1',
      [organizationId])).rows[0]?.operational_history_started_at).not.toBeNull();
    expect(await transaction.read(context(otherOrganizationId), async (client) =>
      (await client.query('SELECT id FROM sales WHERE id = $1', [saleId])).rowCount)).toBe(0);
    await expect(admin.query('UPDATE sale_items SET item_name = $1 WHERE sale_id = $2', ['changed', saleId]))
      .rejects.toMatchObject({ code: '55000' });
    await expect(admin.query('UPDATE sales SET id = $1 WHERE id = $2', [randomUUID(), saleId]))
      .rejects.toMatchObject({ code: '55000' });
  });

  it('T136 snapshots an active optional customer and rejects an inactive one', async () => {
    const quote = await quotes.quote(context(), branchId, [{ itemId: unitId, quantity: '1' }]);
    const transaction = new TenantTransaction(runtime);
    const persist = (selectedCustomerId: string) => transaction.runWithOptionalAudit(context(), async (client) => ({
      result: await new SalesPersistence().persist(client, context(), { id: randomUUID(), branchId,
        cashSessionId: sessionId, deviceId, clientOperationId: randomUUID(), customerId: selectedCustomerId, quote,
        payments: [{ method: 'CASH', appliedAmount: quote.total }] }),
    }));
    const sale = await persist(customerId);
    expect((await admin.query('SELECT receipt_snapshot->\'customer\' AS customer FROM sales WHERE id = $1',
      [sale.id])).rows[0]?.customer).toMatchObject({ name: 'Cliente' });
    await expect(persist(inactiveCustomerId)).rejects.toMatchObject({ code: 'SALE_CUSTOMER_NOT_AVAILABLE' });
    await expect(persist(foreignCustomerId)).rejects.toMatchObject({ code: 'SALE_CUSTOMER_NOT_AVAILABLE' });
  });

  it('T137 locks and validates OPEN session, branch and operational device before insertion', async () => {
    const quote = await quotes.quote(context(), branchId, [{ itemId: unitId, quantity: '1' }]);
    const before = (await admin.query<{ count: number }>('SELECT count(*)::integer AS count FROM sales')).rows[0]?.count;
    const transaction = new TenantTransaction(runtime);
    const persist = (selectedBranch: string, selectedSession: string, selectedDevice: string) =>
      transaction.runWithOptionalAudit(context(), async (client) => ({ result: await new SalesPersistence().persist(
        client, context(), { id: randomUUID(), branchId: selectedBranch, cashSessionId: selectedSession,
          deviceId: selectedDevice, clientOperationId: randomUUID(), customerId: null, quote,
          payments: [{ method: 'CASH', appliedAmount: quote.total }] }),
      }));
    await expect(persist(branchId, closingSessionId, deviceId))
      .rejects.toMatchObject({ code: 'CASH_SESSION_NOT_OPEN' });
    await expect(persist(branchId, sessionId, randomUUID()))
      .rejects.toMatchObject({ code: 'CASH_SESSION_DEVICE_CONFLICT' });
    await expect(persist(otherBranchId, sessionId, deviceId))
      .rejects.toMatchObject({ code: 'SALE_SESSION_BRANCH_CONFLICT' });
    expect((await admin.query('SELECT count(*)::integer AS count FROM sales')).rows[0]?.count).toBe(before);
  });

  it('T138 applies sale actor role, branch scope and cashier ownership', async () => {
    const quote = await quotes.quote(context(), branchId, [{ itemId: unitId, quantity: '1' }]);
    const transaction = new TenantTransaction(runtime);
    const persist = (userId: string) => transaction.runWithOptionalAudit(context(organizationId, userId),
      async (client) => ({ result: await new SalesPersistence().persist(client, context(organizationId, userId),
        { id: randomUUID(), branchId, cashSessionId: sessionId, deviceId,
          clientOperationId: randomUUID(), customerId: null, quote,
          payments: [{ method: 'CASH', appliedAmount: quote.total }] }) }));
    await expect(persist(employeeId)).rejects.toMatchObject({ code: 'CASH_SESSION_ACTOR_FORBIDDEN' });
    await expect(persist(cashierId)).rejects.toMatchObject({ code: 'CASH_SESSION_ACTOR_FORBIDDEN' });
    await expect(persist(adminId)).rejects.toMatchObject({ code: 'CASH_SESSION_ACTOR_FORBIDDEN' });
    await admin.query('INSERT INTO membership_branches (organization_id, membership_id, branch_id) VALUES ($1, $2, $3)',
      [organizationId, adminMembershipId, branchId]);
    await expect(persist(adminId)).resolves.toHaveProperty('id');
    await expect(persist(ownerId)).resolves.toHaveProperty('id');
  });

  it('T139 preserves the sale actor and session owner and audits an intervention', async () => {
    const ownedRegisterId = randomUUID();
    const ownedSessionId = randomUUID();
    await admin.query("INSERT INTO cash_registers (id, organization_id, branch_id, name) VALUES ($1, $2, $3, 'Caja titular')",
      [ownedRegisterId, organizationId, branchId]);
    await admin.query(`INSERT INTO cash_sessions (id, organization_id, branch_id, cash_register_id, owner_user_id,
      device_id, origin, status, opening_cash, expected_cash, currency_code)
      VALUES ($1, $2, $3, $4, $5, $6, 'ONLINE', 'OPEN', '0.00', '0.00', 'ARS')`,
    [ownedSessionId, organizationId, branchId, ownedRegisterId, cashierId, deviceId]);
    const quote = await quotes.quote(context(), branchId, [{ itemId: unitId, quantity: '1' }]);
    const saleId = randomUUID();
    await new TenantTransaction(runtime).runWithOptionalAudit(context(), async (client) => ({
      result: await new SalesPersistence().persist(client, context(), { id: saleId, branchId,
        cashSessionId: ownedSessionId, deviceId, clientOperationId: randomUUID(), customerId: null, quote,
        payments: [{ method: 'CASH', appliedAmount: quote.total }] }),
    }));
    expect((await admin.query('SELECT actor_user_id, session_owner_user_id FROM sales WHERE id = $1',
      [saleId])).rows[0]).toEqual({ actor_user_id: ownerId, session_owner_user_id: cashierId });
    expect((await admin.query('SELECT owner_user_id FROM cash_sessions WHERE id = $1',
      [ownedSessionId])).rows[0]?.owner_user_id).toBe(cashierId);
    expect((await admin.query("SELECT actor_user_id, context_data FROM audit_events WHERE entity_id = $1 AND action = 'sale.confirmed'",
      [saleId])).rows[0]).toMatchObject({ actor_user_id: ownerId,
      context_data: { ownerUserId: cashierId } });
    await admin.query('INSERT INTO membership_branches (organization_id, membership_id, branch_id) VALUES ($1, $2, $3)',
      [organizationId, cashierMembershipId, branchId]);
    await expect(new TenantTransaction(runtime).runWithOptionalAudit(context(organizationId, cashierId),
      async (client) => ({ result: await new SalesPersistence().persist(client,
        context(organizationId, cashierId), { id: randomUUID(), branchId, cashSessionId: ownedSessionId,
          deviceId, clientOperationId: randomUUID(), customerId: null, quote,
          payments: [{ method: 'CASH', appliedAmount: quote.total }] }) }))).resolves.toHaveProperty('id');
  });

  it('T140 serializes competing sales and rolls back every line when stock is insufficient', async () => {
    const itemId = randomUUID();
    await admin.query(`INSERT INTO catalog_items (id, organization_id, name, type, base_unit, price,
      price_version, track_inventory) VALUES ($1, $2, 'Limitado', 'PRODUCT', 'UNIT', '1.00', 1, true)`,
    [itemId, organizationId]);
    await admin.query(`UPDATE branch_stocks SET quantity = '1'
      WHERE organization_id = $1 AND branch_id = $2 AND item_id = $3`, [organizationId, branchId, itemId]);
    const quote = await quotes.quote(context(), branchId, [{ itemId, quantity: '1' }]);
    const persist = () => new TenantTransaction(runtime).runWithOptionalAudit(context(), async (client) => ({
      result: await new SalesPersistence().persist(client, context(), { id: randomUUID(), branchId,
        cashSessionId: sessionId, deviceId, clientOperationId: randomUUID(), customerId: null, quote,
        payments: [{ method: 'CASH', appliedAmount: quote.total }] }),
    }));
    const results = await Promise.allSettled([persist(), persist()]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected').map((result) =>
      result.status === 'rejected' ? (result.reason as { code: string }).code : '')).toEqual(['SALE_STOCK_INSUFFICIENT']);
    expect((await admin.query('SELECT quantity::text FROM branch_stocks WHERE item_id = $1',
      [itemId])).rows[0]?.quantity).toBe('0.000');
    expect((await admin.query("SELECT count(*)::integer AS count FROM inventory_movements WHERE item_id = $1 AND source_type = 'SALE'",
      [itemId])).rows[0]?.count).toBe(1);
    const otherItemId = randomUUID();
    await admin.query(`INSERT INTO catalog_items (id, organization_id, name, type, base_unit, price,
      price_version, track_inventory) VALUES ($1, $2, 'Segundo', 'PRODUCT', 'UNIT', '1.00', 1, true)`,
    [otherItemId, organizationId]);
    await admin.query("UPDATE branch_stocks SET quantity = '1' WHERE organization_id = $1 AND branch_id = $2 AND item_id = $3",
      [organizationId, branchId, otherItemId]);
    const mixedQuote = await quotes.quote(context(), branchId, [
      { itemId: otherItemId, quantity: '1' }, { itemId, quantity: '1' }]);
    const rejectedSaleId = randomUUID();
    await expect(new TenantTransaction(runtime).runWithOptionalAudit(context(), async (client) => ({
      result: await new SalesPersistence().persist(client, context(), { id: rejectedSaleId, branchId,
        cashSessionId: sessionId, deviceId, clientOperationId: randomUUID(), customerId: null,
        quote: mixedQuote, payments: [{ method: 'CASH', appliedAmount: mixedQuote.total }] }),
    }))).rejects.toMatchObject({ code: 'SALE_STOCK_INSUFFICIENT' });
    expect((await admin.query('SELECT quantity::text FROM branch_stocks WHERE item_id = $1 AND branch_id = $2',
      [otherItemId, branchId])).rows[0]?.quantity).toBe('1.000');
    expect((await admin.query('SELECT count(*)::integer AS count FROM sales WHERE id = $1',
      [rejectedSaleId])).rows[0]?.count).toBe(0);
    await expect(new TenantTransaction(runtime).runWithOptionalAudit(context(otherOrganizationId),
      async (client) => ({ result: (await client.query<{ enough: boolean }>(
        'SELECT inventory_api.lock_sale_stock($1, $2, $3, $4, $5) AS enough',
        [otherOrganizationId, branchId, otherItemId, ownerId, '1'])).rows[0]?.enough })))
      .rejects.toMatchObject({ code: '42501' });
  });

  it.each(['PRODUCT', 'SERVICE'])('T141 leaves stock and inventory ledger untouched for untracked %s (RF-76)', async (type) => {
    const itemId = randomUUID();
    await admin.query(`INSERT INTO catalog_items (id, organization_id, name, type, base_unit, price,
      price_version, track_inventory) VALUES ($1,$2,'Sin existencias',$3,'UNIT','0.05',1,false)`,
    [itemId, organizationId, type]);
    // Absence of any stock row must not prevent confirming an untracked item.
    const quote = await quotes.quote(context(), branchId, [{ itemId, quantity: '2000' }]);
    const before = await admin.query('SELECT quantity::text AS quantity, version::text AS version FROM branch_stocks WHERE item_id = $1 AND branch_id = $2',
      [itemId, branchId]);
    expect(before.rows).toEqual([]);
    const saleId = randomUUID();
    await new TenantTransaction(runtime).runWithOptionalAudit(context(), async (client) => ({
      result: await new SalesPersistence().persist(client, context(), { id: saleId, branchId,
        cashSessionId: sessionId, deviceId, clientOperationId: randomUUID(), customerId: null, quote,
        payments: [{ method: 'CASH', appliedAmount: quote.total }] }),
    }));
    expect((await admin.query('SELECT quantity::text AS quantity, version::text AS version FROM branch_stocks WHERE item_id = $1 AND branch_id = $2',
      [itemId, branchId])).rows).toEqual(before.rows);
    expect((await admin.query('SELECT count(*)::integer AS count FROM inventory_movements WHERE source_id = $1',
      [saleId])).rows[0]?.count).toBe(0);
  });

  it('T142 requires positive enabled payment lines summing exactly to a positive sale', async () => {
    const quote = await quotes.quote(context(), branchId, [{ itemId: fractionalId, quantity: '1' }]);
    const persist = (payments: readonly { method: string; appliedAmount: string }[]) =>
      new TenantTransaction(runtime).runWithOptionalAudit(context(), async (client) => ({
        result: await new SalesPersistence().persist(client, context(), { id: randomUUID(), branchId,
          cashSessionId: sessionId, deviceId, clientOperationId: randomUUID(), customerId: null,
          quote, payments }),
      }));
    await expect(persist([])).rejects.toMatchObject({ code: 'SALE_PAYMENTS_INVALID' });
    await expect(persist([{ method: 'CASH', appliedAmount: '0.00' }]))
      .rejects.toMatchObject({ code: 'SALE_PAYMENTS_INVALID' });
    await expect(persist([{ method: 'CASH', appliedAmount: '10.04' }]))
      .rejects.toMatchObject({ code: 'SALE_PAYMENTS_INVALID' });
    await admin.query("UPDATE payment_method_settings SET enabled = false WHERE organization_id = $1 AND method = 'QR'",
      [organizationId]);
    await expect(persist([{ method: 'QR', appliedAmount: '10.05' }]))
      .rejects.toMatchObject({ code: 'SALE_PAYMENT_METHOD_DISABLED' });
    const sale = await persist([{ method: 'CASH', appliedAmount: '5.00' },
      { method: 'TRANSFER', appliedAmount: '5.05' }]);
    expect((await admin.query('SELECT method, applied_amount::text FROM sale_payments WHERE sale_id = $1 ORDER BY method',
      [sale.id])).rows).toEqual([{ method: 'CASH', applied_amount: '5.00' },
      { method: 'TRANSFER', applied_amount: '5.05' }]);
  });

  it('T143 records cash received and change while projecting only the applied amount', async () => {
    const quote = await quotes.quote(context(), branchId, [{ itemId: fractionalId, quantity: '1' }]);
    const before = (await admin.query('SELECT expected_cash::text FROM cash_sessions WHERE id = $1',
      [sessionId])).rows[0]?.expected_cash as string;
    const saleId = randomUUID();
    await new TenantTransaction(runtime).runWithOptionalAudit(context(), async (client) => ({
      result: await new SalesPersistence().persist(client, context(), { id: saleId, branchId,
        cashSessionId: sessionId, deviceId, clientOperationId: randomUUID(), customerId: null, quote,
        payments: [{ method: 'CASH', appliedAmount: '10.05', receivedAmount: '20.00' }] }),
    }));
    expect((await admin.query(`SELECT applied_amount::text, received_amount::text, change_amount::text
      FROM sale_payments WHERE sale_id = $1`, [saleId])).rows[0]).toEqual({ applied_amount: '10.05',
      received_amount: '20.00', change_amount: '9.95' });
    expect((await admin.query('SELECT total::text FROM sales WHERE id = $1',
      [saleId])).rows[0]?.total).toBe('10.05');
    expect((await admin.query("SELECT delta::text FROM cash_movements WHERE source_type = 'SALE' AND source_id = $1",
      [saleId])).rows).toEqual([{ delta: '10.05' }]);
    expect((await admin.query('SELECT expected_cash - $2::numeric AS increase FROM cash_sessions WHERE id = $1',
      [sessionId, before])).rows[0]?.increase).toBe('10.05');
  });

  it('T144 confirms a zero-total sale without payment or cash movement while enforcing stock and session', async () => {
    const freeItemId = randomUUID();
    await admin.query(`INSERT INTO catalog_items (id, organization_id, name, type, base_unit, price,
      price_version, track_inventory) VALUES ($1, $2, 'Gratuito', 'PRODUCT', 'UNIT', '0.00', 1, true)`,
    [freeItemId, organizationId]);
    const quote = await quotes.quote(context(), branchId, [{ itemId: freeItemId, quantity: '1' }]);
    const persist = (cashSessionId: string, userId: string, saleId = randomUUID()) =>
      new TenantTransaction(runtime).runWithOptionalAudit(context(organizationId, userId), async (client) => ({
        result: await new SalesPersistence().persist(client, context(organizationId, userId), {
          id: saleId, branchId, cashSessionId, deviceId, clientOperationId: randomUUID(),
          customerId: null, quote, payments: [],
        }),
      }));
    await expect(persist(closingSessionId, ownerId)).rejects.toMatchObject({ code: 'CASH_SESSION_NOT_OPEN' });
    await expect(persist(sessionId, employeeId)).rejects.toMatchObject({ code: 'CASH_SESSION_ACTOR_FORBIDDEN' });
    await expect(persist(sessionId, ownerId)).rejects.toMatchObject({ code: 'SALE_STOCK_INSUFFICIENT' });
    await admin.query(`UPDATE branch_stocks SET quantity = '1' WHERE organization_id = $1
      AND branch_id = $2 AND item_id = $3`, [organizationId, branchId, freeItemId]);
    const sale = await persist(sessionId, ownerId);
    expect((await admin.query('SELECT total::text, receipt_snapshot FROM sales WHERE id = $1',
      [sale.id])).rows[0]).toMatchObject({ total: '0.00', receipt_snapshot: { branch: { name: 'Local' } } });
    expect((await admin.query('SELECT count(*)::integer AS count FROM sale_payments WHERE sale_id = $1',
      [sale.id])).rows[0]?.count).toBe(0);
    expect((await admin.query("SELECT count(*)::integer AS count FROM cash_movements WHERE source_type = 'SALE' AND source_id = $1",
      [sale.id])).rows[0]?.count).toBe(0);
    expect((await admin.query('SELECT count(*)::integer AS count FROM inventory_movements WHERE source_id = $1',
      [sale.id])).rows[0]?.count).toBe(1);
  });

  it('T145 confirms and replays through the tenant runtime without crossing organizations', async () => {
    const operations = new SalesOperationsService(new TenantTransaction(runtime));
    const lines = [{ itemId: unitId, quantity: '1' }];
    const quote = await quotes.quote(context(), branchId, lines);
    const input = { branchId, cashSessionId: sessionId, deviceId, clientOperationId: randomUUID(),
      lines, payments: [{ method: 'TRANSFER', appliedAmount: quote.total }],
      quoteFingerprint: fingerprintSaleQuote(quote) };
    const first = await operations.confirm(context(), input, 'sale-runtime-1');
    expect(first).toMatchObject({ id: input.clientOperationId, total: '0.05',
      receipt: { label: 'Comprobante no fiscal' } });
    expect(await operations.confirm(context(), input, 'sale-runtime-1')).toEqual(first);
    await expect(operations.confirm(context(otherOrganizationId), { ...input,
      clientOperationId: randomUUID() }, 'sale-other-tenant')).rejects.toMatchObject({
        code: 'CASH_SESSION_NOT_OPEN' });
    expect((await admin.query('SELECT count(*)::integer AS count FROM sales WHERE client_operation_id = $1',
      [input.clientOperationId])).rows[0]?.count).toBe(1);
    expect((await admin.query('SELECT count(*)::integer AS count FROM idempotency_records WHERE key = $1',
      ['sale-runtime-1'])).rows[0]?.count).toBe(1);
  });
  it('T236J retains category after rename and reassignment', async () => {
    const categoryId = randomUUID();
    await admin.query("INSERT INTO catalog_categories (id,organization_id,name,status) VALUES ($1,$2,'Historical category','INACTIVE')", [categoryId, organizationId]);
    await admin.query('UPDATE catalog_items SET category_id=$1 WHERE id=$2', [categoryId, unitId]);

    const quote = await quotes.quote(context(), branchId, [{ itemId: unitId, quantity: '1' }]);
    const saleId = randomUUID();
    const transactions = new TenantTransaction(runtime), operations = new SalesOperationsService(transactions);
    const input = { branchId, cashSessionId: sessionId, deviceId, clientOperationId: saleId,
      lines: [{ itemId: unitId, quantity: '1' }], payments: [{ method: 'CASH', appliedAmount: quote.total }],
      quoteFingerprint: fingerprintSaleQuote(quote) };
    const key = randomUUID(), original = await operations.confirm(context(), input, key);
    const before = (await admin.query('SELECT category_id, category_name, category_snapshot_status FROM sale_items WHERE sale_id=$1', [saleId])).rows;
    expect(before).toEqual([{ category_id: categoryId, category_name: 'Historical category', category_snapshot_status: 'ASSIGNED' }]);
    expect((await admin.query('SELECT receipt_snapshot FROM sales WHERE id=$1', [saleId])).rows[0]?.receipt_snapshot.items[0])
      .toMatchObject({ category: { id: categoryId, name: 'Historical category' }, categorySnapshotStatus: 'ASSIGNED' });
    await admin.query("UPDATE catalog_categories SET name='Renamed' WHERE id=$1", [categoryId]);
    await admin.query('UPDATE catalog_items SET category_id=NULL WHERE id=$1', [unitId]);
    expect((await admin.query('SELECT category_id, category_name, category_snapshot_status FROM sale_items WHERE sale_id=$1', [saleId])).rows).toEqual(before);
    expect(await operations.confirm(context(), input, key)).toEqual(original);
    const none = await operations.confirm(context(), { ...input, clientOperationId: randomUUID() }, randomUUID());
    expect((await admin.query('SELECT category_id,category_name,category_snapshot_status FROM sale_items WHERE sale_id=$1', [none.id])).rows)
      .toEqual([{ category_id: null, category_name: null, category_snapshot_status: 'NONE' }]);
    await expect(admin.query('DELETE FROM catalog_categories WHERE id=$1', [categoryId])).rejects.toMatchObject({ code: '23503' });
    await admin.query('UPDATE catalog_items SET category_id=$1 WHERE id=$2', [categoryId, unitId]);
    const failedId = randomUUID();
    await expect(transactions.runWithOptionalAudit(context(), async client => {
      await new SalesPersistence().persist(client, context(), { id: failedId, branchId, cashSessionId: sessionId,
        deviceId, clientOperationId: failedId, customerId: null, quote, payments: input.payments });
      throw new Error('T236J rollback');
    })).rejects.toThrow('T236J rollback');
    expect((await admin.query('SELECT 1 FROM sales WHERE id=$1', [failedId])).rowCount).toBe(0);
    expect((await admin.query('SELECT 1 FROM sale_items WHERE sale_id=$1', [failedId])).rowCount).toBe(0);
    expect((await admin.query('SELECT 1 FROM catalog_category_history_references WHERE source_id=$1', [failedId])).rowCount).toBe(0);
    expect((await admin.query('SELECT 1 FROM cash_movements WHERE source_id=$1', [failedId])).rowCount).toBe(0);
    expect((await admin.query('SELECT 1 FROM audit_events WHERE entity_id=$1', [failedId])).rowCount).toBe(0);
    await admin.query('UPDATE catalog_items SET category_id=NULL WHERE id=$1', [unitId]);

  });

});
