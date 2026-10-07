/* global window, crypto */
// eslint-disable-next-line @typescript-eslint/no-unused-expressions
async page=>{
 const check=(value,message)=>{if (!value) throw new Error(message);};
 const url='http://127.0.0.1:4179/apps/web/test/browser/offline-pos.html';
 await page.goto(url);await page.waitForFunction(()=>Boolean(window.posHarness));await page.evaluate(()=>window.posHarness.initialize());
 const opening=await page.evaluate(()=>window.posHarness.open());
 const draft=await page.evaluate(id=>window.posHarness.prepare(id),opening.sessionId);
 const before=await page.evaluate(()=>window.posHarness.state());
 await page.evaluate(()=>window.posHarness.freeze(crypto.randomUUID()));
 const second=await page.context().newPage();await second.goto(url);await second.waitForFunction(()=>Boolean(window.posHarness));await second.evaluate(()=>window.posHarness.resume());
 check(await second.evaluate(async id=>{try {await window.posHarness.confirm(id);return false;}catch(error){return error.message==='OFFLINE_CONFIGURATION_FROZEN';}},draft.id),'Other tab bypassed durable freeze');
 await second.close();await page.context().setOffline(true);
 check(await page.evaluate(async()=>{try {await window.posHarness.checkpoints();return false;}catch(error){return error.message==='OFFLINE_PENDING';}}),'Checkpoint released pending queue');
 await page.context().setOffline(false);await page.reload();await page.waitForFunction(()=>Boolean(window.posHarness));await page.evaluate(()=>window.posHarness.resume());
 check(await page.evaluate(async id=>{try {await window.posHarness.confirm(id);return false;}catch(error){return error.message==='OFFLINE_CONFIGURATION_FROZEN';}},draft.id),'Reload lost freeze');
 check(JSON.stringify(before.pending)===JSON.stringify((await page.evaluate(()=>window.posHarness.state())).pending),'Barrier altered sealed bytes');
 await page.evaluate(()=>window.posHarness.revoke('33333333-3333-4333-8333-333333333333'));
 check(await page.evaluate(async()=>{try {await window.posHarness.catalog();return false;}catch{return true;}}),'Revocation allowed private catalogue read');
 check(JSON.stringify(before.pending)===JSON.stringify((await page.evaluate(()=>window.posHarness.state())).pending),'Revocation changed pending bytes');
 return {passed:true,scenarios:['durable-freeze','two-tabs','pending-checkpoint-denial','network-loss','reload','member-revocation','no-private-read','exact-byte-preservation']};
}
