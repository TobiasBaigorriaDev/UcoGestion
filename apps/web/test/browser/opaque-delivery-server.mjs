import { Buffer } from 'node:buffer';
import { createHash,generateKeyPairSync,randomUUID,sign } from 'node:crypto';
const signer=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
let failNext=false,forgeNext=false;
const batches=[];
export function opaqueDeliveryTestServer(server) {
  server.middlewares.use(async(request,response,next)=>{
    const path=request.url?.split('?')[0];
    if (!['/test-delivery/key','/test-delivery/control','/api/v1/offline/delivery/challenge','/api/v1/offline/delivery/push'].includes(path)) return next();
    response.setHeader('Content-Type','application/json');response.setHeader('Cache-Control','no-store');
    if (path==='/test-delivery/key') {response.end(JSON.stringify({publicKey:signer.publicKey.export({type:'spki',format:'der'}).toString('base64')}));return;}
    let text='';for await (const chunk of request) text+=chunk;
    const body=text ? JSON.parse(text):{};
    if (path==='/test-delivery/control') {failNext=Boolean(body.failNext);forgeNext=Boolean(body.forgeNext);response.end(JSON.stringify({batches}));return;}
    if (path.endsWith('/challenge')) {response.end(JSON.stringify({challenge:randomUUID()}));return;}
    batches.push(body.envelopes);
    const acks=body.envelopes.map(envelope=>{
      const header=Buffer.from(JSON.stringify({alg:'ES256',typ:'uco-offline-ack+jwt',kid:'test-ack'})).toString('base64url');
      const claims=Buffer.from(JSON.stringify({version:1,operationId:JSON.parse(envelope).operationId,envelopeHash:createHash('sha256').update(envelope).digest('hex'),status:'ACKED',keyId:'test-ack'})).toString('base64url');
      const signature=sign('sha256',Buffer.from(`${header}.${claims}`),{key:signer.privateKey,dsaEncoding:'ieee-p1363'}).toString('base64url');
      return `${header}.${claims}.${signature}`;
    });
    if (failNext) {failNext=false;response.statusCode=503;response.end('{}');return;}
    if (forgeNext) {forgeNext=false;acks[0]=`${acks[0]}x`;}
    response.end(JSON.stringify({acks}));
  });
}
