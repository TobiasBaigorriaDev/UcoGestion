import { randomUUID } from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AuditEventWriter } from '../src/core/audit/audit-event-writer.js';
import { runMigrations } from '../src/database/migrate.js';
import { TenantTransaction } from '../src/database/tenant-transaction.js';
import { AuditQueryService } from '../src/modules/audit/audit-query.service.js';

describe('audit query', () => {
  let container: StartedPostgreSqlContainer;
  let ownerPool: Pool;
  let runtimePool: Pool;
  let service: AuditQueryService;
  const organizationId = randomUUID();
  const otherOrganizationId = randomUUID();
  const branchId = randomUUID();
  const otherBranchId = randomUUID();
  const ownerId = randomUUID();
  const adminId = randomUUID();
  const adminMembershipId = randomUUID();
  const cashierMembershipId = randomUUID();
  const employeeMembershipId = randomUUID();
  const cashierId = randomUUID();
  const employeeId = randomUUID();

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    await runMigrations(container.getConnectionUri());
    ownerPool = new Pool({ connectionString: container.getConnectionUri() });
    await ownerPool.query("CREATE ROLE audit_runtime LOGIN PASSWORD 'runtime-password' IN ROLE uco_app");
    const runtimeUrl = new URL(container.getConnectionUri());
    runtimeUrl.username = 'audit_runtime';
    runtimeUrl.password = 'runtime-password';
    runtimePool = new Pool({ connectionString: runtimeUrl.toString() });
    service = new AuditQueryService(new TenantTransaction(runtimePool));
    await ownerPool.query(`INSERT INTO organizations (id, name, base_currency, timezone) VALUES
      ($1, 'Audit A', 'ARS', 'America/Argentina/Mendoza'),
      ($2, 'Audit B', 'ARS', 'America/Argentina/Mendoza')`, [organizationId, otherOrganizationId]);
    await ownerPool.query("INSERT INTO branches (id, organization_id, name) VALUES ($1, $2, 'Centro'), ($3, $2, 'Norte')",
      [branchId, organizationId, otherBranchId]);
    await ownerPool.query(`INSERT INTO users (id, email_normalized, password_hash, password_hash_version) VALUES
      ($1, 'audit-owner@example.com', '$argon2id$v=19$owner', 1),
      ($2, 'audit-cashier@example.com', '$argon2id$v=19$cashier', 1),
      ($3, 'audit-employee@example.com', '$argon2id$v=19$employee', 1),
      ($4, 'audit-admin@example.com', '$argon2id$v=19$admin', 1)`,
    [ownerId, cashierId, employeeId, adminId]);
    await ownerPool.query(`INSERT INTO memberships (id, organization_id, user_id, role) VALUES
      ($1, $2, $3, 'OWNER'), ($4, $2, $5, 'CASHIER'), ($6, $2, $7, 'EMPLOYEE'),
      ($8, $2, $9, 'ADMIN')`,
    [randomUUID(), organizationId, ownerId, cashierMembershipId, cashierId,
      employeeMembershipId, employeeId,
      adminMembershipId, adminId]);
    await ownerPool.query(`INSERT INTO memberships (id,organization_id,user_id,role)
      VALUES ($1,$2,$3,'OWNER')`, [randomUUID(), otherOrganizationId, ownerId]);
    await ownerPool.query(`INSERT INTO membership_branches (organization_id, membership_id, branch_id)
      VALUES ($1,$2,$3)`, [organizationId, adminMembershipId, branchId]);
    await ownerPool.query(`INSERT INTO membership_branches (organization_id,membership_id,branch_id)
      VALUES ($1,$2,$4),($1,$3,$5)`,
    [organizationId, cashierMembershipId, employeeMembershipId, branchId, otherBranchId]);
    const invitationId = randomUUID();
    await ownerPool.query(`INSERT INTO invitations (id,organization_id,email_normalized,role,
      token_hash,expires_at,invited_by_membership_id)
      VALUES ($1,$2,'invite-audit@example.com','CASHIER',$3,now() + interval '1 day',$4)`,
    [invitationId, organizationId, 'a'.repeat(64), adminMembershipId]);
    await ownerPool.query(`INSERT INTO invitation_branches (organization_id,invitation_id,branch_id)
      VALUES ($1,$2,$3)`, [organizationId, invitationId, branchId]);
    await new TenantTransaction(runtimePool).read(context(ownerId), async (client) => {
      await client.query('SELECT 1');
    });
    const client = await runtimePool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.organization_id', $1, true)", [organizationId]);
      await new AuditEventWriter(client).append({ action: 'sale.confirmed', actorUserId: cashierId,
        after: {}, afterAllowlist: [], before: {}, beforeAllowlist: [], branchId,
        context: {}, contextAllowlist: [], entityId: randomUUID(), entityType: 'sale',
        operationId: 'audit-sale', organizationId, requestId: 'audit-setup' });
      await client.query('COMMIT');
    } finally { client.release(); }
    await ownerPool.query(`INSERT INTO audit_events (id, organization_id, actor_user_id, branch_id,
      request_id, operation_id, entity_type, entity_id, action) VALUES
      ($1,$2,$3,$4,'other-branch','other-branch','sale',$5,'sale.confirmed'),
      ($6,$2,$3,NULL,'global-admin','global-admin','catalog_category',$7,'catalog_category.created'),
      ($8,$2,$3,NULL,'global-owner','global-owner','organization',$2,'organization.currency_changed'),
      ($9,$2,$3,NULL,'member-admin','member-admin','membership',$10,'membership.status_changed'),
      ($11,$2,$3,NULL,'member-other','member-other','membership',$12,'membership.status_changed'),
      ($13,$2,$3,NULL,'invitation-admin','invitation-admin','invitation',$14,'invitation.created')`,
    [randomUUID(), organizationId, ownerId, otherBranchId, randomUUID(), randomUUID(), randomUUID(),
      randomUUID(), randomUUID(), cashierMembershipId, randomUUID(), employeeMembershipId,
      randomUUID(), invitationId]);
    await ownerPool.query(`INSERT INTO audit_events (id, organization_id, actor_user_id, request_id,
      operation_id, entity_type, entity_id, action) VALUES ($1,$2,$3,'foreign','foreign','branch',$4,'branch.updated')`,
    [randomUUID(), otherOrganizationId, ownerId, randomUUID()]);
  });

  afterAll(async () => {
    await runtimePool?.end();
    await ownerPool?.end();
    await container?.stop();
  });

  it('shows all tenant events to OWNER and no foreign events', async () => {
    const result = await service.list(context(ownerId), { limit: 20 });
    expect(result.items).toHaveLength(7);
    expect(result.items).toContainEqual(expect.objectContaining({ action: 'sale.confirmed', branchId,
      organizationId }));
    const foreign = await service.list({ organizationId: otherOrganizationId, userId: ownerId,
      requestId: randomUUID() }, { limit: 20 });
    expect(foreign.items).toHaveLength(1);
    expect(foreign.items[0]).toMatchObject({ organizationId: otherOrganizationId });
  });

  it.each([cashierId, employeeId])('denies the audit module to operational roles', async (userId) => {
    await expect(service.list(context(userId), { limit: 20 })).rejects.toMatchObject({
      code: 'AUDIT_ACCESS_FORBIDDEN',
    });
  });

  it('limits ADMIN to assigned branch events and administrable global resources', async () => {
    const result = await service.list(context(adminId), { limit: 20 });
    expect(result.items.map((event) => event.requestId).sort()).toEqual([
      'audit-setup', 'global-admin', 'invitation-admin', 'member-admin',
    ]);
    await expect(service.list(context(adminId), { limit: 20, branchId: otherBranchId }))
      .resolves.toMatchObject({ items: [] });
  });

  it('pages events without duplicating or skipping a shared timestamp', async () => {
    const first = await service.list(context(ownerId), { limit: 1 });
    expect(first.nextCursor).toBeTruthy();
    const cursor = JSON.parse(Buffer.from(first.nextCursor ?? '', 'base64url').toString('utf8')) as {
      id: string; sortValue: string;
    };
    const second = await service.list(context(ownerId), { limit: 6, cursor });
    expect(new Set([...first.items, ...second.items].map((item) => item.id)).size).toBe(7);
  });

  function context(userId: string) {
    return { organizationId, userId, requestId: randomUUID() };
  }
});
