/* global document, window, getComputedStyle, sessionStorage, URL, AXE_SOURCE */
// eslint-disable-next-line @typescript-eslint/no-unused-expressions
async page => {
  await page.unroute('**/api/v1/**');
  const organizationId = '11111111-1111-4111-8111-111111111111';
  const branchId = '22222222-2222-4222-8222-222222222222';
  await page.addInitScript(id => sessionStorage.setItem('uco-active-organization', id), organizationId);
  await page.route('**/api/v1/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/v1/organizations') return route.fulfill({ json: { organizations: [{ organizationId, organizationName: 'Almacén del Valle', role: 'OWNER' }] } });
    if (path === '/api/v1/branches') return route.fulfill({ json: { actorRole: 'OWNER', branches: [{ id: branchId, name: 'Centro', status: 'ACTIVE', version: 1 }] } });
    if (path === '/api/v1/catalog/categories') return route.fulfill({ json: { categories: [{ id: '3', name: 'Almacén', status: 'ACTIVE', version: 1 }] } });
    if (path === '/api/v1/catalog/items/manage') return route.fulfill({ json: { items: [
      { id: '1', name: 'Café molido', type: 'PRODUCT', status: 'ACTIVE', baseUnit: 'UNIT', price: '1250.00', priceVersion: 1, sku: 'CAFE-01', barcode: '7791234567890', version: 1, trackInventory: true },
      { id: '2', name: 'Yerba', type: 'PRODUCT', status: 'INACTIVE', baseUnit: 'UNIT', price: '3500.00', priceVersion: 1, sku: null, barcode: null, version: 1, trackInventory: false },
    ] } });
    if (path === '/api/v1/catalog/items') return route.fulfill({ json: {
      items: [
        { id: '1', name: 'Café molido', type: 'PRODUCT', status: 'ACTIVE', baseUnit: 'UNIT', price: '1250.00', priceVersion: 1, sku: 'CAFE-01', barcode: '7791234567890' },
        { id: '2', name: 'Yerba', type: 'PRODUCT', status: 'ACTIVE', baseUnit: 'UNIT', price: '3500.00', priceVersion: 1, sku: null, barcode: null },
      ], categories: [{ id: '3', name: 'Almacén' }],
    } });
    throw new Error(`Unhandled catalog fixture: ${path}`);
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('http://localhost:3000/workspace/catalog');
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const search = page.getByRole('searchbox', { name: 'Buscar producto' });
  await search.waitFor();
  for (const query of ['  cafe  ', 'cafe-01', '7791234567890']) {
    await search.fill(query);
    check(await page.getByText('Café molido', { exact: true }).count() === 1, `Missing match: ${query}`);
    check(await page.getByText('Yerba', { exact: true }).count() === 0, `Unfiltered item: ${query}`);
  }
  await search.fill('inexistente');
  await page.getByText('No encontramos ítems con esa búsqueda. Probá con otro nombre, SKU o código de barras.').waitFor();
  await page.getByRole('button', { name: 'Limpiar búsqueda' }).click();
  check(await search.evaluate(element => element === document.activeElement), 'Search focus was lost');
  check(await page.getByText('Yerba', { exact: true }).count() === 1, 'Clear did not restore items');
  const itemsLink = page.getByRole('link', { name: 'Administrar ítems', exact: true });
  const categoriesLink = page.getByRole('link', { name: 'Administrar categorías de catálogo', exact: true });
  check(await itemsLink.getAttribute('href') === '/workspace/catalog/items', 'Wrong items destination');
  check(await categoriesLink.getAttribute('href') === '/workspace/catalog/categories', 'Wrong categories destination');
  await itemsLink.focus();
  await page.keyboard.press('Tab');
  check(await categoriesLink.evaluate(element => element === document.activeElement), 'Management keyboard order');
  check(await categoriesLink.evaluate(element => getComputedStyle(element).outlineStyle !== 'none'), 'Missing focus indicator');
  await page.keyboard.press('Tab');
  check(await search.evaluate(element => element === document.activeElement), 'Search keyboard order');
  const layouts = [];
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `Overflow at ${width}`);
    for (const control of [itemsLink, categoriesLink, search]) {
      const bounds = await control.boundingBox();
      check(bounds && bounds.height >= 44 && bounds.x >= 0 && bounds.x + bounds.width <= width, `Control bounds at ${width}`);
    }
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(source => {
      document.querySelectorAll('nextjs-portal').forEach(portal => portal.remove());
      const script = document.createElement('script');
      script.nonce = document.querySelector('script[nonce]')?.nonce ?? '';
      script.textContent = source;
      document.head.append(script);
    }, AXE_SOURCE);
    const violations = await page.evaluate(async () => (await window.axe.run(document)).violations.map(violation => ({ id: violation.id, nodes: violation.nodes.map(node => node.target) })));
    check(violations.length === 0, JSON.stringify({ width, violations }));
    await page.screenshot({ path: `output/playwright/catalog-${width}.png`, fullPage: true });
    layouts.push(width);
  }
  await itemsLink.click();
  await page.getByRole('heading', { name: 'Administrar ítems', exact: true }).waitFor();
  const managedList = page.getByRole('region', { name: 'Ítems de la organización' });
  for (const query of ['  cafe  ', 'cafe-01', '7791234567890']) {
    await search.fill(query);
    check(await managedList.getByRole('button', { name: 'Editar Café molido', exact: true }).count() === 1, `Missing managed match: ${query}`);
    check(await managedList.getByRole('button', { name: 'Editar Yerba', exact: true }).count() === 0, `Unfiltered managed item: ${query}`);
  }
  await managedList.getByRole('button', { name: 'Editar Café molido', exact: true }).click();
  await managedList.getByRole('textbox', { name: 'Nombre de Café molido' }).waitFor();
  await managedList.getByRole('button', { name: 'Editar Café molido', exact: true }).click();
  await search.fill('inexistente');
  await managedList.getByText('No encontramos ítems con esa búsqueda. Probá con otro nombre, SKU o código de barras.').waitFor();
  await page.getByRole('button', { name: 'Limpiar búsqueda' }).click();
  check(await search.evaluate(element => element === document.activeElement), 'Managed search focus was lost');
  await managedList.getByRole('button', { name: 'Activar Yerba', exact: true }).waitFor();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `Managed overflow at ${width}`);
    await page.evaluate(source => {
      document.querySelectorAll('nextjs-portal').forEach(portal => portal.remove());
      const script = document.createElement('script');
      script.nonce = document.querySelector('script[nonce]')?.nonce ?? '';
      script.textContent = source;
      document.head.append(script);
    }, AXE_SOURCE);
    const violations = await page.evaluate(async () => (await window.axe.run(document)).violations.map(violation => ({ id: violation.id, nodes: violation.nodes.map(node => node.target) })));
    check(violations.length === 0, JSON.stringify({ managed: true, width, violations }));
    await page.screenshot({ path: `output/playwright/managed-catalog-${width}.png`, fullPage: true });
  }
  return { search: 'passed', managedSearch: 'passed', keyboard: 'passed', accessibility: 'passed', layouts };
}
