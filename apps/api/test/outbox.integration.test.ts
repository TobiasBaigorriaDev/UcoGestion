import { randomUUID } from 'node:crypto';

import { Pool, type PoolClient } from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  OutboxDispatcher,
  OutboxWorker,
  type ClaimedOutboxJob,
} from '../src/core/outbox/outbox-worker.js';
import { runMigrations } from '../src/database/migrate.js';
import { TenantTransaction } from '../src/database/tenant-transaction.js';

const organizationA = '00000000-0000-4000-8000-000000000061';
const organizationB = '00000000-0000-4000-8000-000000000062';
const branchA = '00000000-0000-4000-8000-000000000063';
const actorUserId = '00000000-0000-4000-8000-000000000064';
const workerUserId = '00000000-0000-4000-8000-000000000065';

describe('outbox dispatcher and worker', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    await runMigrations(container.getConnectionUri());
    pool = new Pool({ connectionString: container.getConnectionUri() });
    await pool.query(
      "INSERT INTO organizations (id, base_currency, timezone) VALUES ($1, 'ARS', 'America/Argentina/Mendoza'), ($2, 'ARS', 'America/Argentina/Mendoza')",
      [organizationA, organizationB],
    );
    await pool.query("INSERT INTO branches (id, organization_id, name) VALUES ($1, $2, 'Centro')", [
      branchA,
      organizationA,
    ]);
    await pool.query('CREATE TABLE outbox_handler_probe (job_id uuid PRIMARY KEY)');
  });

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  it('uses SKIP LOCKED, exposes the dispatcher only to the worker role, honors leases, and preserves job_key uniqueness', async () => {
    const lockedJobId = await insertJob(pool, 'locked-job');
    const availableJobId = await insertJob(pool, 'available-job');
    const lockClient = await pool.connect();
    const workerClient = await pool.connect();

    try {
      await lockClient.query('BEGIN');
      await lockClient.query('SELECT id FROM outbox_jobs WHERE id = $1 FOR UPDATE', [lockedJobId]);

      await workerClient.query('BEGIN');
      await workerClient.query('SET LOCAL ROLE uco_worker');
      const claimed = await workerClient.query<ClaimedOutboxJob>(
        `SELECT job_id AS "jobId", organization_id AS "organizationId", job_type AS "jobType", lease_id AS "leaseId"
        FROM claim_outbox_jobs($1, $2)`,
        [10, 60],
      );
      await workerClient.query('COMMIT');

      expect(claimed.rows).toHaveLength(1);
      expect(claimed.rows[0]).toMatchObject({ jobId: availableJobId, organizationId: organizationA });
      await lockClient.query('ROLLBACK');

      await pool.query(
        "UPDATE outbox_jobs SET status = 'PROCESSING', lease_expires_at = now() - interval '1 second' WHERE id = $1",
        [lockedJobId],
      );
      const reclaimed = await claimAsWorker(pool, 1, 60);
      expect(reclaimed).toMatchObject([{ jobId: lockedJobId, organizationId: organizationA }]);

      const appClient = await pool.connect();
      try {
        await appClient.query('BEGIN');
        await appClient.query('SET LOCAL ROLE uco_app');
        await expect(appClient.query('SELECT * FROM claim_outbox_jobs(1, 60)')).rejects.toThrow();
        await appClient.query('ROLLBACK');
      } finally {
        appClient.release();
      }

      await expect(insertJob(pool, 'available-job')).rejects.toThrow();
    } finally {
      await rollbackIfOpen(lockClient);
      await rollbackIfOpen(workerClient);
      lockClient.release();
      workerClient.release();
    }
  });

  it('re-authorizes each tenant job and handles completion, rollback, backoff, and dead-lettering', async () => {
    const completedJobId = await insertJob(pool, 'complete-job');
    const failedJobId = await insertJob(pool, 'failing-job');
    const authorizedActors: string[] = [];
    const worker = new OutboxWorker({
      authorizer: {
        authorize: async (job) => {
          authorizedActors.push(job.actorUserId);
        },
      },
      dispatcher: new OutboxDispatcher(pool),
      handlers: {
        send_email: async (job, client) => {
          await client.query('INSERT INTO outbox_handler_probe (job_id) VALUES ($1)', [job.id]);
          if (job.id === failedJobId) {
            throw new Error('simulated handler failure');
          }
        },
      },
      maxAttempts: 3,
      retryBaseSeconds: 1,
      tenantTransactions: new TenantTransaction(pool),
      workerUserId,
    });

    const claimed = await new OutboxDispatcher(pool).claim(10, 60);
    const completedClaim = findClaim(claimed, completedJobId);
    const failedClaim = findClaim(claimed, failedJobId);

    await expect(worker.process(completedClaim)).resolves.toMatchObject({ status: 'COMPLETED' });
    expect(await pool.query('SELECT job_id FROM outbox_handler_probe WHERE job_id = $1', [completedJobId])).toMatchObject({
      rows: [{ job_id: completedJobId }],
    });
    expect(await pool.query('SELECT status FROM outbox_jobs WHERE id = $1', [completedJobId])).toMatchObject({
      rows: [{ status: 'COMPLETED' }],
    });
    expect(authorizedActors).toContain(actorUserId);

    await expect(worker.process(failedClaim)).resolves.toMatchObject({ status: 'RETRY_SCHEDULED' });
    expect(
      await pool.query<{ retry_delay_seconds: number; status: string; attempt_count: number }>(
        `SELECT status, attempt_count, EXTRACT(EPOCH FROM available_at - clock_timestamp())::double precision AS retry_delay_seconds
        FROM outbox_jobs WHERE id = $1`,
        [failedJobId],
      ),
    ).toMatchObject({ rows: [{ attempt_count: 1, status: 'PENDING' }] });
    expect(await pool.query('SELECT job_id FROM outbox_handler_probe WHERE job_id = $1', [failedJobId])).toMatchObject({
      rows: [],
    });

    await pool.query('UPDATE outbox_jobs SET available_at = now() WHERE id = $1', [failedJobId]);
    const retryClaim = findClaim(await new OutboxDispatcher(pool).claim(10, 60), failedJobId);
    await expect(worker.process(retryClaim)).resolves.toMatchObject({ status: 'RETRY_SCHEDULED' });
    const secondRetry = await pool.query<{ retry_delay_seconds: number }>(
      `SELECT EXTRACT(EPOCH FROM available_at - clock_timestamp())::double precision AS retry_delay_seconds
      FROM outbox_jobs WHERE id = $1`,
      [failedJobId],
    );
    expect(secondRetry.rows[0]?.retry_delay_seconds).toBeGreaterThan(1.5);

    await pool.query('UPDATE outbox_jobs SET available_at = now() WHERE id = $1', [failedJobId]);
    const finalClaim = findClaim(await new OutboxDispatcher(pool).claim(10, 60), failedJobId);
    await expect(worker.process(finalClaim)).resolves.toMatchObject({ status: 'DEAD_LETTER' });
    expect(await pool.query('SELECT status, attempt_count FROM outbox_jobs WHERE id = $1', [failedJobId])).toMatchObject({
      rows: [{ attempt_count: 3, status: 'DEAD_LETTER' }],
    });
  });
});

