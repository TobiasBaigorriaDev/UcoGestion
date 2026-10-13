/* global document, window, getComputedStyle, sessionStorage, URL, AXE_SOURCE */
// eslint-disable-next-line @typescript-eslint/no-unused-expressions
async page => {
  await page.unroute('**/api/v1/**');
  const organizationId = '11111111-1111-4111-8111-111111111111';
  const branchId = '22222222-2222-4222-8222-222222222222';
  let stockQuantity = '4.000';
  let minimum = '5.000';
  await page.addInitScript(id => sessionStorage.setItem('uco-active-organization', id), organizationId);
  await page.route('**/api/v1/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/v1/auth/csrf') return route.fulfill({ json: { csrfToken: 'browser-test-csrf' } });
    if (path === '/api/v1/inventory/adjustments') {
      const body = route.request().postDataJSON();
      if (body.branchId !== branchId || body.itemId !== '1' || body.direction !== 'INCREASE' || body.quantity !== '2' || body.reason !== 'CONTEO_FISICO') throw new Error('Wrong product adjustment payload');
      stockQuantity = '6.000';
      return route.fulfill({ json: { id: 'adjustment-fixture' } });
    }
    if (path === `/api/v1/inventory/stocks/${branchId}/1/threshold`) {
      minimum = route.request().postDataJSON().minimum;
      return route.fulfill({ json: { branchId, itemId: '1', quantity: stockQuantity, threshold: minimum, lowStock: false } });
    }
    if (path === '/api/v1/organizations') return route.fulfill({ json: { organizations: [{ organizationId, organizationName: 'Almacén del Valle', role: 'OWNER' }] } });
    if (path === '/api/v1/branches') return route.fulfill({ json: { actorRole: 'OWNER', branches: [{ id: branchId, name: 'Centro', status: 'ACTIVE', version: 1 }] } });
    if (path === '/api/v1/catalog/categories') return route.fulfill({ json: { categories: [{ id: '3', name: 'Almacén', status: 'ACTIVE', version: 1 }] } });
    if (path === '/api/v1/catalog/items/manage') return route.fulfill({ json: { items: [
      { id: '1', name: 'Café molido', type: 'PRODUCT', status: 'ACTIVE', baseUnit: 'UNIT', price: '1250.00', priceVersion: 1, sku: 'CAFE-01', barcode: '7791234567890', version: 1, trackInventory: true, categoryId: '3' },
      { id: '2', name: 'Yerba', type: 'PRODUCT', status: 'INACTIVE', baseUnit: 'UNIT', price: '3500.00', priceVersion: 1, sku: null, barcode: null, version: 1, trackInventory: false },
    ] } });
    if (path === '/api/v1/catalog/items') return route.fulfill({ json: {
      items: [
        { id: '1', name: 'Café molido', type: 'PRODUCT', status: 'ACTIVE', trackInventory: true, baseUnit: 'UNIT', price: '1250.00', priceVersion: 1, sku: 'CAFE-01', barcode: '7791234567890', categoryId: '3' },
        { id: '2', name: 'Yerba', type: 'PRODUCT', status: 'ACTIVE', trackInventory: false, baseUnit: 'UNIT', price: '3500.00', priceVersion: 1, sku: null, barcode: null },
      ], categories: [{ id: '3', name: 'Almacén' }],
    } });
    if (path === '/api/v1/inventory/stocks') return route.fulfill({ json: { stocks: [
      { branchId, itemId: '1', itemName: 'Café molido', baseUnit: 'UNIT', quantity: stockQuantity, threshold: minimum, lowStock: true },
    ], nextCursor: null } });
    throw new Error(`Unhandled catalog fixture: ${path}`);
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('http://localhost:3000/workspace/catalog');
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const search = page.getByRole('searchbox', { name: 'Buscar producto' });
  await search.waitFor();
  const sort = page.getByRole('combobox', { name: 'Ordenar productos' });
  for (const [value, expected] of [
    ['name-desc', ['Yerba', 'Café molido']],
    ['price-asc', ['Café molido', 'Yerba']],
    ['price-desc', ['Yerba', 'Café molido']],
    ['stock-desc', ['Café molido', 'Yerba']],
    ['stock-low', ['Café molido', 'Yerba']],
  ]) {
    await sort.selectOption(value);
    check(JSON.stringify(await page.locator('summary > strong').allTextContents()) === JSON.stringify(expected), `Wrong product order: ${value}`);
  }
  await sort.selectOption('name-asc');
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
  const grouping = page.getByRole('checkbox', { name: 'Agrupar por categorías' });
  await grouping.check();
  check(await page.locator('summary > strong').count() === 0, 'Category folders must start closed');
  const folder = page.getByRole('button', { name: 'Abrir categoría Almacén', exact: true });
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    const bounds = await folder.boundingBox();
    check(bounds && bounds.height >= 44 && bounds.x + bounds.width <= width, `Folder bounds at ${width}`);
    check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `Closed folder overflow at ${width}`);
    await page.screenshot({ path: `output/playwright/category-folders-closed-${width}.png`, fullPage: true });
  }
  await folder.focus();
  await page.keyboard.press('Enter');
  check(await page.getByRole('button', { name: 'Cerrar categoría Almacén' }).getAttribute('aria-expanded') === 'true', 'Keyboard did not open folder');
  await page.getByRole('button', { name: 'Abrir categoría Sin categoría' }).click();
  await page.getByRole('region', { name: 'Almacén', exact: true }).getByText('Café molido', { exact: true }).waitFor();
  await page.getByRole('region', { name: 'Sin categoría', exact: true }).getByText('Yerba', { exact: true }).waitFor();
  const createAction = page.getByRole('button', { name: 'Nuevo producto o servicio' });
  const categoriesLink = page.getByRole('link', { name: 'Categorías', exact: true });
  check(await categoriesLink.getAttribute('href') === '/workspace/catalog/categories', 'Wrong categories destination');
  await page.keyboard.press('Tab');
  await categoriesLink.focus();
  check(await categoriesLink.evaluate(element => getComputedStyle(element).outlineStyle !== 'none'), 'Missing focus indicator');
  check(await page.getByRole('link', { name: 'Ítems', exact: true }).count() === 0, 'Duplicate items navigation');
  const layouts = [];
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `Overflow at ${width}`);
    for (const control of [createAction, categoriesLink, search, sort]) {
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
  await page.getByRole('heading', { name: 'Productos', exact: true }).waitFor();
  const managedList = page.getByRole('region', { name: 'Ítems de la organización' });
  await createAction.click();
  const creation = page.locator('#new-catalog-item');
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    const buttonBounds = await page.getByRole('button', { name: 'Cerrar alta' }).boundingBox();
    const formBounds = await creation.boundingBox();
    const listBounds = await managedList.boundingBox();
    check(buttonBounds && formBounds && listBounds && formBounds.y >= buttonBounds.y + buttonBounds.height && formBounds.y + formBounds.height <= listBounds.y, 'Creation form must be between its button and the list');
    check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `Creation overflow at ${width}`);
    await page.screenshot({ path: `output/playwright/product-creation-top-${width}.png`, fullPage: true });
  }
  await page.getByRole('button', { name: 'Cerrar alta' }).click();
  check(await managedList.getByRole('button', { name: 'Editar Café molido', exact: true }).count() === 0, 'Product actions start expanded');
  check(await page.getByRole('link', { name: 'Stock', exact: true }).count() === 0, 'Stock navigation still exists');
  const product = managedList.locator('summary').filter({ has: page.getByText('Café molido', { exact: true }) });
  await product.focus();
  await page.keyboard.press('Enter');
  await managedList.getByRole('button', { name: 'Editar Café molido', exact: true }).waitFor();
  await managedList.getByText('Cambiar stock de Café molido', { exact: true }).click();
  await managedList.getByRole('button', { name: 'Confirmar ajuste', exact: true }).waitFor();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    const fields = await Promise.all(['Tipo de ajuste', 'Cantidad', 'Motivo', 'Observación (opcional)'].map(name => managedList.getByLabel(name, { exact: true }).boundingBox()));
    check(fields.every((box, index) => box && (index === 0 || box.y > fields[index - 1].y + fields[index - 1].height)), `Adjustment is not vertical at ${width}`);
    await page.screenshot({ path: `output/playwright/product-adjustment-vertical-${width}.png`, fullPage: true });
  }
  await managedList.getByRole('textbox', { name: 'Mínimo de Café molido', exact: true }).waitFor();
  await managedList.getByRole('textbox', { name: 'Cantidad', exact: true }).fill('2');
  await managedList.getByRole('button', { name: 'Confirmar ajuste', exact: true }).click();
  await managedList.getByText('Ajuste confirmado. El historial y el stock se actualizarán.').waitFor();
  await managedList.getByText('6 unidades', { exact: true }).waitFor();
  await managedList.getByRole('textbox', { name: 'Mínimo de Café molido', exact: true }).fill('3');
  await managedList.getByRole('button', { name: 'Guardar mínimo de Café molido', exact: true }).click();
  await managedList.getByText('Mínimo de Café molido actualizado.', { exact: true }).waitFor();

  for (const query of ['  cafe  ', 'cafe-01', '7791234567890']) {
    await search.fill(query);
    check(await managedList.getByRole('button', { name: 'Editar Café molido', exact: true }).count() === 1, `Missing managed match: ${query}`);
    check(await managedList.getByRole('button', { name: 'Editar Yerba', exact: true }).count() === 0, `Unfiltered managed item: ${query}`);
  }
  for (const name of ['Cambiar precio de Café molido', 'Cambiar estructura de Café molido', 'Desactivar Café molido', 'Eliminar Café molido']) check(await managedList.getByRole('button', { name, exact: true }).count() === 0, `Action outside editor: ${name}`);
  await managedList.getByRole('button', { name: 'Editar Café molido', exact: true }).click();
  for (const name of ['Cambiar precio de Café molido', 'Cambiar estructura de Café molido', 'Desactivar Café molido', 'Eliminar Café molido']) await managedList.getByRole('button', { name, exact: true }).waitFor();
  await managedList.getByRole('textbox', { name: 'Nombre de Café molido' }).waitFor();
  await managedList.getByRole('button', { name: 'Editar Café molido', exact: true }).click();
  await search.fill('inexistente');
  await managedList.getByText('No encontramos ítems con esa búsqueda. Probá con otro nombre, SKU o código de barras.').waitFor();
  await page.getByRole('button', { name: 'Limpiar búsqueda' }).click();
  check(await search.evaluate(element => element === document.activeElement), 'Managed search focus was lost');
  await page.getByRole('button', { name: 'Abrir categoría Sin categoría' }).click();
  await managedList.getByText('Yerba', { exact: true }).click();
  await managedList.getByRole('button', { name: 'Editar Yerba', exact: true }).click();
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
