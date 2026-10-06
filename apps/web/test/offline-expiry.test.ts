import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { afterEach, expect, it } from 'vitest';
import { OfflineDatabase } from '../src/offline/offline-database';
import { OfflineAuthorization } from '../src/offline/offline-authorization';
import { OfflinePos } from '../src/offline/offline-pos';
import { OfflineLease } from '../src/offline/offline-lease';
import { OfflineSealer } from '../src/offline/offline-sealer';
import { posFixture, register } from './offline-pos.fixture';
import { actor, org, device, now } from './offline-authorization.fixture';

afterEach(async () => { await Dexie.delete(OfflineDatabase.nameFor(org, device)); });

it('T200 rejects new work at expiry, retains original pending bytes and remembers known expiration after reload/clock rollback', async () => {
  const setup = await posFixture(); let clock = now;
  try {
    const authorization = new OfflineAuthorization(setup.db, setup.keys, setup.trusted, 'trusted', () => clock);
    const pos = new OfflinePos(setup.db, setup.keys, authorization,
      new OfflineSealer(setup.db, setup.keys, new OfflineLease(setup.db), { certificate: 'opaque',
        publication: setup.bootstrap.ingestionKey, trustedSigner: setup.trusted, trustedSigningKeyId: 'trusted' }), async () => {});
    const opened = await pos.open(actor, { cashRegisterId: register, openingCash: '0.00' });
    const draft = await pos.prepareSale(actor, { sessionId: opened.sessionId, lines: [{ itemId: org, quantity: '1' }] });
    const pending = await setup.db.deliveryBytes();
    const head = await setup.db.meta.get('device-chain');
    clock = setup.claims.exp * 1000;
    await expect(pos.confirmSale(actor, { draftId: draft.id, payments: [{ method: 'CASH', appliedAmount: '10.00' }] })).rejects.toThrow('venció');
    await expect(pos.open(actor, { cashRegisterId: register, openingCash: '0.00' })).rejects.toThrow('venció');
    expect(await setup.db.deliveryBytes()).toEqual(pending);
    expect(await setup.db.meta.get('device-chain')).toEqual(head);
    setup.db.close(); await setup.db.open(); clock = now;
    expect(await authorization.require(actor).then(() => false, error => error instanceof Error && error.message.includes('venció'))).toBe(true);
    expect(await setup.db.deliveryBytes()).toEqual(pending);
    expect((await pos.catalog(actor)).configuration).toEqual(setup.bootstrap.configuration);
  } finally { setup.db.close(); }
});
