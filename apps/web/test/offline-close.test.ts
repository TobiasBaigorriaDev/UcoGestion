import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { afterEach, expect, it } from 'vitest';
import { OfflineCloseBarrier } from '../src/offline/offline-close';
import { OfflineDatabase } from '../src/offline/offline-database';
import { OfflineLease } from '../src/offline/offline-lease';
import { actor, org, device } from './offline-authorization.fixture';
import { posFixture, register } from './offline-pos.fixture';
import { bytes,unbase64 } from '../src/offline/offline-crypto';

afterEach(async () => { await Dexie.delete(OfflineDatabase.nameFor(org, device)); });

it('T214A freezes creation across reload and preserves sealed retries when drain fails', async () => {
  const setup = await posFixture();
  try {
    const opened = await setup.pos.open(actor, { cashRegisterId: register, openingCash: '0.00' });
    const draft = await setup.pos.prepareSale(actor, { sessionId: opened.sessionId, lines: [{ itemId: org, quantity: '1' }] });
    const request = { draftId: draft.id, payments: [{ method: 'CASH', appliedAmount: '10.00' }] };
    const sale = await setup.pos.confirmSale(actor, request);
    const before = await setup.db.deliveryBytes();
    const barrier = new OfflineCloseBarrier(setup.db);
    await expect(barrier.prepare(opened.sessionId)).rejects.toThrow('OFFLINE_PENDING');
    setup.db.close(); await setup.db.open();
    expect(await setup.pos.confirmSale(actor, request)).toEqual(sale);
    const fresh = await setup.pos.prepareSale(actor, { sessionId: opened.sessionId, lines: [{ itemId: org, quantity: '1' }] });
    await expect(setup.pos.confirmSale(actor, { ...request, draftId: fresh.id })).rejects.toThrow('OFFLINE_SESSION_CLOSING');
    expect(await setup.db.deliveryBytes()).toEqual(before);
    expect((await setup.db.meta.get('device-chain'))?.sequence).toBe('2');
  } finally { setup.db.close(); }
});

it('T214A keeps the freeze after a failed drain and serializes it with sealing', async () => {
  const setup = await posFixture();
  try {
    const sessionId = crypto.randomUUID();
    const barrier = new OfflineCloseBarrier(setup.db);
    const leases = new OfflineLease(setup.db);
    const lease = await leases.acquire('in-flight-sale');
    await expect(barrier.freeze(sessionId)).rejects.toThrow('lease busy');
    expect((await setup.db.device_keys.get('device'))?.closingSessions).toBeUndefined();
    await leases.release(lease);
    await expect(barrier.prepare(sessionId, async () => { throw new Error('Network lost'); }))
      .rejects.toThrow('Network lost');
    expect((await setup.db.device_keys.get('device'))?.closingSessions).toEqual([sessionId]);
    await barrier.prepare(sessionId);
    const opened = await setup.pos.open(actor, { cashRegisterId: register, openingCash: '0.00' });
    expect(opened.sessionId).not.toBe(sessionId);
  } finally { setup.db.close(); }
});

it('T218B signs a stable frozen checkpoint, rejects a mismatched server chain and releases only after a verified abort',async()=>{
  const setup=await posFixture();
  try {
    const sessionId=crypto.randomUUID(),barrier=new OfflineCloseBarrier(setup.db);
    const chain={sequence:'0',headHash:'0'.repeat(64),sessionSequence:'0'};
    await expect(barrier.checkpoint(actor,sessionId,async()=>({...chain,sequence:'1'}))).rejects.toThrow('OFFLINE_CHECKPOINT_INVALID');
    const signed=await barrier.checkpoint(actor,sessionId,async()=>chain);
    const key=await setup.db.device_keys.get('device');
    if(!key)throw new Error('Missing device signer');
    expect(await crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},key.publicKey,bytes(unbase64(signed.signature)),
      new TextEncoder().encode(JSON.stringify(signed.checkpoint)))).toBe(true);
    setup.db.close();await setup.db.open();
    expect(await barrier.checkpoint(actor,sessionId,async()=>chain)).toEqual(signed);
    await expect(barrier.releaseAfterAbort(sessionId,crypto.randomUUID(),{cashSessionId:crypto.randomUUID(),
      closeAttemptId:crypto.randomUUID(),status:'OPEN'})).rejects.toThrow('OFFLINE_CHECKPOINT_INVALID');
    expect((await setup.db.device_keys.get('device'))?.closingSessions).toContain(sessionId);
    const attempt=crypto.randomUUID();
    await barrier.releaseAfterAbort(sessionId,attempt,{cashSessionId:sessionId,closeAttemptId:attempt,status:'OPEN'});
    expect((await setup.db.device_keys.get('device'))?.closingSessions).not.toContain(sessionId);
    expect((await setup.db.meta.get('device-chain'))?.sequence).toBe('0');
  }finally{setup.db.close();}
});

it('T218B releases a completed local session without consuming sequence or unlocking a newer session',async()=>{
  const setup=await posFixture();
  try {
    const first=await setup.pos.open(actor,{cashRegisterId:register,openingCash:'0.00'}),barrier=new OfflineCloseBarrier(setup.db);
    const response={cashSessionId:first.sessionId,status:'CLOSED',closeAttemptId:crypto.randomUUID()};
    await expect(barrier.completeAfterClose(first.sessionId,response)).rejects.toThrow('OFFLINE_PENDING');
    expect((await setup.db.meta.get('device-chain'))?.cashSessionOpen).toBe(true);
    // Unit storage precondition: transport ACK verification itself is covered by OpaqueDelivery tests.
    await setup.db.delivery_queue.clear();
    await barrier.completeAfterClose(first.sessionId,response);
    expect((await setup.db.meta.get('device-chain'))?.cashSessionOpen).toBe(false);
    expect((await setup.db.meta.get('device-chain'))?.sequence).toBe('1');
    const second=await setup.pos.open(actor,{cashRegisterId:register,openingCash:'0.00'});
    await setup.db.delivery_queue.clear();
    await expect(barrier.completeAfterClose(first.sessionId,response)).rejects.toThrow('OFFLINE_CHECKPOINT_INVALID');
    expect((await setup.db.meta.get('device-chain'))?.cashSessionOpen).toBe(true);
    expect((await setup.db.meta.get('device-chain'))?.sequence).toBe('2');
    expect(second.sessionId).not.toBe(first.sessionId);
  }finally{setup.db.close();}
});
