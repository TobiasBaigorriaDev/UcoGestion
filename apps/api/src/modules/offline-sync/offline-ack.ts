import { sign, verify, type KeyObject } from 'node:crypto';
import { offlineAckClaimsSchema, offlineAckHeaderSchema } from '@uconext/shared';
export interface AckResult { readonly operationId:string;readonly envelopeHash:string;readonly status:'ACKED'|'SECURITY_REJECTED' }
export function signOfflineAck(result:AckResult,key:KeyObject,keyId:string):string {
  const header=Buffer.from(JSON.stringify(offlineAckHeaderSchema.parse({alg:'ES256',typ:'uco-offline-ack+jwt',kid:keyId}))).toString('base64url');
  const body=Buffer.from(JSON.stringify(offlineAckClaimsSchema.parse({...result,version:1,keyId}))).toString('base64url');
  return `${header}.${body}.${sign('sha256',Buffer.from(`${header}.${body}`),{key,dsaEncoding:'ieee-p1363'}).toString('base64url')}`;
}
export function verifyOfflineAck(jwt:string,key:KeyObject,keyId:string,expected:Pick<AckResult,'operationId'|'envelopeHash'>) {
  const [header,body,signature,...extra]=jwt.split('.');
  if (!header || !body || !signature || extra.length || jwt.length>2048) throw new Error('OFFLINE_ACK_INVALID');
  const metadata=offlineAckHeaderSchema.parse(JSON.parse(Buffer.from(header,'base64url').toString()));
  const claims=offlineAckClaimsSchema.parse(JSON.parse(Buffer.from(body,'base64url').toString()));
  const sig=Buffer.from(signature,'base64url');
  if (sig.length!==64 || sig.toString('base64url')!==signature || metadata.kid!==keyId || claims.keyId!==keyId ||
    claims.operationId!==expected.operationId || claims.envelopeHash!==expected.envelopeHash ||
    !verify('sha256',Buffer.from(`${header}.${body}`),{key,dsaEncoding:'ieee-p1363'},sig)) throw new Error('OFFLINE_ACK_INVALID');
  return claims;
}
