import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { afterEach, describe, expect, it } from 'vitest';
import { OpaqueDelivery, startOpaqueDelivery } from '../src/offline/opaque-delivery';
import { OfflineDatabase } from '../src/offline/offline-database';
import { base64 } from '../src/offline/offline-crypto';
const org='11111111-1111-4111-8111-111111111111',device='22222222-2222-4222-8222-222222222222';
afterEach(()=>Dexie.delete(OfflineDatabase.nameFor(org,device)));
async function ackFixture(status: 'ACKED' | 'SECURITY_REJECTED') {
  const db = new OfflineDatabase(org, device); await db.open();
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const wrappingKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  await db.device_keys.add({ id: 'device', signingKey: pair.privateKey, publicKey: pair.publicKey, wrappingKey, ackKeys: { trusted: pair.publicKey } });
  const id = crypto.randomUUID(), envelope = new TextEncoder().encode('sealed immutable bytes');
  await db.enqueueOpaque(id, envelope);
  for (const kind of ['operation', 'sale', 'sale-draft']) await db.putEncrypted('alice', kind, id, new Uint8Array([1, 2]));
  const envelopeHash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', envelope)), v => v.toString(16).padStart(2, '0')).join('');
  const url = (value: Uint8Array) => base64(value).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const header = url(new TextEncoder().encode(JSON.stringify({ alg: 'ES256', typ: 'uco-offline-ack+jwt', kid: 'trusted' })));
  const body = url(new TextEncoder().encode(JSON.stringify({ version: 1, operationId: id, envelopeHash, status, keyId: 'trusted' })));
  const signature = url(new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, new TextEncoder().encode(`${header}.${body}`))));
  return { db, id, envelopeHash, jwt: `${header}.${body}.${signature}`, delivery: new OpaqueDelivery(db) };
}

for (const status of ['ACKED', 'SECURITY_REJECTED'] as const) {
  it(`T220 atomically removes payload/transport and retains only minimum ${status} evidence`, async () => {
    const setup = await ackFixture(status);
    await setup.delivery.acceptAck(setup.jwt, await setup.db.deliveryBytes());
    expect(await setup.db.records.count()).toBe(0);
    expect(await setup.db.delivery_queue.count()).toBe(0);
    expect(await setup.db.delivery_receipts.toArray()).toEqual([{ id: setup.id, status, envelopeHash: setup.envelopeHash }]);
    setup.db.close();
  });
}

it('T220 cleanup failure rolls back receipt, every payload and exact envelope', async () => {
  const setup = await ackFixture('SECURITY_REJECTED');
  const before = await setup.db.deliveryBytes();
  const fail = () => { throw new Error('Receipt write failure'); };
  setup.db.delivery_receipts.hook('creating', fail);
  await expect(setup.delivery.acceptAck(setup.jwt, before)).rejects.toThrow('Receipt write failure');
  expect(await setup.db.deliveryBytes()).toEqual(before);
  expect(await setup.db.records.count()).toBe(3);
  setup.db.delivery_receipts.hook('creating').unsubscribe(fail);
  await setup.delivery.acceptAck(setup.jwt, before);
  expect(await setup.db.delivery_receipts.count()).toBe(1);
  setup.db.close();
});
describe('T202/T202A/T203 opaque delivery without an actor session',()=>{
  it('preserves exact bytes on uncertain response and verifies ACK before deleting atomically',async()=>{
    const db=new OfflineDatabase(org,device);await db.open();
    const keys=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},false,['sign','verify']);
    const wrappingKey=await crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);
    await db.device_keys.add({id:'device',signingKey:keys.privateKey,publicKey:keys.publicKey,wrappingKey,ackKeys:{trusted:keys.publicKey}});
    const id=crypto.randomUUID(), envelope=new TextEncoder().encode(JSON.stringify({operationId:id,certificate:'opaque',ciphertext:'bytes'}));
    await db.enqueueOpaque(id,envelope);
    await db.putEncrypted('alice','operation',id,new Uint8Array([1,2]));
    let pushCount=0;const batches:string[][]=[];
    const fetcher:typeof fetch=async(url,init)=>{
      if (String(url).endsWith('/challenge')) return Response.json({challenge:'nonce'});
      const body=JSON.parse(String(init?.body));batches.push(body.envelopes);pushCount++;
      if (pushCount===1) throw new Error('Lost response after server commit');
      const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',envelope)),v=>v.toString(16).padStart(2,'0')).join('');
      const header=btoa(JSON.stringify({alg:'ES256',typ:'uco-offline-ack+jwt',kid:'trusted'})).replace(/=/g,'');
      const payload=btoa(JSON.stringify({version:1,operationId:id,envelopeHash:hash,status:'ACKED',keyId:'trusted'})).replace(/=/g,'');
      const signature=base64(new Uint8Array(await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},keys.privateKey,new TextEncoder().encode(`${header}.${payload}`)))).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
      return Response.json({acks:[`${header}.${payload}.${signature}`]});
    };
    const delivery=new OpaqueDelivery(db,fetcher);
    await expect(delivery.flush()).rejects.toThrow('Lost response');
    expect((await db.deliveryBytes())[0]?.envelope).toEqual(envelope);
    const persistedDevice=await db.device_keys.get('device');
    if (!persistedDevice) throw new Error('Missing device');
    await db.device_keys.put({...persistedDevice,revoked:true});
    await delivery.flush();expect(batches[0]).toEqual(batches[1]);
    expect(await db.deliveryBytes()).toEqual([]);
    expect(await db.getEncrypted('alice','operation',id)).toBeUndefined();
    expect(await db.device_keys.get('device')).toBeUndefined();
    expect((await db.meta.get('device-chain'))?.deviceRevoked).toBe(true);
    db.close();
  });
  it('starts on online, foreground and manual triggers without Background Sync',async()=>{
    let calls=0;
    const stop=startOpaqueDelivery(async()=>{calls++;},window,document);
    window.dispatchEvent(new Event('online'));window.dispatchEvent(new Event('uco:sync'));
    document.dispatchEvent(new Event('visibilitychange'));
    await new Promise(resolve=>setTimeout(resolve,0));
    expect(calls).toBeGreaterThanOrEqual(1);
    stop();const before=calls;window.dispatchEvent(new Event('online'));
    expect(calls).toBe(before);
  });
});
