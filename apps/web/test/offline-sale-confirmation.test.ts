import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { afterEach, expect, it } from 'vitest';
import { OfflineDatabase } from '../src/offline/offline-database';
import { actor, org, device } from './offline-authorization.fixture';
import { posFixture, register } from './offline-pos.fixture';

afterEach(async () => { await Dexie.delete(OfflineDatabase.nameFor(org, device)); });

it('T196 revalidates the signed discount permission and persists evidence', async () => {
  const setup = await posFixture();
  try {
    const opened = await setup.pos.open(actor, { cashRegisterId: register, openingCash: '0.00' });
    const draft = await setup.pos.prepareSale(actor, { sessionId: opened.sessionId, lines: [{ itemId: org, quantity: '1' }],
      discount: { kind: 'FIXED', value: '2.00' } });
    expect(await setup.plaintext('sale-draft', draft.id)).toMatchObject({ quote: { total: '8.00', discountEvidence: {
      actorUserId: actor, grantId: setup.claims.grantId, role: 'OWNER', amount: '2.00',
    } } });
  } finally { setup.db.close(); }
});

it('T196 rejects cashier discounts and item price overrides without writing', async () => {
  const setup = await posFixture(bootstrap => { bootstrap.role = 'CASHIER'; bootstrap.permissions.canDiscount = false; });
  try {
    const opened = await setup.pos.open(actor, { cashRegisterId: register, openingCash: '0.00' });
    const before = await setup.db.records.count();
    await expect(setup.pos.prepareSale(actor, { sessionId: opened.sessionId, lines: [{ itemId: org, quantity: '1' }],
      discount: { kind: 'PERCENTAGE', value: '0' } })).rejects.toThrow('no autorizado');
    await expect(setup.pos.prepareSale(actor, { sessionId: opened.sessionId,
      lines: [{ itemId: org, quantity: '1', unitPrice: '0.01' }] })).rejects.toThrow();
    expect(await setup.db.records.count()).toBe(before);
  } finally { setup.db.close(); }
});

it('T197 confirms sale, payments and sealed operation atomically with stable identity and replay', async () => {
  const setup = await posFixture();
  try {
    const opened = await setup.pos.open(actor, { cashRegisterId: register, openingCash: '0.00' });
    const draft = await setup.pos.prepareSale(actor, { sessionId: opened.sessionId, lines: [{ itemId: org, quantity: '2' }] });
    const request = { draftId: draft.id, payments: [{ method: 'CASH', appliedAmount: '20.00', receivedAmount: '25.00' }] };
    const sale = await setup.pos.confirmSale(actor, request);
    expect(sale).toMatchObject({ id: draft.id, operationId: draft.id, total: '20.00', change: '5.00' });
    expect(sale.localReference).toContain('OFF-');
    expect(await setup.plaintext('sale', sale.id)).toMatchObject({ id: draft.id, localReference: sale.localReference,
      status: 'CONFIRMED', reference: null, quote: { total: '20.00' },
      payments: [{ method: 'CASH', appliedAmount: '20.00', receivedAmount: '25.00', changeAmount: '5.00' }],
      audit: { action: 'sale.confirmed.offline', actorUserId: actor }, receipt: { label: 'Comprobante no fiscal' } });
    expect(await setup.plaintext('operation', sale.id)).toMatchObject({ operation: { id: draft.id, kind: 'sale-confirm',
      sequence: '2', payload: { id: draft.id, localReference: sale.localReference, payments: request.payments.map(payment => ({
        ...payment, changeAmount: '5.00',
      })) } } });
    const pending = await setup.db.deliveryBytes();
    expect(pending).toHaveLength(2);
    setup.db.close(); await setup.db.open();
    expect(await setup.pos.confirmSale(actor, request)).toEqual(sale);
    expect(await setup.db.deliveryBytes()).toEqual(pending);
    await expect(setup.pos.confirmSale(actor, { ...request, payments: [{ method: 'CASH', appliedAmount: '19.00' }] }))
      .rejects.toThrow('distinto');
    expect(await setup.db.deliveryBytes()).toEqual(pending);
  } finally { setup.db.close(); }
});

it('T197 rolls back all sale effects and preserves retry identity when the envelope write fails', async () => {
  const setup = await posFixture();
  try {
    const opened = await setup.pos.open(actor, { cashRegisterId: register, openingCash: '0.00' });
    const draft = await setup.pos.prepareSale(actor, { sessionId: opened.sessionId, lines: [{ itemId: org, quantity: '1' }] });
    const request = { draftId: draft.id, payments: [{ method: 'CASH', appliedAmount: '10.00' }] };
    const fail = () => { throw new Error('Envelope write failed'); };
    setup.db.delivery_queue.hook('creating', fail);
    await expect(setup.pos.confirmSale(actor, request)).rejects.toThrow('Envelope write failed');
    expect(await setup.db.getEncrypted(actor, 'sale', draft.id)).toBeUndefined();
    expect((await setup.db.meta.get('device-chain'))?.sequence).toBe('1');
    expect(await setup.db.delivery_queue.count()).toBe(1);
    setup.db.delivery_queue.hook('creating').unsubscribe(fail);
    expect((await setup.pos.confirmSale(actor, request)).id).toBe(draft.id);
    expect(await setup.db.delivery_queue.count()).toBe(2);
  } finally { setup.db.close(); }
});

