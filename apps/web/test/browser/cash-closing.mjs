/* global window, document, URL, atob, crypto, TextEncoder */
// eslint-disable-next-line @typescript-eslint/no-unused-expressions
async page=>{
  const check=(value,message)=>{if(!value)throw new Error(message);};
  const id='00000000-0000-4000-8000-000000000005',attempt='00000000-0000-4000-8000-000000000007';
  let data,session,loseBegin=true,loseAbort=true,firstAbortKey,firstBeginKey;
  const results=new Map();
  await page.context().setOffline(false);await page.unroute('**/api/v1/**');
  await page.route('**/api/v1/**',async route=>{
    const req=route.request(),url=new URL(req.url()),path=url.pathname;
    if(path.endsWith('/auth/csrf'))return route.fulfill({json:{csrfToken:'test-csrf'}});
    if(!data){data=await page.evaluate(()=>window.cashHarness.data);session={id,cashRegisterId:data.registers[0].id,
      registerName:'Mostrador',deviceId:data.devices[0].id,status:'OPEN',openingCash:'7.00',expectedCash:'7.00',currencyCode:'ARS',
      openedAt:'2026-10-07T00:00:00Z',closeAttemptId:null,finalSync:null};}
    if(path.endsWith('/checkpoint'))return route.fulfill({json:{sequence:'0',headHash:'0'.repeat(64),sessionSequence:'0'}});
    if(req.method()==='GET')return route.fulfill({json:{...data,registers:[],sessions:
      (url.searchParams.get('view')==='FINAL')=== (session.status==='CLOSED') ? [session]:[],nextCursor:null}});
    const body=req.postDataJSON(),key=req.headers()['idempotency-key'];
    if(results.has(key))return route.fulfill({status:201,json:results.get(key)});
    let result;
    if(path.endsWith('/begin-close')){
      check(await page.evaluate(async({body,pem})=>{
        const key=await crypto.subtle.importKey('spki',Uint8Array.from(atob(pem.replace(/-----[^-]+-----|\s/g,'')),c=>c.charCodeAt(0)),
          {name:'ECDSA',namedCurve:'P-256'},false,['verify']);
        return crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},key,Uint8Array.from(atob(body.signature),c=>c.charCodeAt(0)),
          new TextEncoder().encode(JSON.stringify(body.checkpoint)));
      },{body,pem:data.devices[0].publicKey}),'Checkpoint signature invalid');
      check(body.checkpoint.creationFrozen && body.checkpoint.pending===0,'Unsigned freeze');
      if(!firstBeginKey)firstBeginKey=key;else check(key!==firstBeginKey,'New attempt reused an aborted key');
      session={...session,status:'CLOSING',closeAttemptId:attempt};result={cashSessionId:id,closeAttemptId:attempt,status:'CLOSING'};
      results.set(key,result);if(loseBegin){loseBegin=false;return route.abort('failed');}
    }else if(path.endsWith('/abort-close')){
      firstAbortKey=key;session={...session,status:'OPEN',closeAttemptId:null,finalSync:null,lastAbortedAttemptId:attempt};result={cashSessionId:id,closeAttemptId:attempt,status:'OPEN'};
      results.set(key,result);if(loseAbort){loseAbort=false;return route.abort('failed');}
    }else if(path.endsWith('/final-sync')){
      session.finalSync={ready:true,expectedCash:'7.00'};result={cashSessionId:id,closeAttemptId:attempt,...session.finalSync};
    }else if(path.endsWith('/close')){
      check(body.expectedCash==='7.00' && body.countedCash==='8.00' && body.reason,'Unexplained count');
      session={...session,status:'CLOSED',closeAttemptId:null,finalSync:null,closure:{expectedCash:'7.00',countedCash:'8.00',difference:'1.00',reason:body.reason},
        differenceReview:{id:data.actorUserId,status:'PENDING_REVIEW',selfReview:false,canReview:true}};
      result={cashSessionId:id,closeAttemptId:attempt,closureId:data.actorUserId,status:'CLOSED',...session.closure};
    }else if(path.endsWith('/review-difference')){
      session.differenceReview.status='REVIEWED';result={id:body.reviewId,status:'REVIEWED',mode:'REVIEW',reviewerUserId:data.actorUserId,reviewedAt:'2026-10-07T00:00:00Z'};
    }else throw new Error('Unexpected mutation');
    results.set(key,result);return route.fulfill({status:201,json:result});
  });
  await page.goto('http://127.0.0.1:4179/apps/web/test/browser/cash-operations.html');
  await page.getByRole('button',{name:'Congelar y comenzar cierre'}).click();await page.getByRole('alert').waitFor();
  await page.reload();await page.getByRole('button',{name:'Abortar cierre'}).waitFor();
  check(await page.getByRole('textbox',{name:'Efectivo contado'}).count()===0,'Count before final sync');
  await page.getByRole('button',{name:'Abortar cierre'}).click();await page.getByRole('alert').waitFor();
  check(await page.getByRole('button',{name:'Congelar y comenzar cierre'}).count()===0,'Lost abort response thawed');
  await page.getByRole('button',{name:'Abortar cierre'}).click();await page.getByRole('button',{name:'Congelar y comenzar cierre'}).waitFor();
  check(results.has(firstAbortKey),'Abort retry missing');
  await page.getByRole('button',{name:'Congelar y comenzar cierre'}).click();
  loseAbort=true;
  await page.getByRole('button',{name:'Abortar cierre'}).click();await page.getByRole('alert').waitFor();
  await page.reload();await page.getByRole('button',{name:'Congelar y comenzar cierre'}).click();
  await page.getByRole('button',{name:'Verificar sincronización final'}).click();
  await page.getByRole('textbox',{name:'Efectivo contado'}).fill('8.00');
  await page.getByRole('button',{name:'Confirmar cierre'}).click();await page.getByText('Explicá la diferencia antes de cerrar.').waitFor();
  await page.getByRole('textbox',{name:'Motivo del cierre'}).fill('Sobrante contado');
  await page.addScriptTag({path:'apps/web/node_modules/axe-core/axe.min.js'});
  for(const width of [1440,390]){
    await page.setViewportSize({width,height:1000});await page.evaluate(()=>document.fonts.ready);
    check((await page.evaluate(async()=>window.axe.run())).violations.length===0,'Closing accessibility');
    check(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),'Closing overflow');
    await page.screenshot({path:`.impeccable/review/cash-closing-${width}.png`,fullPage:true});
  }
  await page.getByRole('button',{name:'Confirmar cierre'}).focus();await page.keyboard.press('Enter');
  await page.getByText('Diferencia: 1.00 ARS').waitFor();
  await page.getByRole('textbox',{name:'Nota de revisión'}).fill('Revisado por segundo responsable');
  await page.getByRole('button',{name:'Confirmar revisión de diferencia'}).click();
  await page.getByText('Diferencia revisada. El cierre y sus importes se conservan.').waitFor();
  check(session.closure.difference==='1.00','Review changed money');
  await page.screenshot({path:'.impeccable/review/cash-reviewed-mobile.png',fullPage:true});
  await page.context().setOffline(true);await page.getByRole('heading',{name:'Esta pantalla necesita conexión'}).waitFor();
  await page.context().setOffline(false);await page.reload();
  await page.getByRole('combobox',{name:'Mostrar sesiones'}).selectOption('FINAL');
  await page.getByText('Diferencia: 1.00 ARS').waitFor();
  return {passed:true,scenarios:['real-checkpoint-signature','lost-begin-reload','lost-abort-retry','lost-abort-reload','fresh-attempt-key','final-sync-count','reason','review','keyboard','axe-desktop-mobile','network-return']};
}
