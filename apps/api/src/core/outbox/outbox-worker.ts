import type { Pool, PoolClient } from 'pg';

import type { JsonValue } from '../idempotency/idempotency.service.js';
import { TenantTransaction } from '../../database/tenant-transaction.js';

export interface ClaimedOutboxJob {
  jobId: string;
  jobType: string;
  leaseId: string;
  organizationId: string;
}

export interface OutboxJob {
  actorUserId: string;
  attemptCount: number;
  authorizationClass: string;
  branchId: string | null;
  id: string;
  jobKey: string;
  jobType: string;
  organizationId: string;
  payload: JsonValue;
}

export interface OutboxJobAuthorizer {
  authorize(job: OutboxJob): Promise<void>;
}

export type OutboxJobHandler = (job: OutboxJob, client: PoolClient) => Promise<void>;

export interface OutboxWorkerOptions {
  authorizer: OutboxJobAuthorizer;
  dispatcher: OutboxDispatcher;
  handlers: Readonly<Record<string, OutboxJobHandler>>;
  maxAttempts: number;
  retryBaseSeconds: number;
  tenantTransactions: TenantTransaction;
  workerUserId: string;
}

export type OutboxProcessResult =
  | { jobId: string; status: 'COMPLETED' }
  | { jobId: string; status: 'DEAD_LETTER' | 'RETRY_SCHEDULED' };

interface ClaimedOutboxJobRow {
  jobId: string;
  jobType: string;
  leaseId: string;
  organizationId: string;
}

interface OutboxJobRow {
  actor_user_id: string;
  attempt_count: number;
  authorization_class: string;
  branch_id: string | null;
  id: string;
  job_key: string;
  job_type: string;
  organization_id: string;
  payload: JsonValue;
}

export class OutboxDispatcher {
  constructor(private readonly pool: Pool) {}

  async claim(limit: number, leaseSeconds: number): Promise<ClaimedOutboxJob[]> {
    const result = await this.pool.query<ClaimedOutboxJobRow>(
      `SELECT job_id AS "jobId", organization_id AS "organizationId", job_type AS "jobType", lease_id AS "leaseId"
      FROM claim_outbox_jobs($1, $2)`,
      [limit, leaseSeconds],
    );

    return result.rows;
  }
}

export class OutboxWorker {
  private readonly authorizer: OutboxJobAuthorizer;
  private readonly dispatcher: OutboxDispatcher;
  private readonly handlers: Readonly<Record<string, OutboxJobHandler>>;
  private readonly maxAttempts: number;
  private readonly retryBaseSeconds: number;
  private readonly tenantTransactions: TenantTransaction;
  private readonly workerUserId: string;

  constructor(options: OutboxWorkerOptions) {
    this.authorizer = options.authorizer;
    this.dispatcher = options.dispatcher;
    this.handlers = options.handlers;
    this.maxAttempts = options.maxAttempts;
    this.retryBaseSeconds = options.retryBaseSeconds;
    this.tenantTransactions = options.tenantTransactions;
    this.workerUserId = options.workerUserId;
  }

  async processAvailable(limit: number, leaseSeconds: number): Promise<OutboxProcessResult[]> {
    const claims = await this.dispatcher.claim(limit, leaseSeconds);
    const results: OutboxProcessResult[] = [];

    for (const claim of claims) {
      results.push(await this.process(claim));
    }

    return results;
  }

