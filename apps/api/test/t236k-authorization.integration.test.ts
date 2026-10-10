import { generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { runMigrations } from '../src/database/migrate.js';
import { TenantTransaction } from '../src/database/tenant-transaction.js';
import { CatalogItemCreationService } from '../src/modules/catalog/catalog-item-creation.service.js';
import { InventoryIncreaseService } from '../src/modules/inventory/inventory-increase.service.js';
import { InventoryTransferService } from '../src/modules/inventory/inventory-transfer.service.js';
import { CashOperationsService } from '../src/modules/cash/cash-operations.service.js';
import { CashCloseService } from '../src/modules/cash/cash-close.service.js';
import { DeviceAuthorizationService } from '../src/modules/cash/device-authorization.service.js';
import { CustomerManagementService } from '../src/modules/customers/customer-management.service.js';
import { SupplierManagementService } from '../src/modules/suppliers/supplier-management.service.js';
import { PurchaseOperationsService } from '../src/modules/purchases/purchase-operations.service.js';
import { MembershipAdministrationService } from '../src/modules/users/membership-administration.service.js';
import { InvitationCreationService } from '../src/modules/users/invitation-creation.service.js';
import { BranchDeactivationService } from '../src/modules/branches/branch-deactivation.service.js';
import { CashRegisterManagementService } from '../src/modules/branches/cash-register-management.service.js';
import { InventoryAdjustmentService } from '../src/modules/inventory/inventory-adjustment.service.js';
import { StockThresholdService } from '../src/modules/inventory/stock-threshold.service.js';
import { ExpenseOperationsService } from '../src/modules/expenses/expense-operations.service.js';
import { ExpenseCategoryManagementService } from '../src/modules/expenses/expense-category-management.service.js';
import { InvitationRevocationService } from '../src/modules/users/invitation-revocation.service.js';
import { InvitationResendService } from '../src/modules/users/invitation-resend.service.js';
import { OfflineBootstrapService } from '../src/modules/offline-sync/offline-bootstrap.service.js';
import { RsaSyncEnvelopeDecryptor } from '../src/modules/offline-sync/sync-envelope-decryptor.js';
import { DeviceCertificate } from '../src/modules/offline-sync/device-certificate.js';
import { CatalogPriceService } from '../src/modules/catalog/catalog-price.service.js';
import { SalesOperationsService } from '../src/modules/sales/sales-operations.service.js';

type Role = 'OWNER' | 'ADMIN' | 'CASHIER' | 'EMPLOYEE';
const roles: readonly Role[] = ['OWNER', 'ADMIN', 'CASHIER', 'EMPLOYEE'];
describe('T236K real persisted membership authorization', () => {
  const bootstrapSigning = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const bootstrapRsa = generateKeyPairSync('rsa', { modulusLength: 3072 });
  let container: StartedPostgreSqlContainer, db: Pool, runtime: Pool, tx: TenantTransaction;
  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    await runMigrations(container.getConnectionUri());
    db = new Pool({ connectionString: container.getConnectionUri() });
    await db.query("CREATE ROLE authorization_runtime LOGIN PASSWORD 'runtime-password' IN ROLE uco_app");
    const url = new URL(container.getConnectionUri());
    url.username = 'authorization_runtime'; url.password = 'runtime-password';
    runtime = new Pool({ connectionString: url.toString() }); tx = new TenantTransaction(runtime);
  });
  afterAll(async () => { await runtime?.end(); await db?.end(); await container?.stop(); });

  async function fixture() {
    const org = randomUUID(), foreign = randomUUID(), branch = randomUUID(), outside = randomUUID(), foreignBranch = randomUUID();
    await db.query("INSERT INTO organizations(id,name,base_currency,timezone) VALUES ($1,'Local','ARS','UTC'),($2,'Foreign','ARS','UTC')", [org, foreign]);
    await db.query("INSERT INTO branches(id,organization_id,name) VALUES ($1,$2,'Assigned'),($3,$2,'Outside'),($4,$5,'Foreign')", [branch, org, outside, foreignBranch, foreign]);
    const users = {} as Record<Role, string>, members = {} as Record<Role, string>;
    for (const role of roles) {
      const user = randomUUID(), member = randomUUID(); users[role] = user; members[role] = member;
      await db.query("INSERT INTO users(id,email_normalized,password_hash,password_hash_version) VALUES ($1,$2,'$argon2id$v=19$fixture',1)", [user, `${user}@example.com`]);
      await db.query('INSERT INTO memberships(id,organization_id,user_id,role) VALUES ($1,$2,$3,$4)', [member, org, user, role]);
      if (role !== 'OWNER') await db.query('INSERT INTO membership_branches(organization_id,membership_id,branch_id) VALUES ($1,$2,$3)', [org, member, branch]);
    }
    const foreignUser = randomUUID();
    await db.query("INSERT INTO users(id,email_normalized,password_hash,password_hash_version) VALUES ($1,$2,'$argon2id$v=19$fixture',1)", [foreignUser, `${foreignUser}@example.com`]);
    await db.query("INSERT INTO memberships(id,organization_id,user_id,role) VALUES ($1,$2,$3,'OWNER')", [randomUUID(), foreign, foreignUser]);
    const context = (role: Role = 'OWNER', organizationId = org) => ({ organizationId, userId: users[role], requestId: randomUUID() });
    const foreignContext = () => ({ organizationId: org, userId: foreignUser, requestId: randomUUID() });
    const catalog = new CatalogItemCreationService(tx);
    const item = await catalog.create(context(), { name: 'Stock', type: 'PRODUCT', trackInventory: true, baseUnit: 'UNIT' });
    const supplier = await new SupplierManagementService(tx).create(context(), { name: 'Supplier' }, randomUUID());
    return { org, foreign, branch, outside, foreignBranch, users, members, context, foreignContext, item, supplier };
  }

  // Compare documents, projections, ledgers, audit, outbox and idempotency, not just response codes.
  async function snapshot(org: string) {
    const tables = ['cash_sessions', 'cash_movements', 'cash_close_attempts', 'cash_session_closures',
      'cash_session_state_transitions', 'cash_final_syncs', 'inventory_adjustments', 'inventory_movements',
      'branch_stocks', 'stock_transfers', 'stock_transfer_lines', 'purchases', 'purchase_items',
      'customers', 'suppliers', 'memberships', 'membership_branches', 'invitations', 'invitation_branches',
      'devices', 'cash_registers', 'stock_thresholds', 'expenses', 'sales', 'sale_items', 'sale_payments', 'catalog_items',
      'configuration_versions', 'offline_grants', 'offline_grant_authorizations', 'offline_configuration_exposures', 'offline_exposure_resources',
      'audit_events', 'outbox_jobs', 'idempotency_records'];
    const result: Record<string, unknown> = {};
    for (const table of tables) result[table] = (await db.query(`SELECT to_jsonb(t) AS row FROM ${table} t WHERE organization_id=$1 ORDER BY to_jsonb(t)::text`, [org])).rows;
    return result;
  }
  async function denied(org: string, operation: () => Promise<unknown>, error: string | Record<string, unknown>) {
    const before = await snapshot(org);
    if (typeof error === 'string') await expect(operation()).rejects.toThrow(error);
    else await expect(operation()).rejects.toMatchObject(error);
    expect(await snapshot(org)).toEqual(before);
  }

  it.each(roles)('RF-21 authorizes inventory adjustment using actual %s membership and revalidates role changes', async role => {
    const f = await fixture(), inventory = new InventoryIncreaseService(tx);
    const input = { branchId: f.branch, itemId: f.item.id, quantity: '2.000', reason: 'CORRECCION' };
    if (role === 'OWNER' || role === 'ADMIN') {
      const key = randomUUID(), result = await inventory.confirm(f.context(role), input, key);
      expect(await inventory.confirm(f.context(role), input, key)).toEqual(result);
      expect((await db.query('SELECT quantity::text FROM branch_stocks WHERE branch_id=$1 AND item_id=$2', [f.branch, f.item.id])).rows).toEqual([{ quantity: '2.000' }]);
      if (role === 'ADMIN') {
        await db.query("UPDATE memberships SET role='CASHIER' WHERE id=$1", [f.members.ADMIN]);
        await denied(f.org, () => inventory.confirm(f.context(role), input, key), 'Ajuste de inventario no autorizado');
        await db.query("UPDATE memberships SET role='ADMIN' WHERE id=$1", [f.members.ADMIN]);
      }
    } else await denied(f.org, () => inventory.confirm(f.context(role), input, randomUUID()), 'Ajuste de inventario no autorizado');
    await denied(f.org, () => inventory.confirm(f.context('ADMIN'), { ...input, branchId: f.outside }, randomUUID()), 'Sucursal no autorizada');
    await denied(f.org, () => inventory.confirm(f.context('OWNER', f.foreign), input, randomUUID()), 'Ajuste de inventario no autorizado');
  });

  it.each(roles)('RF-21 POS quote rejects unauthorized real %s membership', async role => {
    const f = await fixture(), sales = new SalesOperationsService(tx);
    await new CatalogPriceService(tx).setPrice(f.context(), f.item.id, 1, '1.00');
    const lines = [{ itemId: f.item.id, quantity: '1.000' }];
    const operate = () => sales.quote(f.context(role), f.branch, lines);
    if (role === 'EMPLOYEE') await denied(f.org, operate, { code: 'SALE_QUOTE_FORBIDDEN' });
    else await expect(operate()).resolves.toMatchObject({ quote: { total: '1.00' } });
    if (role !== 'OWNER') {
      await db.query('DELETE FROM membership_branches WHERE membership_id=$1', [f.members[role]]);
      await denied(f.org, operate, { code: 'SALE_QUOTE_FORBIDDEN' });
    }
    await denied(f.org, () => sales.quote(f.foreignContext(), f.branch, lines), { code: 'SALE_QUOTE_FORBIDDEN' });
    await db.query("UPDATE memberships SET status='INACTIVE',deactivated_at=now() WHERE id=$1", [f.members[role]]);
    await denied(f.org, operate, { code: 'SALE_QUOTE_FORBIDDEN' });
  });

  const actionRoles = [
    { action: 'catalog-create', allowed: ['OWNER', 'ADMIN'], branch: false },
    { action: 'customer-create', allowed: ['OWNER', 'ADMIN', 'CASHIER'], branch: false },
    { action: 'supplier-create', allowed: ['OWNER', 'ADMIN'], branch: false },
    { action: 'adjustment', allowed: ['OWNER', 'ADMIN', 'EMPLOYEE'], branch: true },
    { action: 'threshold', allowed: ['OWNER', 'ADMIN', 'EMPLOYEE'], branch: true },
    { action: 'purchase-receive', allowed: ['OWNER', 'ADMIN', 'EMPLOYEE'], branch: true },
    { action: 'expense-transfer', allowed: ['OWNER', 'ADMIN'], branch: true },
    { action: 'cash-open', allowed: ['OWNER', 'ADMIN', 'CASHIER'], branch: true },
  ] as const;
  it.each(actionRoles.flatMap(entry => roles.map(role => ({ ...entry, role }))))(
    'RF-21 $role × $action uses backend membership, scope, tenant and inactive actor', async entry => {
      const f = await fixture();
      const category = await new ExpenseCategoryManagementService(tx).create(f.context(), { name: 'Expense' });
      await db.query("INSERT INTO payment_method_settings(organization_id,method,enabled) VALUES ($1,'TRANSFER',true) ON CONFLICT(organization_id,method) DO UPDATE SET enabled=true", [f.org]);
      const device = await new DeviceAuthorizationService(tx).authorizeOnline(f.context(), f.branch);
      const register = await new CashRegisterManagementService(tx).create(f.context(), { branchId: f.branch, name: 'Role register' });
      const operate = (organizationId = f.org, branchId = f.branch) => {
        const context = f.context(entry.role, organizationId), key = randomUUID();
        switch (entry.action) {
          case 'catalog-create': return new CatalogItemCreationService(tx).create(context, { name: randomUUID(), type: 'SERVICE' });
          case 'customer-create': return new CustomerManagementService(tx).create(context, { name: randomUUID() }, key);
          case 'supplier-create': return new SupplierManagementService(tx).create(context, { name: randomUUID() }, key);
          case 'adjustment': return new InventoryAdjustmentService(tx).confirm(context, { branchId, itemId: f.item.id, direction: 'INCREASE', quantity: '1.000', reason: 'CORRECCION' }, key);
          case 'threshold': return new StockThresholdService(tx).set(context, branchId, f.item.id, '1.000', key);
          case 'purchase-receive': return new PurchaseOperationsService(tx).confirmPending(context, { branchId, supplierId: f.supplier.id, clientOperationId: randomUUID(), lines: [{ itemId: f.item.id, quantity: '1.000', unitCost: '1.00' }] }, key);
          case 'expense-transfer': return new ExpenseOperationsService(tx).create(context, { branchId, categoryId: category.id, concept: 'Role expense', amount: '1.00', method: 'TRANSFER' }, key);
          case 'cash-open': return new CashOperationsService(tx).open(context, { branchId, cashRegisterId: register.id, deviceId: device.id, openingCash: '0.00' }, key);
        }
      };
      const error = (scope = false): string | Record<string, unknown> => {
        switch (entry.action) {
          case 'catalog-create': return { code: 'CATALOG_ITEM_CREATION_FORBIDDEN' };
          case 'customer-create': return { code: 'CUSTOMER_ACCESS_FORBIDDEN' };
          case 'supplier-create': return { code: 'SUPPLIER_ACCESS_FORBIDDEN' };
          case 'purchase-receive': return { code: 'PURCHASE_FORBIDDEN' };
          case 'expense-transfer': return { code: 'EXPENSE_FORBIDDEN' };
          case 'cash-open': return { code: 'CASH_OPENING_FORBIDDEN' };
          case 'adjustment': return scope ? 'Sucursal no autorizada' : 'Ajuste de inventario no autorizado';
          case 'threshold': return scope ? 'Sucursal no autorizada' : 'Stock no autorizado';
        }
      };
      // The same input family succeeds with a real allowed actor and fails for forbidden actors.
      if ((entry.allowed as readonly string[]).includes(entry.role)) await expect(operate()).resolves.toBeDefined();
      else await denied(f.org, () => operate(), error());
      if (entry.branch && entry.role !== 'OWNER') {
        // Remove scope rather than substitute non-existent resources; this proves authorization.
        await db.query('DELETE FROM membership_branches WHERE membership_id=$1', [f.members[entry.role]]);
        await denied(f.org, () => operate(), error((entry.allowed as readonly string[]).includes(entry.role)));
      }
      await denied(f.org, () => operate(f.foreign), error());
      await db.query("UPDATE memberships SET status='INACTIVE',deactivated_at=now() WHERE id=$1", [f.members[entry.role]]);
      await denied(f.org, () => operate(), error());
    });

  it.each(['resend', 'revoke'] as const)('RF-23 invitation %s cannot mutate a user spanning outside ADMIN scope', async action => {
    const f = await fixture();
    const invitation = await new InvitationCreationService(tx).create(f.context(), { email: `${randomUUID()}@example.com`, role: 'EMPLOYEE', branchIds: [f.branch, f.outside] }, randomUUID());
    const operate = (role: Role = 'ADMIN') => action === 'resend'
      ? new InvitationResendService(tx).resend(f.context(role), invitation.invitationId, randomUUID())
      : new InvitationRevocationService(tx).revoke(f.context(role), invitation.invitationId, randomUUID());
    await denied(f.org, () => operate(), { code: action === 'resend' ? 'INVITATION_RESEND_FORBIDDEN' : 'INVITATION_REVOCATION_FORBIDDEN' });
    await denied(f.org, () => operate('CASHIER'), { code: action === 'resend' ? 'INVITATION_RESEND_FORBIDDEN' : 'INVITATION_REVOCATION_FORBIDDEN' });
    await db.query('DELETE FROM invitation_branches WHERE invitation_id=$1 AND branch_id=$2', [invitation.invitationId, f.outside]);
    await expect(operate()).resolves.toMatchObject({ invitationId: invitation.invitationId });
  });

  it.each(['resend', 'revoke'] as const)('RF-23 invitation %s revalidates authorization on replay and denies OWNER targets', async action => {
    const f = await fixture(), create = new InvitationCreationService(tx);
    const invitation = await create.create(f.context(), { email: `${randomUUID()}@example.com`, role: 'EMPLOYEE', branchIds: [f.branch] }, randomUUID());
    const ownerInvitation = await create.create(f.context(), { email: `${randomUUID()}@example.com`, role: 'OWNER', branchIds: [] }, randomUUID());
    const key = randomUUID(), code = { code: action === 'resend' ? 'INVITATION_RESEND_FORBIDDEN' : 'INVITATION_REVOCATION_FORBIDDEN' };
    const operate = (id = invitation.invitationId, context = f.context('ADMIN')) => action === 'resend'
      ? new InvitationResendService(tx).resend(context, id, key)
      : new InvitationRevocationService(tx).revoke(context, id, key);
    await denied(f.org, () => operate(ownerInvitation.invitationId), code);
    await denied(f.org, () => operate(invitation.invitationId, f.foreignContext()), code);
    const first = await operate(); expect(await operate()).toEqual(first);
    await db.query('DELETE FROM membership_branches WHERE membership_id=$1', [f.members.ADMIN]);
    await denied(f.org, () => operate(), code);
    await db.query('INSERT INTO membership_branches(organization_id,membership_id,branch_id) VALUES ($1,$2,$3)', [f.org, f.members.ADMIN, f.branch]);
    await db.query("UPDATE memberships SET status='INACTIVE',deactivated_at=now() WHERE id=$1", [f.members.ADMIN]);
    await denied(f.org, () => operate(), code);
  });

  it.each(['create', 'rename', 'deactivate'] as const)('RF-23 ADMIN cash-register %s enforces real scope, role, tenant and active branch', async action => {
    const f = await fixture(), service = new CashRegisterManagementService(tx);
    const assigned = await service.create(f.context(), { branchId: f.branch, name: 'Assigned register' });
    const outside = await service.create(f.context(), { branchId: f.outside, name: 'Outside register' });
    const operate = (register = assigned, context = f.context('ADMIN'), version = 1) => {
      if (action === 'create') return service.create(context, { branchId: register.branchId, name: randomUUID() });
      if (action === 'rename') return service.rename(context, register.id, { expectedVersion: version, name: randomUUID() });
      return service.deactivate(context, register.id, version);
    };
    await denied(f.org, () => operate(outside), { code: 'CASH_REGISTER_BRANCH_FORBIDDEN' });
    await denied(f.org, () => operate(assigned, f.context('CASHIER')), { code: 'CASH_REGISTER_MANAGEMENT_FORBIDDEN' });
    await denied(f.org, () => operate(assigned, f.foreignContext()), { code: 'CASH_REGISTER_MANAGEMENT_FORBIDDEN' });
    await expect(operate()).resolves.toBeDefined();
    await db.query("UPDATE branches SET status='INACTIVE' WHERE id=$1", [f.branch]);
    await denied(f.org, () => operate(assigned, f.context('ADMIN'), 2), { code: 'CASH_REGISTER_BRANCH_NOT_AVAILABLE' });
  });

  it.each(['changeRole', 'setStatus', 'revoke'] as const)('RF-23 ADMIN %s only for non-owners entirely within scope', async action => {
    const f = await fixture(), service = new MembershipAdministrationService(tx);
    const operation = (target: string, branchIds = [f.branch], role: Role = 'ADMIN') => {
      if (action === 'changeRole') return service.changeRole(f.context(role), target, { expectedVersion: 1, role: 'CASHIER', branchIds }, randomUUID());
      if (action === 'setStatus') return service.setStatus(f.context(role), target, { expectedVersion: 1, status: 'INACTIVE' }, randomUUID());
      return service.revoke(f.context(role), target, 1, randomUUID());
    };
    await denied(f.org, () => operation(f.members.OWNER), { code: 'OWNER_MEMBERSHIP_FORBIDDEN' });
    await db.query('INSERT INTO membership_branches(organization_id,membership_id,branch_id) VALUES ($1,$2,$3)', [f.org, f.members.EMPLOYEE, f.outside]);
    await denied(f.org, () => operation(f.members.EMPLOYEE), { code: 'MEMBERSHIP_BRANCH_SCOPE_FORBIDDEN' });
    await db.query('DELETE FROM membership_branches WHERE membership_id=$1 AND branch_id=$2', [f.members.EMPLOYEE, f.outside]);
    const foreignMember = randomUUID();
    await db.query("INSERT INTO memberships(id,organization_id,user_id,role) VALUES ($1,$2,$3,'EMPLOYEE')", [foreignMember, f.foreign, f.users.EMPLOYEE]);
    await denied(f.org, () => operation(foreignMember), { code: 'MEMBERSHIP_NOT_MUTABLE' });
    if (action === 'changeRole') await denied(f.org, () => operation(f.members.EMPLOYEE, [f.foreignBranch]), { code: 'MEMBERSHIP_BRANCH_INVALID' });
    await denied(f.org, () => operation(f.members.EMPLOYEE, [f.branch], 'CASHIER'), { code: 'MEMBERSHIP_MANAGEMENT_FORBIDDEN' });
    await db.query("UPDATE memberships SET status='INACTIVE',deactivated_at=now() WHERE id=$1", [f.members.ADMIN]);
    await denied(f.org, () => operation(f.members.EMPLOYEE), { code: 'MEMBERSHIP_NOT_MUTABLE' });
    await db.query("UPDATE memberships SET status='ACTIVE',deactivated_at=NULL WHERE id=$1", [f.members.ADMIN]);
    await expect(operation(f.members.EMPLOYEE)).resolves.toMatchObject({ version: 2 });
  });

  it('RF-23 invitations validate assigned, outside, foreign and inactive branches with persisted ADMIN', async () => {
    const f = await fixture(), invitations = new InvitationCreationService(tx);
    const create = (branchId: string, role: Role = 'ADMIN') => invitations.create(f.context(role), { email: `${randomUUID()}@example.com`, role: 'EMPLOYEE', branchIds: [branchId] }, randomUUID());
    await expect(create(f.branch)).resolves.toMatchObject({ invitationId: expect.any(String) });
    await denied(f.org, () => create(f.outside), 'alcance');
    await denied(f.org, () => create(f.foreignBranch), 'sucursal');
    await denied(f.org, () => create(f.branch, 'EMPLOYEE'), { code: 'MEMBERSHIP_MANAGEMENT_FORBIDDEN' });
    await db.query("UPDATE branches SET status='INACTIVE' WHERE id=$1", [f.branch]);
    await denied(f.org, () => create(f.branch), 'activa');
  });

  it.each(['OWNER', 'ADMIN'] as const)('RF-93 %s opens, moves cash and completes signed close only with current scope', async role => {
    const f = await fixture(), cash = new CashOperationsService(tx), close = new CashCloseService(tx);
    const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    async function prepare(branchId: string) {
      const device = await new DeviceAuthorizationService(tx).authorizeOnline(f.context(), branchId), register = randomUUID();
      await db.query('UPDATE devices SET public_key=$1 WHERE id=$2', [pair.publicKey.export({ format: 'pem', type: 'spki' }).toString(), device.id]);
      await db.query('INSERT INTO cash_registers(id,organization_id,branch_id,name) VALUES ($1,$2,$3,$4)', [register, f.org, branchId, register]);
      return { branchId, cashRegisterId: register, deviceId: device.id, openingCash: '10.00' };
    }
    const input = await prepare(f.branch), other = await prepare(f.outside);
    if (role === 'ADMIN') await denied(f.org, () => cash.open(f.context(role), other, randomUUID()), { code: 'CASH_OPENING_FORBIDDEN' });
    else await expect(cash.open(f.context(role), other, randomUUID())).resolves.toMatchObject({ branchId: f.outside });
    await denied(f.org, () => cash.open(f.context('EMPLOYEE'), input, randomUUID()), { code: 'CASH_OPENING_FORBIDDEN' });
    await denied(f.org, () => cash.open(f.context(role, f.foreign), input, randomUUID()), { code: 'CASH_OPENING_FORBIDDEN' });
    const session = await cash.open(f.context(role), input, randomUUID());
    const movement = { cashSessionId: session.id, deviceId: input.deviceId, amount: '1.00', reason: 'Matrix' };
    for (const command of [() => cash.deposit(f.foreignContext(), movement, randomUUID()), () => cash.withdraw(f.foreignContext(), movement, randomUUID()),
      () => cash.deposit(f.context('EMPLOYEE'), movement, randomUUID()), () => cash.withdraw(f.context('EMPLOYEE'), movement, randomUUID())]) {
      await denied(f.org, command, { code: 'CASH_SESSION_ACTOR_FORBIDDEN' });
    }
    await cash.deposit(f.context(role), movement, randomUUID()); await cash.withdraw(f.context(role), movement, randomUUID());
    const checkpoint = { version: 1 as const, organizationId: f.org, deviceId: input.deviceId,
      actorUserId: f.users[role], sessionId: session.id, sequence: '0', headHash: '0'.repeat(64),
      sessionSequence: '0', creationFrozen: true as const, pending: 0 as const };
    const proof = { checkpoint, signature: sign('sha256', Buffer.from(JSON.stringify(checkpoint)), { key: pair.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64') };
    const foreignCheckpoint = { ...checkpoint, actorUserId: f.foreignContext().userId };
    const foreignProof = { checkpoint: foreignCheckpoint, signature: sign('sha256', Buffer.from(JSON.stringify(foreignCheckpoint)), { key: pair.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64') };
    await denied(f.org, () => close.begin(f.foreignContext(), foreignProof, randomUUID()), { code: 'CASH_SESSION_ACTOR_FORBIDDEN' });
    if (role === 'ADMIN') await db.query('DELETE FROM membership_branches WHERE membership_id=$1', [f.members.ADMIN]);
    else await db.query("UPDATE memberships SET status='INACTIVE',deactivated_at=now() WHERE id=$1", [f.members.OWNER]);
    for (const command of [() => cash.deposit(f.context(role), movement, randomUUID()), () => cash.withdraw(f.context(role), movement, randomUUID()), () => close.begin(f.context(role), proof, randomUUID())]) {
      await denied(f.org, command, { code: 'CASH_SESSION_ACTOR_FORBIDDEN' });
    }
    if (role === 'ADMIN') await db.query('INSERT INTO membership_branches(organization_id,membership_id,branch_id) VALUES ($1,$2,$3)', [f.org, f.members.ADMIN, f.branch]);
    else await db.query("UPDATE memberships SET status='ACTIVE',deactivated_at=NULL WHERE id=$1", [f.members.OWNER]);
    const attempt = await close.begin(f.context(role), proof, randomUUID());
    const closing = { cashSessionId: session.id, deviceId: input.deviceId, closeAttemptId: attempt.closeAttemptId };
    await close.finalSync(f.context(role), closing, randomUUID());
    const finalRequest = { ...closing, expectedCash: '10.00', countedCash: '10.00', reason: '' };
    await db.query("UPDATE memberships SET status='INACTIVE',deactivated_at=now() WHERE id=$1", [f.members[role]]);
    await denied(f.org, () => close.close(f.context(role), finalRequest, randomUUID()), { code: 'CASH_SESSION_ACTOR_FORBIDDEN' });
    await db.query("UPDATE memberships SET status='ACTIVE',deactivated_at=NULL WHERE id=$1", [f.members[role]]);
    await denied(f.org, () => close.close(f.foreignContext(), finalRequest, randomUUID()), { code: 'CASH_SESSION_ACTOR_FORBIDDEN' });
    await denied(f.org, () => close.close(f.context('EMPLOYEE'), finalRequest, randomUUID()), { code: 'CASH_SESSION_ACTOR_FORBIDDEN' });
    if (role === 'ADMIN') {
      await db.query('DELETE FROM membership_branches WHERE membership_id=$1', [f.members.ADMIN]);
      await denied(f.org, () => close.close(f.context(role), finalRequest, randomUUID()), { code: 'CASH_SESSION_ACTOR_FORBIDDEN' });
      await db.query('INSERT INTO membership_branches(organization_id,membership_id,branch_id) VALUES ($1,$2,$3)', [f.org, f.members.ADMIN, f.branch]);
    }
    await expect(close.close(f.context(role), { ...closing, expectedCash: '10.00', countedCash: '10.00', reason: '' }, randomUUID())).resolves.toMatchObject({ status: 'CLOSED', difference: '0.00' });
  });

  it.each(['inventory-increase', 'inventory-decrease', 'transfer-out', 'transfer-in', 'threshold', 'purchase', 'expense', 'cash-register', 'device', 'cash-open'] as const)(
    'RF-29 rejects new %s after real deactivation and preserves history', async action => {
      const f = await fixture(), inventory = new InventoryIncreaseService(tx);
      await inventory.confirm(f.context(), { branchId: f.branch, itemId: f.item.id, quantity: '5.000', reason: 'INVENTARIO_INICIAL' }, randomUUID());
      const device = await new DeviceAuthorizationService(tx).authorizeOnline(f.context(), f.branch);
      const register = await new CashRegisterManagementService(tx).create(f.context(), { branchId: f.branch, name: 'Register' });
      const category = await new ExpenseCategoryManagementService(tx).create(f.context(), { name: 'Category' });
      await db.query("INSERT INTO payment_method_settings(organization_id,method,enabled) VALUES ($1,'TRANSFER',true) ON CONFLICT(organization_id,method) DO UPDATE SET enabled=true", [f.org]);
      const context = f.context('ADMIN');
      const operation = () => {
        switch (action) {
          case 'inventory-increase': return inventory.confirm(context, { branchId: f.branch, itemId: f.item.id, quantity: '1.000', reason: 'CORRECCION' }, randomUUID());
          case 'inventory-decrease': return new InventoryAdjustmentService(tx).confirm(context, { branchId: f.branch, itemId: f.item.id, quantity: '1.000', direction: 'DECREASE', reason: 'CORRECCION' }, randomUUID());
          case 'transfer-out': return new InventoryTransferService(tx).confirm(f.context(), { originBranchId: f.branch, destinationBranchId: f.outside, lines: [{ itemId: f.item.id, quantity: '1.000' }] }, randomUUID());
          case 'transfer-in': return new InventoryTransferService(tx).confirm(f.context(), { originBranchId: f.outside, destinationBranchId: f.branch, lines: [{ itemId: f.item.id, quantity: '1.000' }] }, randomUUID());
          case 'threshold': return new StockThresholdService(tx).set(context, f.branch, f.item.id, '1.000', randomUUID());
          case 'purchase': return new PurchaseOperationsService(tx).confirmPending(context, { branchId: f.branch, supplierId: f.supplier.id, clientOperationId: randomUUID(), lines: [{ itemId: f.item.id, quantity: '1.000', unitCost: '1.00' }] }, randomUUID());
          case 'expense': return new ExpenseOperationsService(tx).create(context, { branchId: f.branch, categoryId: category.id, concept: 'Expense', amount: '1.00', method: 'TRANSFER' }, randomUUID());
          case 'cash-register': return new CashRegisterManagementService(tx).create(context, { branchId: f.branch, name: randomUUID() });
          case 'device': return new DeviceAuthorizationService(tx).authorizeOnline(context, f.branch);
          case 'cash-open': return new CashOperationsService(tx).open(context, { branchId: f.branch, cashRegisterId: register.id, deviceId: device.id, openingCash: '0.00' }, randomUUID());
        }
      };
      if (action === 'transfer-in') await inventory.confirm(f.context(), { branchId: f.outside, itemId: f.item.id, quantity: '2.000', reason: 'INVENTARIO_INICIAL' }, randomUUID());
      const allowed = await operation();
      expect(allowed).toBeDefined();
      if (action === 'cash-open') {
        const session = z.object({ id: z.uuid() }).parse(allowed), pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
        await db.query('UPDATE devices SET public_key=$1 WHERE id=$2', [pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(), device.id]);
        const checkpoint = { version: 1 as const, organizationId: f.org, deviceId: device.id, actorUserId: f.users.ADMIN,
          sessionId: session.id, sequence: '0', headHash: '0'.repeat(64), sessionSequence: '0', creationFrozen: true as const, pending: 0 as const };
        const closes = new CashCloseService(tx), attempt = await closes.begin(context, { checkpoint,
          signature: sign('sha256', Buffer.from(JSON.stringify(checkpoint)), { key: pair.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64') }, randomUUID());
        const closing = { cashSessionId: session.id, deviceId: device.id, closeAttemptId: attempt.closeAttemptId };
        await closes.finalSync(context, closing, randomUUID());
        await closes.close(context, { ...closing, expectedCash: '0.00', countedCash: '0.00', reason: '' }, randomUUID());
      }
      const history = (await db.query('SELECT * FROM inventory_movements WHERE branch_id=$1 ORDER BY id', [f.branch])).rows;
      const beforeDeactivation = await snapshot(f.org);
      delete beforeDeactivation.audit_events; delete beforeDeactivation.idempotency_records;
      await expect(new BranchDeactivationService(tx).deactivate(f.context(), f.branch, 1, randomUUID())).resolves.toMatchObject({ status: 'INACTIVE' });
      const afterDeactivation = await snapshot(f.org);
      delete afterDeactivation.audit_events; delete afterDeactivation.idempotency_records;
      expect(afterDeactivation).toEqual(beforeDeactivation);
      const expected = action === 'purchase' ? { code: 'PURCHASE_FORBIDDEN' } : action === 'expense' ? { code: 'EXPENSE_FORBIDDEN' }
        : action === 'cash-register' ? { code: 'CASH_REGISTER_BRANCH_NOT_AVAILABLE' } : action === 'device' ? { code: 'DEVICE_BRANCH_NOT_AVAILABLE' }
        : action === 'cash-open' ? { code: 'CASH_OPENING_REGISTER_NOT_AVAILABLE' } : action.startsWith('transfer') ? 'Sucursales no autorizadas' : 'Sucursal no autorizada';
      await denied(f.org, operation, expected);
      expect((await db.query('SELECT * FROM inventory_movements WHERE branch_id=$1 ORDER BY id', [f.branch])).rows).toEqual(history);
    });

  it('RF-220 ADMIN edits global customer/supplier then is denied a real purchase outside scope', async () => {
    const f = await fixture(), customers = new CustomerManagementService(tx), suppliers = new SupplierManagementService(tx), purchases = new PurchaseOperationsService(tx);
    const customer = await customers.create(f.context('ADMIN'), { name: 'Global customer' }, randomUUID());
    const supplier = await suppliers.create(f.context('ADMIN'), { name: 'Global supplier' }, randomUUID());
    await expect(customers.update(f.context('ADMIN'), customer.id, 1, { notes: 'Global administration' }, randomUUID())).resolves.toMatchObject({ version: 2 });
    await expect(suppliers.update(f.context('ADMIN'), supplier.id, 1, { notes: 'Global administration' }, randomUUID())).resolves.toMatchObject({ version: 2 });
      for (const context of [f.context('EMPLOYEE'), f.foreignContext()]) {
        await denied(f.org, () => customers.update(context, customer.id, 2, { notes: 'Denied' }, randomUUID()), { code: 'CUSTOMER_ACCESS_FORBIDDEN' });
        await denied(f.org, () => suppliers.update(context, supplier.id, 2, { notes: 'Denied' }, randomUUID()), { code: 'SUPPLIER_ACCESS_FORBIDDEN' });
      }
      await db.query("UPDATE memberships SET status='INACTIVE',deactivated_at=now() WHERE id=$1", [f.members.ADMIN]);
      await denied(f.org, () => customers.update(f.context('ADMIN'), customer.id, 2, { notes: 'Inactive' }, randomUUID()), { code: 'CUSTOMER_ACCESS_FORBIDDEN' });
      await denied(f.org, () => suppliers.update(f.context('ADMIN'), supplier.id, 2, { notes: 'Inactive' }, randomUUID()), { code: 'SUPPLIER_ACCESS_FORBIDDEN' });
      await db.query("UPDATE memberships SET status='ACTIVE',deactivated_at=NULL WHERE id=$1", [f.members.ADMIN]);
    const input = { branchId: f.branch, supplierId: supplier.id, clientOperationId: randomUUID(), lines: [{ itemId: f.item.id, quantity: '1.000', unitCost: '2.00' }] };
    await expect(purchases.confirmPending(f.context('ADMIN'), input, randomUUID())).resolves.toMatchObject({ total: '2.00' });
    await denied(f.org, () => purchases.confirmPending(f.context('ADMIN'), { ...input, branchId: f.outside, clientOperationId: randomUUID() }, randomUUID()), { code: 'PURCHASE_FORBIDDEN' });
    await denied(f.org, () => purchases.confirmPending(f.context('ADMIN', f.foreign), input, randomUUID()), { code: 'PURCHASE_FORBIDDEN' });
    expect((await db.query('SELECT name FROM customers WHERE id=$1', [customer.id])).rows).toEqual([{ name: 'Global customer' }]);
    expect((await db.query('SELECT name FROM suppliers WHERE id=$1', [supplier.id])).rows).toEqual([{ name: 'Global supplier' }]);
    const device = await new DeviceAuthorizationService(tx).authorizeOnline(f.context(), f.outside);
    const register = await new CashRegisterManagementService(tx).create(f.context(), { branchId: f.outside, name: 'Outside register' });
    const session = await new CashOperationsService(tx).open(f.context(), { branchId: f.outside, cashRegisterId: register.id, deviceId: device.id, openingCash: '0.00' }, randomUUID());
    await new CatalogPriceService(tx).setPrice(f.context(), f.item.id, 1, '1.00');
    const sales = new SalesOperationsService(tx), lines = [{ itemId: f.item.id, quantity: '1.000' }];
    const quote = await sales.quote(f.context(), f.outside, lines);
    await denied(f.org, () => sales.confirm(f.context('ADMIN'), { branchId: f.outside, cashSessionId: session.id, deviceId: device.id,
      clientOperationId: randomUUID(), customerId: customer.id, lines, quoteFingerprint: quote.quoteFingerprint, payments: [{ method: 'CASH', appliedAmount: '1.00', receivedAmount: '1.00' }] }, randomUUID()), { code: 'CASH_SESSION_ACTOR_FORBIDDEN' });
  });

  it.each(roles)('RF-116 bootstrap revalidates %s membership, branch scope, tenant and inactive device', async role => {
    const f = await fixture(), signing = bootstrapSigning, rsa = bootstrapRsa;
    const publicKeyPem = signing.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const device = await new DeviceAuthorizationService(tx).authorizePos(f.context(), f.branch, publicKeyPem, randomUUID(), new DeviceCertificate(randomBytes(32)));
    const signer = { keyId: 'trusted', publicKeyPem, sign: (payload: string) => sign('sha256', Buffer.from(payload), signing.privateKey).toString('base64') };
    const custody = new RsaSyncEnvelopeDecryptor({ activeKeyId: 'test', keys: { test: rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() } }, signing.privateKey, 'trusted');
    const service = new OfflineBootstrapService(tx, signer, custody), input = { branchId: f.branch, deviceId: device.id };
    const rejected = { code: 'OFFLINE_BOOTSTRAP_FORBIDDEN' };
    await denied(f.org, () => service.issue(f.foreignContext(), input, randomUUID()), rejected);
    if (role === 'EMPLOYEE') await denied(f.org, () => service.issue(f.context(role), input, randomUUID()), rejected);
    else await expect(service.issue(f.context(role), input, randomUUID())).resolves.toMatchObject({ signingKeyId: 'trusted' });
    await denied(f.org, () => service.issue(f.context(role, f.foreign), input, randomUUID()), rejected);
    if (role !== 'OWNER') {
      await db.query('DELETE FROM membership_branches WHERE membership_id=$1', [f.members[role]]);
      await denied(f.org, () => service.issue(f.context(role), input, randomUUID()), rejected);
      await db.query('INSERT INTO membership_branches(organization_id,membership_id,branch_id) VALUES ($1,$2,$3)', [f.org, f.members[role], f.branch]);
    }
    await db.query("UPDATE devices SET status='REVOKED' WHERE id=$1", [device.id]);
    await denied(f.org, () => service.issue(f.context(role), input, randomUUID()), rejected);
    await db.query("UPDATE devices SET status='ACTIVE' WHERE id=$1", [device.id]);
    await db.query("UPDATE branches SET status='INACTIVE' WHERE id=$1", [f.branch]);
    await denied(f.org, () => service.issue(f.context(role), input, randomUUID()), rejected);
    await db.query("UPDATE branches SET status='ACTIVE' WHERE id=$1", [f.branch]);
    await db.query("UPDATE memberships SET status='INACTIVE',deactivated_at=now() WHERE id=$1", [f.members[role]]);
    await denied(f.org, () => service.issue(f.context(role), input, randomUUID()), rejected);
  });

  it('RF-285 backend rejects foreign item, supplier and transfer branch without any effects', async () => {
    const f = await fixture(), foreignItem = randomUUID(), foreignSupplier = randomUUID();
    await db.query("INSERT INTO catalog_items(id,organization_id,name,type,track_inventory,base_unit) VALUES ($1,$2,'Foreign','PRODUCT',true,'UNIT')", [foreignItem, f.foreign]);
    await db.query("INSERT INTO suppliers(id,organization_id,name) VALUES ($1,$2,'Foreign')", [foreignSupplier, f.foreign]);
    const inventory = new InventoryIncreaseService(tx), purchases = new PurchaseOperationsService(tx), transfers = new InventoryTransferService(tx);
    const adjustment = { branchId: f.branch, itemId: f.item.id, quantity: '2.000', reason: 'CORRECCION' };
    const purchase = { branchId: f.branch, supplierId: f.supplier.id, clientOperationId: randomUUID(), lines: [{ itemId: f.item.id, quantity: '1.000', unitCost: '1.00' }] };
    await denied(f.org, () => inventory.confirm(f.context('ADMIN'), { ...adjustment, itemId: foreignItem }, randomUUID()), 'Producto inventariable no disponible');
    await denied(f.org, () => purchases.confirmPending(f.context('ADMIN'), { ...purchase, supplierId: foreignSupplier }, randomUUID()), 'proveedor');
    for (const context of [f.context('CASHIER'), f.foreignContext()]) {
      await denied(f.org, () => inventory.confirm(context, adjustment, randomUUID()), 'Ajuste de inventario no autorizado');
      await denied(f.org, () => purchases.confirmPending(context, purchase, randomUUID()), { code: 'PURCHASE_FORBIDDEN' });
    }
    await denied(f.org, () => inventory.confirm(f.context('ADMIN'), { ...adjustment, branchId: f.outside }, randomUUID()), 'Sucursal no autorizada');
    await denied(f.org, () => purchases.confirmPending(f.context('ADMIN'), { ...purchase, branchId: f.outside }, randomUUID()), { code: 'PURCHASE_FORBIDDEN' });
    await db.query("UPDATE memberships SET status='INACTIVE',deactivated_at=now() WHERE id=$1", [f.members.ADMIN]);
    await denied(f.org, () => inventory.confirm(f.context('ADMIN'), adjustment, randomUUID()), 'Ajuste de inventario no autorizado');
    await denied(f.org, () => purchases.confirmPending(f.context('ADMIN'), purchase, randomUUID()), { code: 'PURCHASE_FORBIDDEN' });
    await db.query("UPDATE memberships SET status='ACTIVE',deactivated_at=NULL WHERE id=$1", [f.members.ADMIN]);
    await inventory.confirm(f.context('ADMIN'), adjustment, randomUUID());
    await expect(purchases.confirmPending(f.context('ADMIN'), purchase, randomUUID())).resolves.toMatchObject({ total: '1.00' });
    await denied(f.org, () => transfers.confirm(f.context('ADMIN'), { originBranchId: f.branch, destinationBranchId: f.outside, lines: [{ itemId: f.item.id, quantity: '1.000' }] }, randomUUID()), 'Sucursales no autorizadas');
    await denied(f.org, () => transfers.confirm(f.context(), { originBranchId: f.branch, destinationBranchId: f.foreignBranch, lines: [{ itemId: f.item.id, quantity: '1.000' }] }, randomUUID()), 'Sucursales no autorizadas');
    await expect(transfers.confirm(f.context(), { originBranchId: f.branch, destinationBranchId: f.outside, lines: [{ itemId: f.item.id, quantity: '1.000' }] }, randomUUID())).resolves.toMatchObject({ destinationBranchId: f.outside });
  });

  it('RF-29 new sale revalidates inactive branch while preserving confirmed sale and ledger', async () => {
    const f = await fixture(), sales = new SalesOperationsService(tx), cash = new CashOperationsService(tx);
    await new InventoryIncreaseService(tx).confirm(f.context(), { branchId: f.branch, itemId: f.item.id, quantity: '5.000', reason: 'INVENTARIO_INICIAL' }, randomUUID());
    await new CatalogPriceService(tx).setPrice(f.context(), f.item.id, 1, '1.00');
    await db.query("INSERT INTO payment_method_settings(organization_id,method,enabled) VALUES ($1,'CASH',true) ON CONFLICT(organization_id,method) DO UPDATE SET enabled=true", [f.org]);
    const device = await new DeviceAuthorizationService(tx).authorizeOnline(f.context(), f.branch);
    const register = await new CashRegisterManagementService(tx).create(f.context(), { branchId: f.branch, name: 'Sales' });
    const session = await cash.open(f.context(), { branchId: f.branch, cashRegisterId: register.id, deviceId: device.id, openingCash: '0.00' }, randomUUID());
    const lines = [{ itemId: f.item.id, quantity: '1.000' }], quote = await sales.quote(f.context(), f.branch, lines);
    const input = { branchId: f.branch, cashSessionId: session.id, deviceId: device.id, clientOperationId: randomUUID(),
      lines, quoteFingerprint: quote.quoteFingerprint, payments: [{ method: 'CASH', appliedAmount: '1.00', receivedAmount: '1.00' }] };
    await expect(sales.confirm(f.context(), input, randomUUID())).resolves.toMatchObject({ total: '1.00' });
    // Defensive state test: an existing operational session must not bypass branch state.
    // Normal deactivation with sessions is separately proven to be blocked by T221.
    await db.query("UPDATE branches SET status='INACTIVE' WHERE id=$1", [f.branch]);
    await denied(f.org, () => sales.confirm(f.context(), { ...input, clientOperationId: randomUUID() }, randomUUID()), { code: 'SALE_BRANCH_NOT_FOUND' });
  });

  it('RF-285 a foreign customer cannot be attached to a sale with otherwise valid tenant session/items', async () => {
    const f = await fixture(), sales = new SalesOperationsService(tx);
    const customer = await new CustomerManagementService(tx).create(f.context('ADMIN'), { name: 'Local customer' }, randomUUID());
    const foreignCustomer = randomUUID();
    await db.query("INSERT INTO customers(id,organization_id,name) VALUES ($1,$2,'Foreign customer')", [foreignCustomer, f.foreign]);
    await new InventoryIncreaseService(tx).confirm(f.context(), { branchId: f.branch, itemId: f.item.id, quantity: '5.000', reason: 'INVENTARIO_INICIAL' }, randomUUID());
    await new CatalogPriceService(tx).setPrice(f.context(), f.item.id, 1, '1.00');
    await db.query("INSERT INTO payment_method_settings(organization_id,method,enabled) VALUES ($1,'CASH',true) ON CONFLICT(organization_id,method) DO UPDATE SET enabled=true", [f.org]);
    const device = await new DeviceAuthorizationService(tx).authorizeOnline(f.context(), f.branch), register = await new CashRegisterManagementService(tx).create(f.context(), { branchId: f.branch, name: 'Customer relation' });
    const session = await new CashOperationsService(tx).open(f.context(), { branchId: f.branch, cashRegisterId: register.id, deviceId: device.id, openingCash: '0.00' }, randomUUID());
    const lines = [{ itemId: f.item.id, quantity: '1.000' }], quote = await sales.quote(f.context(), f.branch, lines);
    const input = { branchId: f.branch, cashSessionId: session.id, deviceId: device.id, clientOperationId: randomUUID(),
      lines, quoteFingerprint: quote.quoteFingerprint, payments: [{ method: 'CASH', appliedAmount: '1.00', receivedAmount: '1.00' }] };
    const localInput = { ...input, customerId: customer.id };
    await denied(f.org, () => sales.confirm(f.context(), { ...localInput, customerId: foreignCustomer }, randomUUID()), { code: 'SALE_CUSTOMER_NOT_AVAILABLE' });
    for (const context of [f.context('EMPLOYEE'), f.foreignContext()]) await denied(f.org, () => sales.confirm(context, input, randomUUID()), { code: 'CASH_SESSION_ACTOR_FORBIDDEN' });
    await db.query('DELETE FROM membership_branches WHERE membership_id=$1', [f.members.ADMIN]);
    await denied(f.org, () => sales.confirm(f.context('ADMIN'), input, randomUUID()), { code: 'CASH_SESSION_ACTOR_FORBIDDEN' });
    await db.query('INSERT INTO membership_branches(organization_id,membership_id,branch_id) VALUES ($1,$2,$3)', [f.org, f.members.ADMIN, f.branch]);
    await db.query("UPDATE memberships SET status='INACTIVE',deactivated_at=now() WHERE id=$1", [f.members.ADMIN]);
    await denied(f.org, () => sales.confirm(f.context('ADMIN'), input, randomUUID()), { code: 'CASH_SESSION_ACTOR_FORBIDDEN' });
    await db.query("UPDATE memberships SET status='ACTIVE',deactivated_at=NULL WHERE id=$1", [f.members.ADMIN]);
    await expect(sales.confirm(f.context('ADMIN'), localInput, randomUUID())).resolves.toMatchObject({ total: '1.00' });
  });
});
