import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { afterEach, expect, it } from 'vitest';
import { OfflineDatabase } from '../src/offline/offline-database.js';
import { OfflineLease } from '../src/offline/offline-lease.js';
import { OfflineSealer } from '../src/offline/offline-sealer.js';
import { OfflinePos } from '../src/offline/offline-pos.js';
import { OfflineAuthorization } from '../src/offline/offline-authorization.js';
import { authorizationFixture, org, device, actor, now } from './offline-authorization.fixture.js';

afterEach(async () => { await Dexie.delete(OfflineDatabase.nameFor(org, device)); });
const register = '66666666-6666-4666-8666-666666666666';
async function fixture() {
  const setup = await authorizationFixture();
  await setup.authorization.install(actor, setup.signed, setup.jwt());
  const sealer = new OfflineSealer(setup.db, setup.keys, new OfflineLease(setup.db), {
    certificate: 'opaque', publication: setup.bootstrap.ingestionKey, trustedSigner: setup.trusted, trustedSigningKeyId: 'trusted',
  });
  return { ...setup, pos: new OfflinePos(setup.db, setup.keys, setup.authorization, sealer, async () => {}) };
}

it('T192 opens and seals cash state atomically and rejects a duplicate device session', async () => {
  const setup = await fixture();
  try {
    const opened = await setup.pos.open(actor, { cashRegisterId: register, openingCash: '10.00' });
    expect(await setup.db.getEncrypted(actor, 'cash-session', opened.sessionId)).toBeDefined();
    expect(await setup.db.delivery_queue.count()).toBe(1);
    expect((await setup.db.meta.get('device-chain'))?.sequence).toBe('1');
    await expect(setup.pos.open(actor, { cashRegisterId: register, openingCash: '0.00' })).rejects.toThrow();
    expect(await setup.db.delivery_queue.count()).toBe(1);
  } finally { setup.db.close(); }
});

it('T192 rolls back cash state, envelope and sequence when either write fails', async () => {
  const setup = await fixture();
  try {
    const fail = () => { throw new Error('Envelope write failed'); };
    setup.db.delivery_queue.hook('creating', fail);
    await expect(setup.pos.open(actor, { cashRegisterId: register, openingCash: '0.00' })).rejects.toThrow('Envelope write failed');
    expect(await setup.db.records.where('[userId+kind+id]').between([actor, 'cash-session', ''], [actor, 'cash-session', '\uffff']).count()).toBe(0);
    expect(await setup.db.delivery_queue.count()).toBe(0);
    expect((await setup.db.meta.get('device-chain'))?.sequence).toBe('0');
    setup.db.delivery_queue.hook('creating').unsubscribe(fail);
    expect((await setup.pos.open(actor, { cashRegisterId: register, openingCash: '0.00' })).sequence).toBe('1');
  } finally { setup.db.close(); }
});

it('T192 rejects wrong register, invalid money, missing capabilities and locked identity', async () => {
  const setup = await fixture();
  try {
    await expect(setup.pos.open(actor, { cashRegisterId: org, openingCash: '0.00' })).rejects.toThrow();
    await expect(setup.pos.open(actor, { cashRegisterId: register, openingCash: '-1.00' })).rejects.toThrow();
    const unsupported = new OfflinePos(setup.db, setup.keys, setup.authorization,
      new OfflineSealer(setup.db, setup.keys, new OfflineLease(setup.db), { certificate: 'opaque', publication: setup.bootstrap.ingestionKey,
        trustedSigner: setup.trusted, trustedSigningKeyId: 'trusted' }), async () => { throw new Error('Capabilities unavailable'); });
    await expect(unsupported.open(actor, { cashRegisterId: register, openingCash: '0.00' })).rejects.toThrow('Capabilities unavailable');
    setup.keys.lock();
    await expect(setup.pos.open(actor, { cashRegisterId: register, openingCash: '0.00' })).rejects.toThrow();
    expect(await setup.db.delivery_queue.count()).toBe(0);
  } finally { setup.db.close(); }
});

it('T193 reads only signed known configuration for the unlocked identity without private master data', async () => {
  const setup = await fixture();
  try {
    const catalog = await setup.pos.catalog(actor);
    expect(catalog.configuration).toEqual(setup.bootstrap.configuration);
    expect(catalog.lastSyncAt).toBe(setup.bootstrap.serverTime);
    expect(catalog).not.toHaveProperty('customers');
    expect(catalog).not.toHaveProperty('suppliers');
    expect(catalog).not.toHaveProperty('grant');
    await expect(setup.pos.catalog(org)).rejects.toThrow();
    setup.keys.lock();
    await expect(setup.pos.catalog(actor)).rejects.toThrow();
    expect(await setup.db.delivery_queue.count()).toBe(0);
  } finally { setup.db.close(); }
});

it('T194 prepares sales exclusively for consumidor final and rejects client records before any local write', async () => {
  const setup = await fixture();
  try {
    const opened = await setup.pos.open(actor, { cashRegisterId: register, openingCash: '0.00' });
    const input = { sessionId: opened.sessionId, lines: [{ itemId: org, quantity: '1' }] };
    const sale = await setup.pos.prepareSale(actor, input);
    expect(sale).toMatchObject({ customerId: null, customerKind: 'CONSUMER_FINAL', sessionId: opened.sessionId });
    expect(await setup.db.getEncrypted(actor, 'sale-draft', sale.id)).toBeDefined();
    const records = await setup.db.records.count();
    const pending = await setup.db.deliveryBytes();
    await expect(setup.pos.prepareSale(actor, { ...input, customerId: org })).rejects.toThrow();
    await expect(setup.pos.prepareSale(actor, { ...input, customer: { name: 'Private client', taxId: '20345678901' } })).rejects.toThrow();
    await expect(setup.pos.prepareSale(actor, { ...input, sessionId: org })).rejects.toThrow();
    expect(await setup.db.records.count()).toBe(records);
    expect(await setup.db.deliveryBytes()).toEqual(pending);
  } finally { setup.db.close(); }
});

it('T192 expiry during the IndexedDB commit aborts every opening effect', async () => {
  const setup = await fixture();
  let clock = now;
  try {
    const authorization = new OfflineAuthorization(setup.db, setup.keys, setup.trusted, 'trusted', () => clock);
    const pos = new OfflinePos(setup.db, setup.keys, authorization,
      new OfflineSealer(setup.db, setup.keys, new OfflineLease(setup.db), { certificate: 'opaque', publication: setup.bootstrap.ingestionKey,
        trustedSigner: setup.trusted, trustedSigningKeyId: 'trusted' }), async () => {});
    const expire = (_key: unknown, row: { kind: string }) => { if (row.kind === 'operation') clock = setup.claims.exp * 1000; };
    setup.db.records.hook('creating', expire);
    await expect(pos.open(actor, { cashRegisterId: register, openingCash: '0.00' })).rejects.toThrow('venció');
    setup.db.records.hook('creating').unsubscribe(expire);
    expect(await setup.db.delivery_queue.count()).toBe(0);
    expect((await setup.db.meta.get('device-chain'))?.sequence).toBe('0');
    expect((await setup.db.meta.get('device-chain'))?.cashSessionOpen).not.toBe(true);
    expect(await setup.db.records.count()).toBe(1);
  } finally { setup.db.close(); }
});
