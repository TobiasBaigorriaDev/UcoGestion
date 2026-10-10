import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { z } from 'zod';

import type { EmailPort } from './core/email/email-port.js';
import { OutboxDispatcher, OutboxWorker, type OutboxJobHandler } from './core/outbox/outbox-worker.js';
import type { TenantTransaction } from './database/tenant-transaction.js';
import { handleInvitationExpiration } from './modules/users/invitation-expiration.handler.js';

const invitationEmail = z.object({ email: z.email(), token: z.string().min(1),
  invitationId: z.uuid(), role: z.enum(['OWNER', 'ADMIN', 'CASHIER', 'EMPLOYEE']), branchIds: z.array(z.uuid()) }).strict();

export function createTenantWorker(options: {
  dispatchPool: Pool;
  transactions: TenantTransaction;
  workerUserId: string;
  email: EmailPort;
  report: OutboxJobHandler;
  cleanup: OutboxJobHandler;
  onDeadLetter?: ConstructorParameters<typeof OutboxWorker>[0]['onDeadLetter'];
}): OutboxWorker {
  return new OutboxWorker({
    dispatcher: new OutboxDispatcher(options.dispatchPool),
    tenantTransactions: options.transactions, workerUserId: options.workerUserId,
    maxAttempts: 5, retryBaseSeconds: 2,
    authorizer: { authorize: async job => {
      const authorization = { REPORT_PDF: 'REPORT_EXPORT', OBJECT_FILE_CLEANUP: 'OBJECT_FILE_CLEANUP',
        INVITATION_EMAIL: 'MEMBERSHIP_ADMINISTRATION', INVITATION_EXPIRATION: 'MEMBERSHIP_ADMINISTRATION' };
      if (!(job.jobType in authorization)
        || authorization[job.jobType as keyof typeof authorization] !== job.authorizationClass) {
        throw new Error('Unsupported job authorization.');
      }
    } },
    handlers: {
      REPORT_PDF: options.report, OBJECT_FILE_CLEANUP: options.cleanup,
      INVITATION_EXPIRATION: handleInvitationExpiration,
      INVITATION_EMAIL: async (job, client) => {
        const payload = invitationEmail.parse(job.payload);
        const invitation = await client.query(`SELECT id FROM invitations
          WHERE organization_id=$1 AND id=$2 AND token_hash=$3
            AND status='PENDING' AND revoked_at IS NULL AND expires_at>clock_timestamp()
          FOR UPDATE`, [job.organizationId, payload.invitationId,
          createHash('sha256').update(payload.token).digest('hex')]);
        // A revoked, expired or superseded token must never be mailed on a retry.
        if (invitation.rowCount === 1) await options.email.send({ email: payload.email, token: payload.token,
          jobKey: `${job.organizationId}:${job.jobKey}`, template: 'INVITATION',
          role: payload.role, branchIds: payload.branchIds });
        await client.query("UPDATE outbox_jobs SET payload=payload-'token' WHERE organization_id=$1 AND id=$2",
          [job.organizationId, job.id]);
      },
    },
    ...(options.onDeadLetter ? { onDeadLetter: options.onDeadLetter } : {}),
  });
}
