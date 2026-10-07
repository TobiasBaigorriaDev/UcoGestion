import 'fake-indexeddb/auto';
import { createHash } from 'node:crypto';
import Dexie from 'dexie';
import { afterEach, describe, expect, it } from 'vitest';
import { OfflineConfigurationBarrier } from '../src/offline/offline-configuration-barrier';
import { OfflineDatabase } from '../src/offline/offline-database';
import { actor,org,device } from './offline-authorization.fixture';
import { posFixture,register } from './offline-pos.fixture';
afterEach(()=>Dexie.delete(OfflineDatabase.nameFor(org,device)));
describe('T208A durable D01 freeze',()=>{
  it('serializes freeze with sealing and persists it across tabs/reload until renewal',async()=>{
    const setup=await posFixture();
    await setup.pos.open(actor,{cashRegisterId:register,openingCash:'0.00'});
    const barrier={id:crypto.randomUUID(),epoch:1};
    const local=new OfflineConfigurationBarrier(setup.db,setup.authorization);
    await local.freeze(barrier);
    const pending=await setup.db.deliveryBytes();
    await expect(setup.pos.open(actor,{cashRegisterId:register,openingCash:'0.00'})).rejects.toThrow('OFFLINE_CONFIGURATION_FROZEN');
    await expect(local.checkpoints()).rejects.toThrow('OFFLINE_PENDING');
    await expect(local.resume(actor)).rejects.toThrow('OFFLINE_CONFIGURATION_FROZEN');
    setup.db.close();const reopened=new OfflineDatabase(org,device);await reopened.open();
    expect((await reopened.device_keys.get('device'))?.freeze).toMatchObject(barrier);
    expect(await reopened.deliveryBytes()).toEqual(pending);reopened.close();
  });
  it('releases the freeze only after a newly signed epoch and an empty queue',async()=>{
    const setup=await posFixture();const local=new OfflineConfigurationBarrier(setup.db,setup.authorization);
    await local.freeze({id:crypto.randomUUID(),epoch:1});
    await expect(local.resume(actor)).rejects.toThrow('OFFLINE_CONFIGURATION_FROZEN');
    const bootstrap={...setup.bootstrap,epoch:'2',configurationVersion:'2',grantId:crypto.randomUUID()};
    const signed=setup.signedBootstrap(bootstrap);
    const claims={...setup.claims,epoch:'2',configurationVersion:'2',grantId:bootstrap.grantId,bootstrapHash:createHash('sha256').update(signed.payload).digest('hex')};
    await setup.authorization.install(actor,signed,setup.jwt(claims));
    await local.resume(actor);expect((await setup.db.device_keys.get('device'))?.freeze).toBeUndefined();
    expect((await setup.authorization.require(actor)).claims.epoch).toBe('2');setup.db.close();
  });

});
