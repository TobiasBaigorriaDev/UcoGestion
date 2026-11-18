import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import request from 'supertest';
import { saleCodeFromId } from '@uconext/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module.js';
import { configureApi } from '../src/configure-api.js';
import { runMigrations } from '../src/database/migrate.js';
import { createGlobalUser } from '../src/modules/auth/global-user.repository.js';

const origin = 'http://localhost:3000';

/** Same visible code: identical first 12 and last 3 hex digits, different middle. */
function collidingId(id: string): string {
  const middle = randomUUID().replaceAll('-', '').slice(12, 29);
  const hex = id.replaceAll('-', '').slice(0, 12) + '4' + middle.slice(1, 4) + '9' + middle.slice(5, 17) + id.slice(-3);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

describe('D05 sale code lookup over HTTP', () => {
  let app: INestApplication;
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let previousUrl: string | undefined;
  const organizationId = randomUUID();
  const otherOrganizationId = randomUUID();
  const branchId = randomUUID();
  const otherBranchId = randomUUID();
  const deviceId = randomUUID();
  const sessionId = randomUUID();
  const itemId = randomUUID();
  const ownerEmail = 'sale-code-owner@example.com';
  const cashierEmail = 'sale-code-cashier@example.com';
  const scopedAdminEmail = 'sale-code-admin@example.com';

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    await runMigrations(container.getConnectionUri());
    pool = new Pool({ connectionString: container.getConnectionUri() });
    const owner = await createGlobalUser(pool, { email: ownerEmail, password: 'correct-password' });
    const cashier = await createGlobalUser(pool, { email: cashierEmail, password: 'correct-password' });
    const admin = await createGlobalUser(pool, { email: scopedAdminEmail, password: 'correct-password' });
    for (const [id, name] of [[organizationId, 'Codes'], [otherOrganizationId, 'Other codes']]) {
      await pool.query("INSERT INTO organizations (id, name, base_currency, timezone) VALUES ($1, $2, 'ARS', 'UTC')", [id, name]);
      await pool.query("INSERT INTO memberships (id, organization_id, user_id, role) VALUES ($1, $2, $3, 'OWNER')",
        [randomUUID(), id, owner.id]);
    }
    await pool.query("INSERT INTO branches (id, organization_id, name) VALUES ($1, $2, 'Principal'), ($3, $2, 'Norte')",
      [branchId, organizationId, otherBranchId]);
    const cashierMembership = randomUUID();
    const adminMembership = randomUUID();
    await pool.query("INSERT INTO memberships (id, organization_id, user_id, role) VALUES ($1, $2, $3, 'CASHIER'), ($4, $2, $5, 'ADMIN')",
      [cashierMembership, organizationId, cashier.id, adminMembership, admin.id]);
    await pool.query('INSERT INTO membership_branches (organization_id, membership_id, branch_id) VALUES ($1, $2, $3), ($1, $4, $5)',
      [organizationId, cashierMembership, branchId, adminMembership, otherBranchId]);
    const registerId = randomUUID();
    await pool.query("INSERT INTO cash_registers (id, organization_id, branch_id, name) VALUES ($1, $2, $3, 'Caja')",
      [registerId, organizationId, branchId]);
    await pool.query(`INSERT INTO devices (id, organization_id, branch_id, authorized_by_user_id, authorized_at, status)
      VALUES ($1, $2, $3, $4, now(), 'ACTIVE')`, [deviceId, organizationId, branchId, owner.id]);
    await pool.query(`INSERT INTO cash_sessions (id, organization_id, branch_id, cash_register_id, owner_user_id,
      device_id, origin, status, opening_cash, expected_cash, currency_code)
      VALUES ($1, $2, $3, $4, $5, $6, 'ONLINE', 'OPEN', '0.00', '0.00', 'ARS')`,
    [sessionId, organizationId, branchId, registerId, owner.id, deviceId]);
    await pool.query(`INSERT INTO catalog_items (id, organization_id, name, type, base_unit, price, price_version,
      track_inventory) VALUES ($1, $2, 'Producto', 'PRODUCT', 'UNIT', '10.00', 1, true)`, [itemId, organizationId]);
    await pool.query("UPDATE branch_stocks SET quantity = '20' WHERE organization_id = $1 AND branch_id = $2 AND item_id = $3",
      [organizationId, branchId, itemId]);
    previousUrl = process.env.DATABASE_URL;
    await pool.query("CREATE ROLE sale_code_runtime LOGIN PASSWORD 'runtime-password' IN ROLE uco_app");
    const runtimeUrl = new URL(container.getConnectionUri());
    runtimeUrl.username = 'sale_code_runtime'; runtimeUrl.password = 'runtime-password';
    process.env.DATABASE_URL = runtimeUrl.toString();
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApi(module.createNestApplication());
    await app.init();
  });

  afterAll(async () => {
    await app?.close(); await pool?.end(); await container?.stop();
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
  });

  async function login(email: string) {
    const response = await request(app.getHttpServer()).post('/api/v1/auth/login')
      .set('Origin', origin).send({ email, password: 'correct-password' }).expect(204);
    const cookie = (response.headers['set-cookie'] as string[] | undefined)?.[0]?.split(';')[0] ?? '';
    const csrf = await request(app.getHttpServer()).get('/api/v1/auth/csrf').set('Cookie', cookie).expect(200);
    return { cookie, csrf: csrf.body.csrfToken as string };
  }

  async function confirmSale(session: { cookie: string; csrf: string }, id: string) {
    const post = (path: string) => request(app.getHttpServer()).post(path).set('Origin', origin)
      .set('Cookie', session.cookie).set('X-Organization-Id', organizationId)
      .set('X-CSRF-Token', session.csrf).set('Idempotency-Key', randomUUID());
    const lines = [{ itemId, quantity: '1' }];
    const quote = await post('/api/v1/sales/quote').send({ branchId, lines }).expect(201);
    await post('/api/v1/sales').send({ branchId, cashSessionId: sessionId, deviceId, clientOperationId: id, lines,
      quoteFingerprint: quote.body.quoteFingerprint as string,
      payments: [{ method: 'CASH', appliedAmount: '10.00', receivedAmount: '10.00' }] }).expect(201);
  }

  const lookup = (session: { cookie: string }, code: string, organization = organizationId) =>
    request(app.getHttpServer()).get(`/api/v1/sales/by-code/${encodeURIComponent(code)}`)
      .set('Cookie', session.cookie).set('X-Organization-Id', organization);

  it('resolves authorized sales by code, variants and UUID without side effects', async () => {
    const owner = await login(ownerEmail);
    const saleId = randomUUID();
    await confirmSale(owner, saleId);
    const code = saleCodeFromId(saleId);
    const counts = async () => (await pool.query<{ audit: number; idem: number; sales: number }>(`SELECT
      (SELECT count(*)::integer FROM audit_events) AS audit,
      (SELECT count(*)::integer FROM idempotency_records) AS idem,
      (SELECT count(*)::integer FROM sales) AS sales`)).rows[0];
    const before = await counts();

    expect((await lookup(owner, code).expect(200)).body).toEqual({ id: saleId });
    const variant = `${code.slice(0, 6)}-${code.slice(6)}`.toLowerCase().replaceAll('0', 'o').replaceAll('1', 'l');
    expect((await lookup(owner, ` ${variant} `).expect(200)).body).toEqual({ id: saleId });
    const detail = await request(app.getHttpServer()).get(`/api/v1/sales/${saleId}`)
      .set('Cookie', owner.cookie).set('X-Organization-Id', organizationId).expect(200);
    expect(detail.body).toMatchObject({ id: saleId, status: 'CONFIRMED' });

    expect((await lookup(owner, 'ABC').expect(400)).body).toMatchObject({ code: 'SALE_CODE_INVALID' });
    expect((await lookup(owner, `${code.slice(0, 11)}U`).expect(400)).body).toMatchObject({ code: 'SALE_CODE_INVALID' });
    expect(await counts()).toEqual(before);
  });

  it('does not reveal sales from another tenant, branch scope or cash session owner', async () => {
    const owner = await login(ownerEmail);
    const saleId = randomUUID();
    await confirmSale(owner, saleId);
    const code = saleCodeFromId(saleId);

    expect((await lookup(owner, code, otherOrganizationId).expect(404)).body).toMatchObject({ code: 'SALE_NOT_FOUND' });
    const admin = await login(scopedAdminEmail);
    expect((await lookup(admin, code).expect(404)).body).toMatchObject({ code: 'SALE_NOT_FOUND' });
    const cashier = await login(cashierEmail);
    expect((await lookup(cashier, code).expect(404)).body).toMatchObject({ code: 'SALE_NOT_FOUND' });
  });

  it('reports ambiguity instead of choosing one of two authorized matches', async () => {
    const owner = await login(ownerEmail);
    const first = randomUUID();
    const second = collidingId(first);
    expect(saleCodeFromId(second)).toBe(saleCodeFromId(first));
    await confirmSale(owner, first);
    await confirmSale(owner, second);

    const response = await lookup(owner, saleCodeFromId(first)).expect(409);
    expect(response.body).toMatchObject({ code: 'SALE_CODE_AMBIGUOUS' });
    expect(JSON.stringify(response.body)).not.toContain(first);
    expect(JSON.stringify(response.body)).not.toContain(second);
    for (const id of [first, second]) {
      await request(app.getHttpServer()).get(`/api/v1/sales/${id}`)
        .set('Cookie', owner.cookie).set('X-Organization-Id', organizationId).expect(200);
    }
  });
});
