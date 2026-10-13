import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import fc from 'fast-check';
import { afterEach, expect, it } from 'vitest';
import { OfflineAuthorization } from '../src/offline/offline-authorization';
import { OfflinePos } from '../src/offline/offline-pos';
import { OfflineDatabase } from '../src/offline/offline-database';
import { actor, device, now, org } from './offline-authorization.fixture';
import { posFixture, register } from './offline-pos.fixture';

afterEach(async () => { await Dexie.delete(OfflineDatabase.nameFor(org, device)); });
it('D03 keeps UUID, receipt and exact sealed bytes through variable replay/reload sequences', async () => {
  await fc.assert(fc.asyncProperty(fc.array(fc.boolean(), { minLength: 1, maxLength: 6 }), async reloads => {
    const setup = await posFixture();
    try {
      const session = await setup.pos.open(actor, { cashRegisterId: register, openingCash: '0.00' });
      const draft = await setup.pos.prepareSale(actor, { sessionId: session.sessionId, lines: [{ itemId: org, quantity: '1' }] });
      const input = { draftId: draft.id, payments: [{ method: 'CASH', appliedAmount: '10.00' }] };
      const original = await setup.pos.confirmSale(actor, input), bytes = await setup.db.deliveryBytes();
      for (const reload of reloads) {
        if (reload) { setup.db.close(); await setup.db.open(); }
        expect(await setup.pos.confirmSale(actor, input)).toEqual(original);
        expect((await setup.pos.receipt(actor, original.id))?.saleId).toBe(draft.id);
        expect(await setup.db.deliveryBytes()).toEqual(bytes);
      }
    } finally { await setup.db.delete(); }
  }), { numRuns: 5 });
}, 30_000);
it('D03 allows the unlocked owner to recover a pending receipt after expiry without permitting a new sale', async () => {
  const setup = await posFixture();
  try {
    const session = await setup.pos.open(actor, { cashRegisterId: register, openingCash: '0.00' });
    const draft = await setup.pos.prepareSale(actor, { sessionId: session.sessionId, lines: [{ itemId: org, quantity: '1' }] });
    const original = await setup.pos.confirmSale(actor, { draftId: draft.id, payments: [{ method: 'CASH', appliedAmount: '10.00' }] });
    const bytes = await setup.db.deliveryBytes();
    const expired = new OfflineAuthorization(setup.db, setup.keys, setup.trusted, 'trusted', () => now + 73 * 60 * 60 * 1000);
    const pos = new OfflinePos(setup.db, setup.keys, expired, setup.sealer, async () => {});
    expect((await pos.workspace(actor)).canCreate).toBe(false);
    expect((await pos.receipt(actor, original.id))?.saleId).toBe(draft.id);
    await expect(pos.prepareSale(actor, { sessionId: session.sessionId, lines: [{ itemId: org, quantity: '1' }] })).rejects.toThrow();
    expect(await setup.db.deliveryBytes()).toEqual(bytes);
  } finally { setup.db.close(); }
});
