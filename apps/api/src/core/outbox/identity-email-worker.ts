import type { Pool } from 'pg';
import { z } from 'zod';
import type { EmailPort } from '../email/email-port.js';
import type { OutboxProcessResult } from './outbox-worker.js';

const resetEmail = z.object({ email: z.email(), token: z.string().min(1) }).strict();
interface IdentityClaim { id: string; job_key: string; payload: unknown; lease_id: string }

export class IdentityEmailWorker {
  constructor(private readonly dispatchPool: Pool, private readonly email: EmailPort) {}

  async processAvailable(limit: number, leaseSeconds: number): Promise<OutboxProcessResult[]> {
    const claims = await this.dispatchPool.query<IdentityClaim>('SELECT * FROM claim_identity_email_jobs($1,$2)',
      [limit, leaseSeconds]);
    const results: OutboxProcessResult[] = [];
    for (const claim of claims.rows) {
      let success = false;
      try {
        const payload = resetEmail.parse(claim.payload);
        await this.email.send({ ...payload, jobKey: claim.job_key, template: 'PASSWORD_RESET' });
        success = true;
      } catch { /* Only a stable error code is persisted; provider errors may contain tokens. */ }
      const finished = await this.dispatchPool.query<{ status: string }>(
        'SELECT finish_identity_email_job($1,$2,$3) AS status', [claim.id, claim.lease_id, success]);
      const status = finished.rows[0]?.status;
      if (status !== 'COMPLETED' && status !== 'PENDING' && status !== 'DEAD_LETTER') {
        throw new Error('Identity email lease is no longer valid.');
      }
      results.push({ jobId: claim.id, status: status === 'PENDING' ? 'RETRY_SCHEDULED' : status });
    }
    return results;
  }
}
