import React from 'react';
import { createRoot } from 'react-dom/client';
import { Workspace } from '../../src/features/identity/workspace';
import { useIdentityContext } from '../../src/features/identity/identity-context';
import { OfflineDatabase } from '../../src/offline/offline-database';
import { OfflineKeys } from '../../src/offline/offline-keys';
import { OfflineRecordCipher } from '../../src/offline/offline-record-cipher';
import { selectOrganization } from '../../src/features/identity/auth-flow';
import { ApiProblemError } from '../../src/lib/api/client';

const params = new URL(location.href).searchParams;
const organizationId = params.get('organizationId');
const userId = params.get('userId');
if (!organizationId || !userId) throw new Error('Missing fixture identity');
const db = new OfflineDatabase(organizationId, '11111111-1111-4111-8111-111111111111');
const keys = new OfflineKeys(db);
if (await db.key_envelopes.get(userId)) await keys.unlock(userId, '12345678');
else await keys.create(userId, '12345678');
await db.delivery_queue.put({ id: 'sealed', envelope: new Uint8Array([1, 2, 3]) });
const cipher = new OfflineRecordCipher(), recordContext = { organizationId, deviceId: db.deviceId, userId, kind: 'private', id: 'prior' };
if (!await db.getEncrypted(userId, 'private', 'prior')) await db.putEncrypted(userId, 'private', 'prior', await cipher.encrypt(keys.dekFor(userId), recordContext, new TextEncoder().encode('private-a')));
useIdentityContext.getState().setActiveOrganizationId(organizationId);
Object.assign(window, { switchAttempt: async (id: string) => {
  try { await selectOrganization(id); return { accepted: true }; }
  catch (error) { return error instanceof ApiProblemError ? { status: error.status, code: error.code } : { error: String(error) }; }
}, switchEvidence: async () => ({
  active: useIdentityContext.getState().activeOrganizationId,
  branch: useIdentityContext.getState().activeBranchId,
  rememberedBranch: sessionStorage.getItem(`uco-active-branch:${organizationId}`),
  unlocked: keys.canCreate(), retired: (await db.device_keys.get('device'))?.retiredUsers,
  pending: Array.from((await db.delivery_queue.get('sealed'))?.envelope ?? []),
}), readPrior: async () => {
  try { return new TextDecoder().decode(await cipher.decrypt(keys.dekFor(userId), recordContext, await db.getEncrypted(userId, 'private', 'prior') ?? new Uint8Array())); }
  catch { return 'ACCESS_RETIRED'; }
} });
const root = document.getElementById('root');
if (!root) throw new Error('Missing root');
createRoot(root).render(<Workspace />);
