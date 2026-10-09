/* global window, document, URL */
// eslint-disable-next-line @typescript-eslint/no-unused-expressions
async page=>{
  await page.context().setOffline(false);
  await page.unroute('**/api/v1/**');
  const check=(condition,message)=>{if(!condition)throw new Error(message);};
  const results=new Map();let state,failed=false,openingKey;
  await page.route('**/api/v1/**',async route=>{
    const request=route.request(),path=new URL(request.url()).pathname;
    if(path==='/api/v1/auth/csrf') return route.fulfill({json:{csrfToken:'browser-csrf'}});
    if(!state) state=await page.evaluate(()=>window.cashHarness.data);
    if(request.method()==='GET') return route.fulfill({json:state});
    const body=request.postDataJSON(),key=request.headers()['idempotency-key'];
    if(results.has(key)) return route.fulfill({status:201,json:results.get(key)});
    if(path.endsWith('/open')) {
      openingKey=key;
      const opened={id:'00000000-0000-4000-8000-000000000005',...body,ownerUserId:state.actorUserId,currencyCode:'ARS'};
      results.set(key,opened);
      state={...state,registers:state.registers.map(row=>({...row,available:false})),sessions:[{...opened,status:'OPEN',
        expectedCash:body.openingCash,registerName:'Mostrador',openedAt:'2026-10-07T00:00:00Z'}]};
      if(!failed) {failed=true;return route.abort('failed');}
      return route.fulfill({status:201,json:opened});
    }
    check(path.endsWith('/manual-deposits'),'Unexpected cash mutation');
    check(body.cashSessionId===state.sessions[0].id && body.deviceId===state.devices[0].id,'Incorrect device binding');
    state.sessions[0].expectedCash='7.00';
    const result={id:'00000000-0000-4000-8000-000000000006',...body,actorUserId:state.actorUserId,expectedCash:'7.00'};
    results.set(key,result);return route.fulfill({status:201,json:result});
  });
  await page.setViewportSize({width:1440,height:1000});
  await page.goto('http://127.0.0.1:4179/apps/web/test/browser/cash-operations.html');
  await page.getByRole('heading',{name:'Abrir sesión',exact:true}).waitFor();
  await page.evaluate(()=>document.fonts.ready);
  await page.screenshot({path:'.impeccable/review/cash-opening-desktop.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});
  check(await page.evaluate(()=>document.documentElement.scrollWidth<=390),'Opening mobile overflow');
  await page.screenshot({path:'.impeccable/review/cash-opening-mobile.png',fullPage:true});
  await page.setViewportSize({width:1440,height:1000});
  await page.getByRole('textbox',{name:'Efectivo inicial'}).fill('5.00');
  await page.getByRole('button',{name:'Abrir sesión',exact:true}).focus();await page.keyboard.press('Enter');
  await page.getByRole('alert').waitFor();
  check(await page.getByRole('alert').evaluate(el=>el===document.activeElement),'Error summary did not receive focus');
  await page.getByRole('button',{name:'Abrir sesión',exact:true}).click();
  await page.getByText('Esperado: 5.00 ARS').waitFor();
  check(results.size===1 && openingKey,'Retry duplicated the opening');
  await page.reload();await page.getByText('Esperado: 5.00 ARS').waitFor();
  await page.getByRole('textbox',{name:'Importe',exact:true}).fill('2.00');
  await page.getByRole('textbox',{name:'Motivo',exact:true}).fill('Cambio de turno');
  await page.getByRole('textbox',{name:'Motivo',exact:true}).fill('x'.repeat(2001));
  await page.getByRole('button',{name:'Registrar movimiento'}).click();
  await page.getByText('El motivo no puede superar los 2000 caracteres.').waitFor();
  check(results.size===1,'Oversized reason reached the server');
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:'.impeccable/review/cash-reason-error-mobile.png',fullPage:true});
  await page.setViewportSize({width:1440,height:1000});
  await page.getByRole('textbox',{name:'Motivo',exact:true}).fill('Cambio de turno');
  await page.getByRole('button',{name:'Registrar movimiento'}).focus();await page.keyboard.press('Enter');
  await page.getByText('Esperado: 7.00 ARS').waitFor();
  await page.addScriptTag({path:'C:/Users/tobib/OneDrive/Escritorio/Uco Digital/UcoGestion/apps/web/node_modules/axe-core/axe.min.js'});
  await page.evaluate(()=>document.fonts.ready);
  check(await page.evaluate(()=>document.fonts.check('16px "Plus Jakarta Sans"') && window.getComputedStyle(document.body).fontFamily.includes('Plus Jakarta Sans')),'Workspace font did not load');
  check((await page.evaluate(async()=>window.axe.run())).violations.length===0,'Desktop accessibility failed');
  await page.screenshot({path:'.impeccable/review/cash-desktop.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});
  check(await page.evaluate(()=>document.documentElement.scrollWidth<=390),'Mobile overflow');
  check((await page.evaluate(async()=>window.axe.run())).violations.length===0,'Mobile accessibility failed');
  await page.screenshot({path:'.impeccable/review/cash-mobile.png',fullPage:true});
  await page.context().setOffline(true);
  await page.getByRole('heading',{name:'Esta pantalla necesita conexión'}).waitFor();
  check(await page.getByRole('button',{name:'Registrar movimiento'}).count()===0,'Offline cash mutation remained available');
  await page.context().setOffline(false);await page.reload();await page.getByText('Esperado: 7.00 ARS').waitFor();
  return {passed:true,scenarios:['lost-response-idempotency','reload','bound-device','keyboard','focus','desktop-mobile-axe','offline-return']};
}
