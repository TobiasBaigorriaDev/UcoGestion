import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { expect,it } from 'vitest';
import { findLocalCashDevice } from '../src/features/cash/cash-api';
import { OfflineDatabase } from '../src/offline/offline-database';
import { base64 } from '../src/offline/offline-crypto';

it('matches an actual non-exportable private device key and refuses another key or revocation',async()=>{
  const org=crypto.randomUUID(),device=crypto.randomUUID(),db=new OfflineDatabase(org,device);
  try {
    const pair=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},false,['sign','verify']);
    const other=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},false,['sign','verify']);
    const wrappingKey=await crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);
    await db.device_keys.add({id:'device',signingKey:pair.privateKey,publicKey:pair.publicKey,wrappingKey});
    const pem=async(key:CryptoKey)=>`-----BEGIN PUBLIC KEY-----\n${base64(new Uint8Array(await crypto.subtle.exportKey('spki',key)))}\n-----END PUBLIC KEY-----\n`;
    expect(await findLocalCashDevice(org,[{id:device,status:'ACTIVE',publicKey:await pem(other.publicKey)}])).toBeUndefined();
    expect(await findLocalCashDevice(org,[{id:device,status:'ACTIVE',publicKey:await pem(pair.publicKey)}])).toBe(device);
    expect(await findLocalCashDevice(org,[{id:device,status:'REVOKED',publicKey:await pem(pair.publicKey)}])).toBeUndefined();
    await db.device_keys.put({id:'device',signingKey:pair.privateKey,publicKey:pair.publicKey,wrappingKey,revoked:true});
    expect(await findLocalCashDevice(org,[{id:device,status:'ACTIVE',publicKey:await pem(pair.publicKey)}])).toBeUndefined();
    expect(pair.privateKey.extractable).toBe(false);
  } finally {db.close();await Dexie.delete(OfflineDatabase.nameFor(org,device));}
});
