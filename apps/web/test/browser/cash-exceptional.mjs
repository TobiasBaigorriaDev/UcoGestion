/* global window, document, URL */
// eslint-disable-next-line @typescript-eslint/no-unused-expressions
async page=>{
  const check=(value,message)=>{if(!value)throw new Error(message);};
  const id='00000000-0000-4000-8000-000000000005',op='00000000-0000-4000-8000-000000000008';
  let data,session,loseExceptional=true,exceptionalKey;
  const results=new Map();
  await page.context().setOffline(false);await page.unroute('**/api/v1/**');
  await page.route('**/api/v1/**',async route=>{
    const req=route.request(),url=new URL(req.url()),path=url.pathname;
    if(path.endsWith('/auth/csrf'))return route.fulfill({json:{csrfToken:'test-csrf'}});
    if(!data){data=await page.evaluate(()=>window.cashHarness.data);session={id,cashRegisterId:data.registers[0].id,
      registerName:'Mostrador',deviceId:data.devices[0].id,deviceStatus:'ACTIVE',status:'CONFLICTED',openingCash:'10.00',expectedCash:'10.00',
      currencyCode:'ARS',openedAt:'2026-10-07T00:00:00Z',completeness:'COMPLETE'};}
    if(path.endsWith('/checkpoint'))return route.fulfill({json:{sequence:'0',headHash:'0'.repeat(64),sessionSequence:'0'}});
    if(req.method()==='GET')return route.fulfill({json:{...data,registers:[],devices:session.deviceStatus==='ACTIVE'?data.devices:[],sessions:
      ((url.searchParams.get('view')==='FINAL') === session.status.startsWith('CLOSED')) ? [session]:[],nextCursor:null}});
    const body=req.postDataJSON(),key=req.headers()['idempotency-key'];
    if(results.has(key))return route.fulfill({status:201,json:results.get(key)});
    let result;
    if(path.endsWith('/reconcile')){
      check(body.checkpoint.sessionId===id && body.signature && body.reason && body.countedCash==='11.00','Missing reconciliation evidence');
      session={...session,status:'CLOSED_CONFLICT_RESOLVED',closure:{expectedCash:'10.00',countedCash:'11.00',difference:'1.00',reason:body.reason}};
      result={cashSessionId:id,closureId:data.actorUserId,status:session.status,...session.closure};
    }else if(path.endsWith('/exceptional-close')){
      check(body.confirm===true && body.reason && !('countedCash' in body),'Invented an unknown count');exceptionalKey=key;
      session={...session,status:'CLOSED_WITH_UNRECOVERED_DEVICE',completeness:'UNKNOWN',currencyPermanentlyLocked:true,
        exceptionalClosure:{expectedCashKnown:'10.00',countedCash:null,differenceObserved:null,lastContactAt:null,reason:body.reason,operationsReceived:[]}};
      result={cashSessionId:id,closureId:data.actorUserId,status:session.status};results.set(key,result);
      if(loseExceptional){loseExceptional=false;return route.abort('failed');}
    }else if(path.endsWith('/review-late-data')){
      check(body.throughOperationId===session.lateData.throughOperationId,'Review used stale cutoff');
      session.lateData.status='REVIEWED';result={cashSessionId:id,throughOperationId:body.throughOperationId,status:'REVIEWED',reviewedAt:'2026-10-07T00:00:00Z'};
    }else throw new Error('Unexpected mutation');
    results.set(key,result);return route.fulfill({status:201,json:result});
  });
  const url='http://127.0.0.1:4179/apps/web/test/browser/cash-operations.html';
  const audit=async name=>{
    await page.addScriptTag({path:'apps/web/node_modules/axe-core/axe.min.js'});
    for(const width of [1440,390]){
      await page.setViewportSize({width,height:1000});await page.evaluate(()=>document.fonts.ready);
      const violations=await page.evaluate(async()=>window.axe.run());
      check(violations.violations.length===0,`${name} accessibility ${JSON.stringify(violations.violations.map(row=>row.id))}`);
      check(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),`${name} overflow`);
      await page.screenshot({path:`.impeccable/review/cash-${name}-${width}.png`,fullPage:true});
    }
  };
  await page.goto(url);await page.getByRole('button',{name:'Preparar conciliación'}).click();
  await page.getByRole('textbox',{name:'Efectivo contado',exact:true}).fill('11.00');
  await page.getByRole('textbox',{name:'Motivo u observación'}).fill('Conciliación independiente');
  await page.getByRole('button',{name:'Confirmar conciliación'}).click();
  await page.getByText('Confirmá que conservarás separadas las sesiones y sus operaciones.').waitFor();
  check(results.size===0,'Reconciled without confirmation');
  await page.getByRole('checkbox',{name:/Conservar las sesiones separadas/}).check();await audit('reconciliation');
  await page.getByRole('button',{name:'Confirmar conciliación'}).focus();await page.keyboard.press('Enter');
  await page.getByText('Diferencia: 1.00 ARS').waitFor();
  session={...session,status:'OPEN',deviceStatus:'UNRECOVERABLE',closure:null};
  await page.reload();await page.getByRole('textbox',{name:'Motivo del cierre excepcional'}).fill('Equipo extraviado');
  await page.getByRole('button',{name:'Confirmar cierre excepcional'}).click();
  await page.getByText('Confirmá que entendés la incertidumbre permanente antes de cerrar.').waitFor();
  check(results.size===1,'Exceptional close lacked explicit confirmation');
  check(await page.getByRole('button',{name:'Congelar y comenzar cierre'}).count()===0,'Normal close allowed an unrecoverable device');
  await page.getByRole('checkbox',{name:/Entiendo que la información/}).check();await audit('exceptional');
  await page.getByRole('button',{name:'Confirmar cierre excepcional'}).click();await page.getByRole('alert').waitFor();
  await page.getByRole('button',{name:'Confirmar cierre excepcional'}).click();await page.getByText('Contado original: no registrado.').waitFor();
  check(results.has(exceptionalKey) && results.size===2,'Exceptional retry duplicated the closure');
  session={...session,expectedCash:'30.00',lateData:{marker:'LATE_RECOVERED_OPERATIONS',throughOperationId:op,sequence:'2',count:'1',status:'PENDING_REVIEW',receivedAt:'2026-10-07T01:00:00Z'}};
  await page.reload();await page.getByRole('combobox',{name:'Mostrar sesiones'}).selectOption('FINAL');
  await page.getByText('Esperado conocido actualizado: 30.00 ARS').waitFor();
  await page.getByRole('checkbox',{name:/Revisé las operaciones recuperadas/}).check();await audit('late');
  await page.getByRole('button',{name:'Confirmar revisión de datos tardíos'}).click();
  await page.getByText('Datos tardíos revisados. La completitud sigue siendo desconocida.').waitFor();
  check(session.completeness==='UNKNOWN' && session.exceptionalClosure.expectedCashKnown==='10.00','Review rewrote original state');
  session={...session,expectedCash:'50.00',lateData:{...session.lateData,throughOperationId:'00000000-0000-4000-8000-000000000009',sequence:'3',count:'2',status:'PENDING_REVIEW'}};
  await page.reload();await page.getByRole('combobox',{name:'Mostrar sesiones'}).selectOption('FINAL');
  await page.getByRole('button',{name:'Confirmar revisión de datos tardíos'}).waitFor();
  await page.getByText('Esperado conocido del snapshot original: 10.00 ARS').waitFor();
  await page.context().setOffline(true);await page.getByRole('heading',{name:'Esta pantalla necesita conexión'}).waitFor();
  await page.context().setOffline(false);await page.reload();await page.getByRole('combobox',{name:'Mostrar sesiones'}).selectOption('FINAL');
  await page.getByText('Esperado conocido actualizado: 50.00 ARS').waitFor();
  return {passed:true,scenarios:['conflict-confirmation','bound-device','unrecoverable-normal-denied','optional-count-not-zero','lost-exceptional-retry',
    'immutable-original-snapshot','late-cutoff-review','new-data-new-review','permanent-unknown','keyboard','axe-3states-desktop-mobile','network-return']};
}
