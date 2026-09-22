import { randomUUID } from 'node:crypto';

import { Controller, Get, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runMigrations } from '../src/database/migrate.js';
import { AuthModule } from '../src/modules/auth/auth.module.js';
import { createGlobalUser } from '../src/modules/auth/global-user.repository.js';
import { LoginService } from '../src/modules/auth/login.service.js';
import { ProblemDetailsExceptionFilter } from '../src/problem-details.js';

@Controller('protected-probe')
class ProtectedProbeController {
  @Get()
  get(): { ok: true } {
    return { ok: true };
  }
}

describe('protected tenant requests', () => {
  let app: INestApplication;
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let previousDatabaseUrl: string | undefined;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    await runMigrations(container.getConnectionUri());
    pool = new Pool({ connectionString: container.getConnectionUri() });
    previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = container.getConnectionUri();
    const module = await Test.createTestingModule({
      imports: [AuthModule],
      controllers: [ProtectedProbeController],
    }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalFilters(new ProblemDetailsExceptionFilter());
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    await container?.stop();
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  });

  async function activeMembership(): Promise<{ token: string; organizationId: string; userId: string }> {
    const user = await createGlobalUser(pool, {
      email: `${randomUUID()}@example.com`,
      password: 'correct-password',
    });
    const organizationId = randomUUID();
    await pool.query(
      "INSERT INTO organizations (id, base_currency, timezone) VALUES ($1, 'ARS', 'America/Argentina/Mendoza')",
      [organizationId],
    );
    await pool.query(
      "INSERT INTO memberships (id, organization_id, user_id, role) VALUES ($1, $2, $3, 'OWNER')",
      [randomUUID(), organizationId, user.id],
    );
    const login = new LoginService(pool);
    const { token } = await login.execute({ email: user.email, password: 'correct-password' });
    return { token, organizationId, userId: user.id };
  }

  it('allows only the active membership, rechecking it on every request', async () => {
    const { token, organizationId, userId } = await activeMembership();
    const cookie = `__Host-uco_session=${token}`;
    await request(app.getHttpServer())
      .get('/api/v1/protected-probe')
      .set('Cookie', cookie)
      .set('X-Organization-Id', organizationId)
      .expect(200);

    await pool.query(
      `UPDATE memberships
       SET status = 'REVOKED', revoked_at = now()
       WHERE organization_id = $1 AND user_id = $2`,
      [organizationId, userId],
    );
    const denied = await request(app.getHttpServer())
      .get('/api/v1/protected-probe')
      .set('Cookie', cookie)
      .set('X-Organization-Id', organizationId)
      .expect(403);
    expect(denied.body.code).toBe('MEMBERSHIP_INACTIVE');
  });

  it('rejects cross-tenant access and inactive users without deleting history', async () => {
    const { token, organizationId, userId } = await activeMembership();
    const otherOrganizationId = randomUUID();
    await pool.query(
      "INSERT INTO organizations (id, base_currency, timezone) VALUES ($1, 'ARS', 'America/Argentina/Mendoza')",
      [otherOrganizationId],
    );
    const cookie = `__Host-uco_session=${token}`;
    await request(app.getHttpServer())
      .get('/api/v1/protected-probe')
      .set('Cookie', cookie)
      .set('X-Organization-Id', otherOrganizationId)
      .expect(403);

    await pool.query('UPDATE users SET disabled_at = now() WHERE id = $1', [userId]);
    const denied = await request(app.getHttpServer())
      .get('/api/v1/protected-probe')
      .set('Cookie', cookie)
      .set('X-Organization-Id', organizationId)
      .expect(401);
    expect(denied.body.code).toBe('SESSION_INVALID');
    await expect(new LoginService(pool).execute({
      email: (await pool.query<{ email_normalized: string }>(
        'SELECT email_normalized FROM users WHERE id = $1',
        [userId],
      )).rows[0]?.email_normalized ?? '',
      password: 'correct-password',
    })).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    const historical = await pool.query<{ count: string }>(
      'SELECT count(*) FROM auth_sessions WHERE user_id = $1',
      [userId],
    );
    expect(historical.rows[0]?.count).toBe('1');
  });

  it('rejects missing session and missing organization context', async () => {
    const { token, organizationId } = await activeMembership();
    await request(app.getHttpServer())
      .get('/api/v1/protected-probe')
      .set('X-Organization-Id', organizationId)
      .expect(401);
    await request(app.getHttpServer())
      .get('/api/v1/protected-probe')
      .set('Cookie', `__Host-uco_session=${token}`)
      .expect(403);
  });

  it('keeps memberships default-deny under the runtime role', async () => {
    const first = await activeMembership();
    const second = await activeMembership();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE uco_app');
      const withoutContext = await client.query<{ id: string }>('SELECT id FROM memberships');
      expect(withoutContext.rows).toEqual([]);
      await client.query("SELECT set_config('app.organization_id', $1, true)", [first.organizationId]);
      const scoped = await client.query<{ user_id: string }>('SELECT user_id FROM memberships');
      expect(scoped.rows).toEqual([{ user_id: first.userId }]);
      expect(scoped.rows).not.toContainEqual({ user_id: second.userId });
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });
});
