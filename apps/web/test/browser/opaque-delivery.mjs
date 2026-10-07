/* global window */
// eslint-disable-next-line @typescript-eslint/no-unused-expressions
async page=>{
 const check=(value,message)=>{if (!value) throw new Error(message);};
 const url='http://127.0.0.1:4179/apps/web/test/browser/opaque-delivery.html';
 const control=body=>page.request.post('http://127.0.0.1:4179/test-delivery/control',{data:body});
 await page.goto(url);await page.waitForFunction(()=>Boolean(window.deliveryHarness));
 await page.evaluate(()=>window.deliveryHarness.initialize());await page.evaluate(()=>window.deliveryHarness.enqueue());
 const original=await page.evaluate(()=>window.deliveryHarness.state());
 await page.context().setOffline(true);
 check(await page.evaluate(async()=>{try {await window.deliveryHarness.flush();return false;}catch{return true;}}),'Offline push unexpectedly completed');
 check(JSON.stringify(original)===JSON.stringify(await page.evaluate(()=>window.deliveryHarness.state())),'Lost network altered sealed bytes');
 await page.context().setOffline(false);await control({failNext:true});
 check(await page.evaluate(async()=>{try {await window.deliveryHarness.flush();return false;}catch{return true;}}),'Uncertain response deleted pending');
 await page.reload();await page.waitForFunction(()=>Boolean(window.deliveryHarness));await page.evaluate(()=>window.deliveryHarness.reopen());
 check(JSON.stringify(original)===JSON.stringify(await page.evaluate(()=>window.deliveryHarness.state())),'Reload changed pending bytes');
 await control({forgeNext:true});
 check(await page.evaluate(async()=>{try {await window.deliveryHarness.flush();return false;}catch{return true;}}),'Forged ACK accepted');
 check(JSON.stringify(original)===JSON.stringify(await page.evaluate(()=>window.deliveryHarness.state())),'Forged ACK changed records');
 await page.evaluate(()=>window.deliveryHarness.flush());
 check((await page.evaluate(()=>window.deliveryHarness.state())).pending.length===0,'Verified ACK failed cleanup');
 await page.evaluate(()=>window.deliveryHarness.enqueue());await page.evaluate(()=>window.deliveryHarness.worker());
 await page.waitForFunction(async()=>Boolean((await window.deliveryHarness.state()).pending[0]?.ack));
 const workerState=await page.evaluate(()=>window.deliveryHarness.state());
 check(workerState.records===1 && workerState.pending.length===1,'Worker accessed identity payload cleanup');
 await page.evaluate(()=>window.deliveryHarness.flush());
 const final=await page.evaluate(()=>window.deliveryHarness.state());check(final.records===0 && final.pending.length===0,'Foreground cleanup was incomplete');
 return {passed:true,scenarios:['logout-delivery','network-loss','uncertain-response','reload','exact-envelope-retry','forged-ack','signed-ack','native-service-worker','worker-opaque-only','atomic-cleanup']};
}
