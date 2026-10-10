/* global window, document, getComputedStyle, sessionStorage, URL */
// eslint-disable-next-line @typescript-eslint/no-unused-expressions
async page => {
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') pageErrors.push(message.text()); });
  page.on('response', response => { if (response.status() === 404) pageErrors.push(`404 ${response.url()}`); });
  const selection = new URL(page.url()).searchParams.get('verifyRoutes')?.split(',');
  const verifyCards = new URL(page.url()).searchParams.has('verifyCards');
  const check = (value, message) => { if (!value) throw new Error(message); };
  const org = '11111111-1111-4111-8111-111111111111', branch = '22222222-2222-4222-8222-222222222222';
  const item = '33333333-3333-4333-8333-333333333333';
  const branches = [{ id: branch, name: 'Centro', status: 'ACTIVE', version: 1 },
    { id: '44444444-4444-4444-8444-444444444444', name: 'Norte', status: 'ACTIVE', version: 1 }];
  const catalog = { items: [{ id: item, name: 'Manzanas', type: 'PRODUCT', status: 'ACTIVE', baseUnit: 'UNIT',
    price: '125.00', priceVersion: 1, sku: 'MAN', barcode: null, trackInventory: true, version: 1 }], categories: [] };
  const stocks = [{ branchId: branch, itemId: item, itemName: 'Manzanas', baseUnit: 'UNIT', quantity: '2.000', threshold: '3.000', lowStock: true }];
  const dashboard = { role: 'OWNER', branchIds: [branch], sales: { net: '125.00', count: 2, averageTicket: '62.50' },
    expenses: { net: '20.00' }, purchases: { net: '30.00' }, operatingResult: { amount: '105.00', label: 'Resultado operativo' },
    paymentMethods: [{ method: 'CASH', total: '125.00' }], topItems: [{ itemId: item, name: 'Manzanas', quantity: '2.000', total: '125.00' }],
    lowStock: [{ branchId: branch, itemId: item, name: 'Manzanas', quantity: '2.000', minimum: '3.000' }],
    cashSessions: [], cashSummary: [{ branchId: branch, status: 'OPEN', count: 1, expectedCash: '125.00' }] };
  let failReads = false;
  await page.context().setOffline(false);
  await page.addInitScript(id => sessionStorage.setItem('uco-active-organization', id), org);
  await page.route('**/api/v1/**', route => {
    const path = new URL(route.request().url()).pathname.replace('/api/v1', '');
    const json = value => route.fulfill({ json: value });
    const problem = () => route.fulfill({ status: 409, contentType: 'application/problem+json', json: {
      type: 'about:blank', title: 'Conflicto', status: 409, code: 'VERSION_CONFLICT', detail: 'Otra persona modificó los datos. Volvé a cargar.', traceId: 'ui-test' } });
    if (path === '/auth/csrf') return json({ csrfToken: 'csrf' });
    if (route.request().method() !== 'GET') return problem();
    if (path === '/organizations') return json({ organizations: [{ organizationId: org, organizationName: 'Uco', role: 'OWNER' }] });
    if (path === '/branches') return json({ actorRole: 'OWNER', branches });
    if (failReads) return problem();
    if (path === '/organizations/settings') return json({ role: 'OWNER', profile: { displayName: 'Uco', address: '', email: '', phone: '' }, timezone: 'America/Argentina/Buenos_Aires', currency: 'ARS', version: 1 });
    if (path === '/users/management') return json({ actorRole: 'OWNER', branches, memberships: [], invitations: [] });
    if (path === '/catalog/items' || path === '/catalog/items/manage') return json(catalog);
    if (path === '/catalog/items/similar') return json({ names: [] });
    if (path === '/catalog/categories' || path.startsWith('/expense-categories')) return json({ categories: [{ id: item, name: 'General', status: 'ACTIVE', version: 1 }] });
    if (path === '/customers' || path === '/suppliers') return json({ items: [], nextCursor: null });
    if (path.endsWith('/cash-registers')) return json({ cashRegisters: [{ id: item, branchId: branch, name: 'Mostrador', status: 'ACTIVE', version: 1 }] });
    if (path === '/organizations/payment-methods') return json({ paymentMethods: ['CASH', 'DEBIT_CARD', 'CREDIT_CARD', 'TRANSFER', 'QR'].map(method => ({ method, enabled: true })) });
    if (path === '/inventory/stocks') return json({ stocks, nextCursor: null });
    if (path === '/inventory/adjustments') return json({ adjustments: [], nextCursor: null });
    if (path === '/inventory/transfers') return json({ transfers: [], nextCursor: null });
    if (path === '/sales/checkout-context') return json({ sessions: [], paymentMethods: ['CASH', 'TRANSFER'] });
    if (path === '/dashboard') return json(dashboard);
    if (path === '/audit') return json({ items: [{ id: item, actorUserId: org, branchId: branch, entityType: 'sale', entityId: item, action: 'CONFIRMED', occurredAt: '2026-10-09T12:00:00Z' }], nextCursor: null });
    if (path.startsWith('/reports/')) return json({ dataset: 'sales', items: [{ id: item, branchId: branch, occurredAt: '2026-10-09T12:00:00Z', status: 'CONFIRMED', total: '125.00', currencyCode: 'ARS' }], nextCursor: null });
    if (path.includes('/deactivation-blockers')) return json({ sessions: '0', pending: '0', conflicts: '0', uncertainty: '0' });
    throw new Error(`Unhandled UI fixture ${path}`);
  });
  const source = await (await page.request.get('http://127.0.0.1:4179/apps/web/node_modules/axe-core/axe.min.js')).text();
  const scan = async (route, width, state) => {
    try {
    await page.evaluate(source => {
      const script = document.createElement('script'); script.nonce = document.querySelector('script[nonce]')?.nonce ?? '';
      script.textContent = source; document.head.append(script);
    }, source);
    await page.evaluate(() => document.fonts.ready);
    const violations = await page.evaluate(async () => (await window.axe.run(document)).violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) })));
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    const focus = [];
    await page.locator('body').click({ position: { x: 1, y: 1 } });
    for (let index = 0; index < 100; index++) {
      await page.keyboard.press('Tab');
      const current = await page.evaluate(() => {
        const element = document.activeElement, style = getComputedStyle(element);
        return { tag: element.tagName, name: element.getAttribute('aria-label') || element.textContent?.trim().slice(0, 50) || element.id,
          visible: element.getBoundingClientRect().height > 0, indicated: style.outlineStyle !== 'none' && style.outlineWidth !== '0px' || style.boxShadow !== 'none' };
      });
      if (current.tag === 'BODY') break;
      focus.push(current);
    }
    const result = { route, width, state, violations, overflow, focus };
    result.passed = !violations.length && !overflow && focus.length > 0 && focus.every(v => v.visible && v.indicated);
    return result;
    } catch (error) {
      throw new Error(`${route} ${width} ${state}: ${error.message}; ${JSON.stringify(pageErrors)}; ${page.url()}`, { cause: error });
    }
  };
  const results = [];
  const routes = ['/login', '/forgot-password', '/reset-password?token=test', '/accept-invitation?token=test', '/platform/organizations/new', '/organizations/select',
    '/workspace', '/workspace/settings', '/workspace/users', '/workspace/branches', '/workspace/catalog', '/workspace/catalog/categories',
    '/workspace/catalog/items', '/workspace/expense-categories', '/workspace/customers', '/workspace/suppliers', '/workspace/cash-registers',
    '/workspace/payment-methods', '/workspace/inventory', '/workspace/inventory/adjustments', '/workspace/inventory/transfers', '/workspace/pos',
    '/workspace/sales', '/workspace/purchases', '/workspace/expenses', '/workspace/audit', '/workspace/reports'];
  for (const route of routes.filter(route => !selection || selection.includes(route))) {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`http://localhost:3001${route}`);
    try {
      await page.getByRole('heading', { level: 1 }).first().waitFor({ timeout: 20000 });
    } catch (error) {
      throw new Error(`${route}: ${error.message}; visible page: ${(await page.locator('body').innerText()).slice(0, 1000)}`, { cause: error });
    }
    await page.waitForFunction(() => ![...document.querySelectorAll('[role="status"]')].some(e => e.textContent?.startsWith('Cargando')), undefined, { timeout: 20000 });
    for (const width of [1440, 1024, 768, 390]) {
      await page.setViewportSize({ width, height: 1000 }); results.push(await scan(route, width, 'loaded'));
      if (verifyCards) {
        if (route === '/workspace') {
          for (const label of ['Ventas netas', 'Cantidad de ventas', 'Ticket promedio', 'Gastos netos', 'Compras netas', 'Resultado operativo'])
            check(await page.locator('dt').filter({ hasText: label }).count() === 1, `Missing textual metric ${label}`);
          for (const [title, text] of [['Medios de pago', 'Efectivo125.00'], ['Más vendidos', 'Manzanas2.000 unidades · 125.00'],
            ['Stock bajo', 'Manzanas2.000 de mínimo 3.000'], ['Resumen de cajas', 'Centro · OPEN1 sesiones · 125.00']]) {
            const section = page.locator('section').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
            check((await section.innerText()).replace(/\s+/g, '') === `${title}${text}`.replace(/\s+/g, ''), `Text alternative differs: ${title}`);
          }
        }
        if (route === '/workspace/reports' || route === '/workspace/audit') {
          check(await page.getByRole('table').count() === 1, 'Missing semantic table');
          check(await page.getByRole('columnheader').count() === 5, 'Mobile headers disappeared from accessible tree');
          const cells = await page.locator('tbody td').evaluateAll(cells => cells.map(cell => ({
            label: cell.getAttribute('data-label'), before: getComputedStyle(cell, '::before').content,
            display: getComputedStyle(cell).display, text: cell.textContent })));
          check(cells.length === 5 && cells.every(cell => cell.label && cell.text), 'Cards lost labels or values');
          if (width === 390) {
            check(await page.locator('tbody tr').evaluate(row => getComputedStyle(row).display === 'grid'), 'Mobile row is not a card');
            check(cells.every(cell => cell.display === 'flex' && cell.before === `"${cell.label}"`), 'Mobile cell label differs from column header');
          }
        }
        if (route === '/workspace/inventory') {
          const card = page.getByRole('listitem').filter({ hasText: 'Manzanas' });
          check(await card.count() === 1 && /Disponible: 2.000/.test(await card.innerText()) && /Mínimo: 3.000/.test(await card.innerText()) && /Alerta: Stock bajo/.test(await card.innerText()), 'Stock card lost values or non-color warning');
        }
        await page.screenshot({ path: `output/playwright/t226-${route.split('/').at(-1)}-${width}.png`, fullPage: true });
      }
    }
    const submit = page.locator('form button[type="submit"]').first();
    if (await submit.count() && await submit.isEnabled()) {
      await submit.focus(); await page.keyboard.press('Enter');
      results.push(await scan(route, 390, 'submit-or-validation'));
    }
  }
  failReads = true;
  await page.goto('http://localhost:3001/workspace/reports');
  await page.getByRole('button', { name: 'Reintentar', exact: true }).waitFor({ timeout: 20000 });
  await page.getByRole('heading', { level: 1, name: 'Reportes' }).waitFor();
  results.push(await scan('/workspace/reports', 390, 'server-error'));
  await page.unroute('**/api/v1/**');
  const failures = results.filter(result => !result.passed);
  if (failures.length) throw new Error(JSON.stringify(failures));
  return { passed: failures.length === 0, browser: page.context().browser().version(), pages: results.length,
    failures, coverage: results.map(({ route, width, state, passed }) => ({ route, width, state, passed })) };
}
