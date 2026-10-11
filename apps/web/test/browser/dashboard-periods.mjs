/* global window, document, sessionStorage, getComputedStyle, URL, AXE_SOURCE */
// eslint-disable-next-line @typescript-eslint/no-unused-expressions
async page => {
  await page.unroute('**/api/v1/**');
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const org = '11111111-1111-4111-8111-111111111111';
  const branch = '22222222-2222-4222-8222-222222222222';
  const requests = [];
  let role = 'OWNER', empty = false, failure = false;
  const timezone = 'America/Argentina/Buenos_Aires';
  const summary = { role: 'OWNER', branchIds: [branch], sales: { net: '1250400.00', count: 148, averageTicket: '8448.65' },
    expenses: { net: '184500.00' }, purchases: { net: '560200.00' }, operatingResult: { amount: '1065900.00', label: 'Resultado operativo' },
    paymentMethods: [{ method: 'CASH', total: '650400.00' }, { method: 'DEBIT_CARD', total: '420000.00' }, { method: 'TRANSFER', total: '180000.00' }],
    topItems: [{ itemId: 'i1', name: 'Aceite de oliva 500 ml', quantity: '42.000', total: '189000.00' }, { itemId: 'i2', name: 'Malbec reserva 750 ml', quantity: '28.000', total: '274400.00' }, { itemId: 'i3', name: 'Harina integral 1 kg', quantity: '24.000', total: '52800.00' }],
    lowStock: [{ branchId: branch, itemId: 'i1', name: 'Aceite de oliva 500 ml', quantity: '3.000', minimum: '8.000' }], cashSessions: [],
    cashSummary: [{ branchId: branch, status: 'OPEN', count: 1, expectedCash: '650400.00' }] };
  await page.clock.setFixedTime(new Date('2026-10-11T12:00:00Z'));
  await page.addInitScript(id => sessionStorage.setItem('uco-active-organization', id), org);
  await page.route('**/api/v1/**', route => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace('/api/v1', '');
    const json = value => route.fulfill({ json: value });
    if (path === '/organizations') return json({ organizations: [{ organizationId: org, organizationName: 'Almacén del Valle', role }] });
    if (path === '/branches') return json({ actorRole: role, branches: [{ id: branch, name: 'Tunuyán · Centro', status: 'ACTIVE', version: 1 }] });
    if (path === '/organizations/settings') return json({ role, profile: { displayName: 'Almacén del Valle', address: '', email: '', phone: '' }, timezone, currency: 'ARS', version: 1 });
    if (path === '/dashboard') {
      requests.push(Object.fromEntries(url.searchParams));
      if (failure) return route.fulfill({ status: 409, contentType: 'application/problem+json', json: { status: 409, code: 'LOAD_FAILED', detail: 'No pudimos actualizar el resumen.', traceId: 'dashboard-test' } });
      if (role === 'EMPLOYEE') return json({ role, branchIds: [branch], catalog: [], inventory: [] });
      if (role === 'CASHIER') return json({ role, branchIds: [branch], sales: summary.sales, cashSessions: [] });
      if (empty) return json({ ...summary, sales: { net: '0.00', count: 0, averageTicket: '0.00' }, expenses: { net: '0.00' }, purchases: { net: '0.00' }, operatingResult: { amount: '0.00', label: 'Resultado operativo' }, paymentMethods: [], topItems: [], lowStock: [], cashSummary: [] });
      return json(summary);
    }
    throw new Error(`Unhandled dashboard fixture: ${path}`);
  });
  const source = AXE_SOURCE;
  const scans = [];
  const scan = async state => {
    await page.evaluate(() => document.fonts.ready);
    // Next's development toolbar is outside the product under review.
    await page.evaluate(() => document.querySelectorAll('nextjs-portal').forEach(portal => portal.remove()));
    await page.evaluate(source => {
      const script = document.createElement('script'); script.nonce = document.querySelector('script[nonce]')?.nonce ?? '';
      script.textContent = source; document.head.append(script);
    }, source);
    const violations = await page.evaluate(async () => (await window.axe.run(document)).violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) })));
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    check(!violations.length && !overflow, JSON.stringify({ state, violations, overflow }));
    scans.push({ state, width: page.viewportSize().width, violations, overflow, passed: true });
  };
  await page.goto('http://localhost:3000/workspace');
  await page.getByText('1.250.400,00', { exact: true }).first().waitFor();
  check(requests.at(-1).from === '2026-10-11T03:00:00.000Z' && requests.at(-1).to === '2026-10-12T03:00:00.000Z', 'Today must use organization midnight');
  for (const width of [1440, 1024, 768, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await scan('populated');
    if ([1440, 390].includes(width)) await page.screenshot({ path: `output/playwright/dashboard-${width}.png`, fullPage: true });
  }
  const choose = async (name, from, to) => {
    await page.getByRole('button', { name, exact: true }).click();
    await page.waitForFunction(() => ![...document.querySelectorAll('[role="status"]')].some(node => /Cargando|Actualizando/.test(node.textContent)));
    check(requests.at(-1).from === from && requests.at(-1).to === to, `${name} sent the wrong period`);
  };
  await choose('Esta semana', '2026-10-05T03:00:00.000Z', '2026-10-12T03:00:00.000Z');
  await choose('Este mes', '2026-10-01T03:00:00.000Z', '2026-11-01T03:00:00.000Z');
  await page.getByRole('button', { name: 'Personalizado', exact: true }).click();
  await page.getByLabel('Desde', { exact: true }).fill('2026-02-15');
  await page.getByLabel('Hasta', { exact: true }).fill('2026-02-15');
  const calls = requests.length;
  await page.keyboard.press('Tab');
  await page.getByRole('button', { name: 'Aplicar período', exact: true }).focus();
  check(await page.getByRole('button', { name: 'Aplicar período', exact: true }).evaluate(element => getComputedStyle(element).outlineStyle !== 'none'), 'Keyboard focus is missing');
  await page.keyboard.press('Enter');
  await page.getByText(/15.*feb.*2026/, { exact: false }).first().waitFor();
  check(requests.length > calls && requests.at(-1).to === '2026-02-16T03:00:00.000Z', 'Custom period must include its final date');
  await page.getByLabel('Hasta', { exact: true }).fill('2026-02-14');
  await page.getByRole('button', { name: 'Aplicar período', exact: true }).click();
  await page.locator('main').getByRole('alert').waitFor();
  check(await page.locator('main').getByRole('alert').count() === 1, 'Reversed period must show a validation error');
  await scan('invalid-custom');
  await page.getByRole('button', { name: 'Todo el historial', exact: true }).click();
  await page.waitForFunction(() => ![...document.querySelectorAll('[role="status"]')].some(node => /Actualizando/.test(node.textContent)));
  check(!requests.at(-1).from && !requests.at(-1).to, 'All history must clear dates');
  await page.getByLabel('Sucursal del dashboard').selectOption(branch);
  await page.waitForFunction(() => ![...document.querySelectorAll('[role="status"]')].some(node => /Cargando|Actualizando/.test(node.textContent)));
  check(requests.at(-1).branchId === branch, 'Branch filter must reach the API');
  empty = true;
  await page.getByRole('button', { name: 'Actualizar', exact: true }).click();
  await page.getByText('Todavía no hay datos para este período. Probá otra fecha o sucursal.').first().waitFor();
  await scan('empty');
  failure = true;
  await page.getByRole('button', { name: 'Actualizar', exact: true }).click();
  await page.getByRole('button', { name: 'Reintentar', exact: true }).waitFor();
  check(await page.getByRole('region', { name: 'Actividad del período' }).count() === 0, 'Failed refresh must not present old statistics as current');
  await scan('error');
  failure = false; empty = false;
  for (const nextRole of ['CASHIER', 'EMPLOYEE']) {
    role = nextRole; await page.goto('http://localhost:3000/workspace');
    await page.getByRole('heading', { name: nextRole === 'CASHIER' ? 'Mis sesiones de caja' : 'Catálogo e inventario', exact: true }).waitFor();
    check(await page.getByRole('region', { name: 'Medios de pago', exact: true }).count() === 0, 'Restricted role must not show global charts');
    if (nextRole === 'EMPLOYEE') check(await page.getByRole('button', { name: 'Este mes', exact: true }).count() === 0, 'Employee must not expose sales filters');
    await scan(nextRole);
  }
  await page.unroute('**/api/v1/**');
  return { passed: true, browser: page.context().browser().version(), scans, requests, note: 'API fixtures prove presentation and request filters; backend authorization remains covered by existing PostgreSQL suites.' };
}
