import { type OfflineBootstrapPayload } from '@uconext/shared';
import { OfflineLease } from '../src/offline/offline-lease';
import { OfflineSealer } from '../src/offline/offline-sealer';
import { OfflinePos } from '../src/offline/offline-pos';
import { OfflineRecordCipher } from '../src/offline/offline-record-cipher';
import { authorizationFixture, actor } from './offline-authorization.fixture';

export const register = '66666666-6666-4666-8666-666666666666';
export async function posFixture(configure?: (bootstrap: OfflineBootstrapPayload) => void) {
  const setup = await authorizationFixture(configure);
  await setup.authorization.install(actor, setup.signed, setup.jwt());
  const sealer = new OfflineSealer(setup.db, setup.keys, new OfflineLease(setup.db), {
    certificate: 'opaque', publication: setup.bootstrap.ingestionKey, trustedSigner: setup.trusted, trustedSigningKeyId: 'trusted',
  });
  const pos = new OfflinePos(setup.db, setup.keys, setup.authorization, sealer, async () => {});
  return { ...setup, pos, async plaintext(kind: string, id: string): Promise<unknown> {
    const record = await setup.db.getEncrypted(actor, kind, id);
    if (!record) throw new Error('Missing encrypted record');
    return JSON.parse(new TextDecoder().decode(await new OfflineRecordCipher().decrypt(setup.keys.dekFor(actor), {
      organizationId: setup.db.organizationId, deviceId: setup.db.deviceId, userId: actor, kind, id,
    }, record)));
  } };
}
