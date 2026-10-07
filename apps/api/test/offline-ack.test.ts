import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { signOfflineAck, verifyOfflineAck } from '../src/modules/offline-sync/offline-ack.js';

describe('T202A minimal signed definitive ACK',()=>{
  const keys=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
  const result={operationId:randomUUID(),envelopeHash:'a'.repeat(64),status:'ACKED' as const};
  it('authenticates applied/conflicted and security-rejected results without commercial data',()=>{
    for (const status of ['ACKED','SECURITY_REJECTED'] as const) {
      const jwt=signOfflineAck({...result,status},keys.privateKey,'retained');
      expect(verifyOfflineAck(jwt,keys.publicKey,'retained',result)).toEqual({...result,status,version:1,keyId:'retained'});
    }
  });
  it('rejects falsification, unknown key and wrong operation/envelope before deletion',()=>{
    const jwt=signOfflineAck(result,keys.privateKey,'retained');
    for (const [value,key,id] of [[`${jwt}x`,'retained',result.operationId],[jwt,'unknown',result.operationId],[jwt,'retained',randomUUID()]] as const) {
      expect(()=>verifyOfflineAck(value,keys.publicKey,key,{...result,operationId:id})).toThrow();
    }
  });
});
