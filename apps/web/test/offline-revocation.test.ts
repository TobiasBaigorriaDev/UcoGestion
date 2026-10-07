import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { afterEach, describe, expect, it } from 'vitest';
import { OfflineRevocation } from '../src/offline/offline-revocation';
import { OfflineDatabase } from '../src/offline/offline-database';
import { actor,org,device } from './offline-authorization.fixture';
import { posFixture,register } from './offline-pos.fixture';
afterEach(()=>Dexie.delete(OfflineDatabase.nameFor(org,device)));
describe('T205/T206 irreversible local revocation',()=>{
  for (const target of [null,actor]) {
    it(`blocks reading/unlock/creation and preserves opaque delivery for ${target ?? 'device'}`,async()=>{
      const setup=await posFixture();await setup.pos.open(actor,{cashRegisterId:register,openingCash:'0.00'});
      const before=await setup.db.deliveryBytes();
      await new OfflineRevocation(setup.db,setup.keys).learn(target);
      await expect(setup.pos.catalog(actor)).rejects.toThrow();
      await expect(setup.keys.unlock(actor,'offline-pin')).rejects.toThrow();
      await expect(setup.pos.open(actor,{cashRegisterId:register,openingCash:'0.00'})).rejects.toThrow();
      expect(await setup.db.deliveryBytes()).toEqual(before);
      const checkpoint=(await setup.db.device_keys.get('device'))?.knowledge?.[0];
      expect(checkpoint).toMatchObject({sequence:'1',actorUserId:target});
      setup.db.close();const reopened=new OfflineDatabase(org,device);await reopened.open();
      expect((await reopened.device_keys.get('device'))?.knowledge?.[0]).toEqual(checkpoint);reopened.close();
    });
  }
});