it('T197 validates payment methods, change, zero total and current item knowledge', async () => {
  const setup = await posFixture();
  try {
    const opened = await setup.pos.open(actor, { cashRegisterId: register, openingCash: '0.00' });
    const draft = await setup.pos.prepareSale(actor, { sessionId: opened.sessionId, lines: [{ itemId: org, quantity: '1' }] });
    for (const payments of [[], [{ method: 'QR', appliedAmount: '10.00' }],
      [{ method: 'CASH', appliedAmount: '10.00', receivedAmount: '9.00' }], [{ method: 'CASH', appliedAmount: '0.00' }]]) {
      await expect(setup.pos.confirmSale(actor, { draftId: draft.id, payments })).rejects.toThrow();
    }
    const free = await setup.pos.prepareSale(actor, { sessionId: opened.sessionId, lines: [{ itemId: org, quantity: '1' }],
      discount: { kind: 'PERCENTAGE', value: '100' } });
    await expect(setup.pos.confirmSale(actor, { draftId: free.id, payments: [{ method: 'CASH', appliedAmount: '0.00' }] })).rejects.toThrow();
    const sale = await setup.pos.confirmSale(actor, { draftId: free.id, payments: [] });
    expect(await setup.plaintext('sale', sale.id)).toMatchObject({ payments: [], quote: { total: '0.00' } });
  } finally { setup.db.close(); }
});

it('T195 rejects a draft when newer signed knowledge removes an item', async () => {
  const setup = await posFixture();
  try {
    const opened = await setup.pos.open(actor, { cashRegisterId: register, openingCash: '0.00' });
    const draft = await setup.pos.prepareSale(actor, { sessionId: opened.sessionId, lines: [{ itemId: org, quantity: '1' }] });
    setup.bootstrap.configuration.items = [];
    const signed = setup.signedBootstrap();
    const { createHash } = await import('node:crypto');
    const grant = setup.jwt({ ...setup.claims, bootstrapHash: createHash('sha256').update(signed.payload).digest('hex') });
    await setup.authorization.install(actor, signed, grant);
    await expect(setup.pos.confirmSale(actor, { draftId: draft.id, payments: [{ method: 'CASH', appliedAmount: '10.00' }] }))
      .rejects.toThrow('no disponible');
    expect(await setup.db.delivery_queue.count()).toBe(1);
  } finally { setup.db.close(); }
});

it('T197 updates stock and expected cash in the same commit and prevents overconsumption', async () => {
  const setup = await posFixture(bootstrap => {
    bootstrap.configuration.items = bootstrap.configuration.items.map(item => ({ ...item, trackInventory: true }));
    bootstrap.stock = [{ itemId: org, quantity: '2.000' }];
  });
  try {
    const opened = await setup.pos.open(actor, { cashRegisterId: register, openingCash: '5.00' });
    const first = await setup.pos.prepareSale(actor, { sessionId: opened.sessionId, lines: [{ itemId: org, quantity: '2' }] });
    await setup.pos.confirmSale(actor, { draftId: first.id, payments: [{ method: 'CASH', appliedAmount: '20.00', receivedAmount: '25.00' }] });
    expect(await setup.plaintext('stock-projection', `${setup.claims.branchId}:${org}`)).toMatchObject({ remaining: '0.000' });
    expect(await setup.plaintext('cash-projection', opened.sessionId)).toBe('25.00');
    const next = await setup.pos.prepareSale(actor, { sessionId: opened.sessionId, lines: [{ itemId: org, quantity: '1' }] });
    await expect(setup.pos.confirmSale(actor, { draftId: next.id, payments: [{ method: 'CASH', appliedAmount: '10.00' }] }))
      .rejects.toThrow('insuficiente');
    expect(await setup.db.getEncrypted(actor, 'sale', next.id)).toBeUndefined();
    expect(await setup.db.delivery_queue.count()).toBe(2);
  } finally { setup.db.close(); }
});

it('T197 preserves identity isolation and refuses new effects after logout', async () => {
  const setup = await posFixture();
  try {
    const opened = await setup.pos.open(actor, { cashRegisterId: register, openingCash: '0.00' });
    const draft = await setup.pos.prepareSale(actor, { sessionId: opened.sessionId, lines: [{ itemId: org, quantity: '1' }] });
    const request = { draftId: draft.id, payments: [{ method: 'CASH', appliedAmount: '10.00' }] };
    await expect(setup.pos.confirmSale(org, request)).rejects.toThrow();
    const pending = await setup.db.deliveryBytes();
    setup.keys.lock();
    await expect(setup.pos.confirmSale(actor, request)).rejects.toThrow();
    expect(await setup.db.deliveryBytes()).toEqual(pending);
  } finally { setup.db.close(); }
});

it('T198 keeps declared device time separate from reception time through reload', async () => {
  const setup = await posFixture();
  try {
    const opened = await setup.pos.open(actor, { cashRegisterId: register, openingCash: '0.00' });
    const draft = await setup.pos.prepareSale(actor, { sessionId: opened.sessionId, lines: [{ itemId: org, quantity: '1' }] });
    const sale = await setup.pos.confirmSale(actor, { draftId: draft.id, payments: [{ method: 'CASH', appliedAmount: '10.00' }] });
    const operation = await setup.plaintext('operation', sale.id);
    expect(operation).toMatchObject({ operation: { receivedAt: null, occurredAt: expect.any(String),
      payload: { occurredAt: expect.any(String), receivedAt: null } } });
    setup.db.close(); await setup.db.open();
    expect(await setup.plaintext('operation', sale.id)).toEqual(operation);
    const stored = await setup.plaintext('sale', sale.id);
    expect(stored).toMatchObject({ occurredAt: expect.any(String), receivedAt: null });
  } finally { setup.db.close(); }
});