async function insertJob(pool: Pool, jobKey: string): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO outbox_jobs (
      id, organization_id, job_key, job_type, payload, actor_user_id, branch_id, authorization_class
    ) VALUES ($1, $2, $3, 'send_email', '{"recipient":"demo@example.com"}'::jsonb, $4, $5, 'BRANCH_OPERATOR')`,
    [id, organizationA, jobKey, actorUserId, branchA],
  );
  return id;
}

async function claimAsWorker(pool: Pool, limit: number, leaseSeconds: number): Promise<ClaimedOutboxJob[]> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE uco_worker');
    const result = await client.query<ClaimedOutboxJob>(
      `SELECT job_id AS "jobId", organization_id AS "organizationId", job_type AS "jobType", lease_id AS "leaseId"
      FROM claim_outbox_jobs($1, $2)`,
      [limit, leaseSeconds],
    );
    await client.query('COMMIT');
    return result.rows;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function findClaim(claims: ClaimedOutboxJob[], jobId: string): ClaimedOutboxJob {
  const claim = claims.find((candidate) => candidate.jobId === jobId);
  if (!claim) {
    throw new Error(`Expected outbox job ${jobId} to be claimed.`);
  }
  return claim;
}

async function rollbackIfOpen(client: PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {
    // The test commits this transaction on its success path.
  }
}
