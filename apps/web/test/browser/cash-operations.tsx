import React from 'react';
import { createRoot } from 'react-dom/client';
import { CashWorkspace } from '../../src/features/cash/cash-workspace';
import { RemoteProvider } from '../../src/features/identity/remote-provider';
import { OnlineOnlyBoundary } from '../../src/offline/online-only-boundary';
import { OfflineDatabase } from '../../src/offline/offline-database';
import { base64 } from '../../src/offline/offline-crypto';

const org='00000000-0000-4000-8000-000000000001',branch='00000000-0000-4000-8000-000000000002';
const device='00000000-0000-4000-8000-000000000003',register='00000000-0000-4000-8000-000000000004';
const db=new OfflineDatabase(org,device);
let keys=await db.device_keys.get('device');
if (!keys) {
  const pair=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},false,['sign','verify']);
  keys={id:'device',signingKey:pair.privateKey,publicKey:pair.publicKey,
    wrappingKey:await crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt'])};
  await db.device_keys.add(keys);
}
const pem=`-----BEGIN PUBLIC KEY-----\n${base64(new Uint8Array(await crypto.subtle.exportKey('spki',keys.publicKey)))}\n-----END PUBLIC KEY-----\n`;
Object.assign(window,{cashHarness:{organizationId:org,branchId:branch,deviceId:device,registerId:register,
  data:{actorUserId:org,registers:[{id:register,name:'Mostrador',available:true}],devices:[{id:device,status:'ACTIVE',publicKey:pem}],sessions:[]}}});
db.close();
document.documentElement.style.setProperty('--font-plus-jakarta','"Plus Jakarta Sans", "Plus Jakarta Sans Fallback"');
document.body.style.padding='24px';
const root=document.getElementById('root');
if (!root) throw new Error('Root missing');
createRoot(root).render(<OnlineOnlyBoundary><RemoteProvider><CashWorkspace organizationId={org} branchId={branch} role="OWNER"/></RemoteProvider></OnlineOnlyBoundary>);
