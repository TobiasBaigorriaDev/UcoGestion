import { z } from 'zod';

import { ApiClient } from '../lib/api/client';
import { requireOfflineCapabilities } from './capability-gate';

const client = new ApiClient();
const responseSchema = z.object({ id: z.uuid(), organizationId: z.uuid(), branchId: z.uuid(),
  authorizedByUserId: z.uuid(), status: z.literal('ACTIVE'), thumbprint: z.string(),
  certificate: z.string() });

export async function authorizePosOffline(organizationId: string,
  input: { branchId: string; publicKey: string }, idempotencyKey: string) {
  await requireOfflineCapabilities();
  const csrf = await client.request('/auth/csrf', { method: 'GET',
    parse: (value) => z.object({ csrfToken: z.string() }).parse(value) });
  if (!csrf) throw new Error('CSRF unavailable');
  return client.request('/devices/authorize-pos', {
    method: 'POST', organizationId, csrfToken: csrf.csrfToken,
    idempotencyKey, body: input, parse: (value) => responseSchema.parse(value),
  });
}
