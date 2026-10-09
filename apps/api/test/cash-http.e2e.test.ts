import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module.js';
import { configureApi } from '../src/configure-api.js';
import { runMigrations } from '../src/database/migrate.js';
import { createGlobalUser } from '../src/modules/auth/global-user.repository.js';

describe('cash HTTP', () => {
  let app: INestApplication;
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let previousUrl: string | undefined;
  const organizationId = randomUUID();
  const branchId = randomUUID();
  const registerId = randomUUID();
  const deviceId = randomUUID();
  const email = 'cash-http-owner@example.com';

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    await runMigrations(container.getConnectionUri());
    pool = new Pool({ connectionString: container.getConnectionUri() });
    const owner = await createGlobalUser(pool, { email, password: 'correct-password' });
    await pool.query("INSERT INTO organizations (id, name, base_currency, timezone) VALUES ($1, 'Cash HTTP', 'ARS', 'UTC')", [organizationId]);
    await pool.query("INSERT INTO branches (id, organization_id, name) VALUES ($1, $2, 'Principal')", [branchId, organizationId]);
    await pool.query("INSERT INTO memberships (id, organization_id, user_id, role) VALUES ($1, $2, $3, 'OWNER')",
      [randomUUID(), organizationId, owner.id]);
    await pool.query("INSERT INTO cash_registers (id, organization_id, branch_id, name) VALUES ($1, $2, $3, 'Caja')",
      [registerId, organizationId, branchId]);
    await pool.query(`INSERT INTO devices (id, organization_id, branch_id, authorized_by_user_id, authorized_at, status)
      VALUES ($1, $2, $3, $4, now(), 'ACTIVE')`, [deviceId, organizationId, branchId, owner.id]);
    previousUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = container.getConnectionUri();
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApi(module.createNestApplication());
    await app.init();
  });

  afterAll(async () => {
    await app?.close(); await pool?.end(); await container?.stop();
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
  });

  it('T121A-T123 exposes guarded, idempotent cash commands with problem responses', async () => {
    const login = await request(app.getHttpServer()).post('/api/v1/auth/login')
      .set('Origin', 'http://localhost:3000').send({ email, password: 'correct-password' }).expect(204);
    const cookie = (login.headers['set-cookie'] as string[] | undefined)?.[0]?.split(';')[0] ?? '';
    const csrf = await request(app.getHttpServer()).get('/api/v1/auth/csrf').set('Cookie', cookie).expect(200);
    const post = (path: string, key: string) => request(app.getHttpServer()).post(path)
      .set('Origin', 'http://localhost:3000').set('Cookie', cookie)
      .set('X-Organization-Id', organizationId).set('X-CSRF-Token', csrf.body.csrfToken as string)
      .set('Idempotency-Key', key);
    const opening = { branchId, cashRegisterId: registerId, deviceId, openingCash: '5.00' };
    const opened = await post('/api/v1/cash-sessions/open', 'cash-http-open').send(opening).expect(201);
    expect(opened.body).toMatchObject(opening);
    expect((await post('/api/v1/cash-sessions/open', 'cash-http-open').send(opening).expect(201)).body)
      .toEqual(opened.body);
    const manual = { cashSessionId: opened.body.id as string, deviceId, amount: '2.00', reason: 'Cambio' };
    const deposit = await post('/api/v1/cash-sessions/manual-deposits', 'cash-http-in')
      .send(manual).expect(201);
    expect(deposit.body).toMatchObject({ expectedCash: '7.00' });
    const insufficient = await post('/api/v1/cash-sessions/manual-withdrawals', 'cash-http-too-much')
      .send({ ...manual, amount: '8.00' }).expect(409);
    expect(insufficient.headers['content-type']).toContain('application/problem+json');
    expect(insufficient.body).toMatchObject({ code: 'CASH_INSUFFICIENT_EXPECTED' });
    const withdrawal = await post('/api/v1/cash-sessions/manual-withdrawals', 'cash-http-out')
      .send({ ...manual, amount: '1.00', reason: 'Retiro' }).expect(201);
    expect(withdrawal.body).toMatchObject({ expectedCash: '6.00' });
    const workspace = await request(app.getHttpServer()).get(`/api/v1/cash-sessions?branchId=${branchId}`)
      .set('Cookie',cookie).set('X-Organization-Id',organizationId).expect(200);
    expect(workspace.body).toMatchObject({ sessions:[{id:opened.body.id,status:'OPEN',expectedCash:'6.00',deviceId}],
      devices:[{id:deviceId,status:'ACTIVE'}] });
    expect(JSON.stringify(workspace.body)).not.toContain('password');
    const checkpoint=await request(app.getHttpServer()).get(`/api/v1/cash-sessions/${opened.body.id}/checkpoint`)
      .set('Cookie',cookie).set('X-Organization-Id',organizationId).expect(200);
    expect(checkpoint.body).toEqual({sequence:'0',headHash:'0'.repeat(64),sessionSequence:'0'});
    await request(app.getHttpServer()).get(`/api/v1/cash-sessions/${randomUUID()}/checkpoint`)
      .set('Cookie',cookie).set('X-Organization-Id',organizationId).expect(403);
    await request(app.getHttpServer()).get(`/api/v1/cash-sessions?branchId=${randomUUID()}`)
      .set('Cookie',cookie).set('X-Organization-Id',organizationId).expect(403);
    const employee=await createGlobalUser(pool,{email:'cash-http-employee@example.com',password:'correct-password'});
    await pool.query("INSERT INTO memberships(id,organization_id,user_id,role) VALUES($1,$2,$3,'EMPLOYEE')",
      [randomUUID(),organizationId,employee.id]);
    const employeeLogin=await request(app.getHttpServer()).post('/api/v1/auth/login')
      .set('Origin','http://localhost:3000').send({email:'cash-http-employee@example.com',password:'correct-password'}).expect(204);
    const employeeSetCookie:unknown=employeeLogin.headers['set-cookie'];
    const employeeCookie=Array.isArray(employeeSetCookie) && typeof employeeSetCookie[0]==='string'
      ? employeeSetCookie[0].split(';')[0] ?? '' : '';
    await request(app.getHttpServer()).get(`/api/v1/cash-sessions?branchId=${branchId}`)
      .set('Cookie',employeeCookie).set('X-Organization-Id',organizationId).expect(403);
    await request(app.getHttpServer()).get(`/api/v1/cash-sessions/${opened.body.id}/checkpoint`)
      .set('Cookie',employeeCookie).set('X-Organization-Id',organizationId).expect(403);
    expect((await pool.query('SELECT expected_cash FROM cash_sessions WHERE id = $1', [opened.body.id]))
      .rows[0]?.expected_cash).toBe('6.00');
    const invalidCheckpoint = { checkpoint: { version: 1, organizationId, deviceId, actorUserId: randomUUID(),
      sessionId: opened.body.id, sequence: '0', sessionSequence: '0', headHash: '0'.repeat(64), creationFrozen: true, pending: 0 },
      signature: Buffer.alloc(64).toString('base64') };
    const rejectedClose = await post('/api/v1/cash-sessions/begin-close', 'cash-http-checkpoint')
      .send(invalidCheckpoint).expect(409);
    expect(rejectedClose.headers['content-type']).toContain('application/problem+json');
    expect(rejectedClose.body).toMatchObject({ code: 'CASH_CHECKPOINT_INVALID' });
    await request(app.getHttpServer()).post('/api/v1/cash-sessions/begin-close').send(invalidCheckpoint).expect(401);
    await post('/api/v1/cash-sessions/exceptional-close','exceptional-unconfirmed')
      .send({cashSessionId:opened.body.id,confirm:false,reason:'Dispositivo perdido'}).expect(400);
  });
});