  async process(claim: ClaimedOutboxJob): Promise<OutboxProcessResult> {
    try {
      await this.tenantTransactions.run(
        this.transactionContext(claim),
        {
          action: 'outbox.processed',
          after: { status: 'COMPLETED' },
          afterAllowlist: ['status'],
          before: { status: 'PROCESSING' },
          beforeAllowlist: ['status'],
          branchId: null,
          context: { jobType: claim.jobType },
          contextAllowlist: ['jobType'],
          entityId: claim.jobId,
          entityType: 'outbox_job',
          operationId: claim.leaseId,
        },
        async (client) => {
          const job = await this.loadClaimedJob(client, claim);
          await this.authorizer.authorize(job);
          const handler = this.handlers[job.jobType];
          if (!handler) {
            throw new Error('No handler is registered for this outbox job type.');
          }

          await handler(job, client);
          const completed = await client.query<{ id: string }>(
            `UPDATE outbox_jobs
            SET status = 'COMPLETED', completed_at = now(), lease_id = NULL, lease_expires_at = NULL
            WHERE id = $1 AND organization_id = $2 AND status = 'PROCESSING' AND lease_id = $3
            RETURNING id`,
            [claim.jobId, claim.organizationId, claim.leaseId],
          );
          if (completed.rowCount !== 1) {
            throw new Error('The outbox lease is no longer valid.');
          }
        },
      );
      return { jobId: claim.jobId, status: 'COMPLETED' };
    } catch {
      return this.recordFailure(claim);
    }
  }

  private async loadClaimedJob(client: PoolClient, claim: ClaimedOutboxJob): Promise<OutboxJob> {
    const result = await client.query<OutboxJobRow>(
      `SELECT id, organization_id, job_key, job_type, payload, actor_user_id, branch_id, authorization_class, attempt_count
      FROM outbox_jobs
      WHERE id = $1 AND organization_id = $2 AND status = 'PROCESSING' AND lease_id = $3
      FOR UPDATE`,
      [claim.jobId, claim.organizationId, claim.leaseId],
    );
    const row = result.rows.at(0);
    if (!row) {
      throw new Error('The claimed outbox job is unavailable.');
    }

    return {
      actorUserId: row.actor_user_id,
      attemptCount: row.attempt_count,
      authorizationClass: row.authorization_class,
      branchId: row.branch_id,
      id: row.id,
      jobKey: row.job_key,
      jobType: row.job_type,
      organizationId: row.organization_id,
      payload: row.payload,
    };
  }

  private async recordFailure(claim: ClaimedOutboxJob): Promise<OutboxProcessResult> {
    return this.tenantTransactions.run(
      this.transactionContext(claim),
      {
        action: 'outbox.failed',
        after: { status: 'PENDING' },
        afterAllowlist: ['status'],
        before: { status: 'PROCESSING' },
        beforeAllowlist: ['status'],
        branchId: null,
        context: { jobType: claim.jobType },
        contextAllowlist: ['jobType'],
        entityId: claim.jobId,
        entityType: 'outbox_job',
        operationId: claim.leaseId,
      },
      async (client) => {
        const result = await client.query<{ attempt_count: number; status: 'DEAD_LETTER' | 'PENDING' }>(
          `UPDATE outbox_jobs
          SET status = CASE WHEN attempt_count >= $4 THEN 'DEAD_LETTER' ELSE 'PENDING' END,
            available_at = CASE
              WHEN attempt_count >= $4 THEN available_at
              ELSE now() + (($5 * pg_catalog.power(2::double precision, attempt_count - 1)) * interval '1 second')
            END,
            lease_id = NULL,
            lease_expires_at = NULL,
            last_error_code = 'HANDLER_FAILED'
          WHERE id = $1 AND organization_id = $2 AND status = 'PROCESSING' AND lease_id = $3
          RETURNING attempt_count, status`,
          [
            claim.jobId,
            claim.organizationId,
            claim.leaseId,
            this.maxAttempts,
            this.retryBaseSeconds,
          ],
        );
        const row = result.rows.at(0);
        if (!row) {
          throw new Error('The failed outbox job lease is no longer valid.');
        }

        return row.status === 'DEAD_LETTER'
          ? { jobId: claim.jobId, status: 'DEAD_LETTER' as const }
          : { jobId: claim.jobId, status: 'RETRY_SCHEDULED' as const };
      },
    );
  }

  private transactionContext(claim: ClaimedOutboxJob) {
    return {
      organizationId: claim.organizationId,
      requestId: `outbox:${claim.jobId}:${claim.leaseId}`,
      userId: this.workerUserId,
    };
  }
}
