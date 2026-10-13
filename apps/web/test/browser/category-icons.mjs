/* global URL, sessionStorage, document, window, AXE_SOURCE */
// eslint-disable-next-line @typescript-eslint/no-unused-expressions
async page => {
  const organizationId = '11111111-1111-4111-8111-111111111111';
  const branchId = '22222222-2222-4222-8222-222222222222';
  let categories = [];
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  await page.addInitScript(id => sessionStorage.setItem('uco-active-organization', id), organizationId);
  await page.route('**/api/v1/**', route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/api/v1/auth/csrf') return route.fulfill({ json: { csrfToken: 'test-csrf' } });
    if (path === '/api/v1/organizations') return route.fulfill({ json: { organizations: [{ organizationId, organizationName: 'Almacén del Valle', role: 'OWNER' }] } });
    if (path === '/api/v1/branches') return route.fulfill({ json: { actorRole: 'OWNER', branches: [{ id: branchId, name: 'Centro', status: 'ACTIVE', version: 1 }] } });
    if (path === '/api/v1/catalog/categories') {
      if (request.method() === 'GET') return route.fulfill({ json: { categories } });
      const input = request.postDataJSON();
      check(input.icon === 'cup-soda', 'Wrong create icon payload');
      const category = { id: 'new-category', name: input.name, icon: input.icon, version: 1, status: 'ACTIVE' };
      categories = [category];
      return route.fulfill({ json: category });
    }
    if (path === '/api/v1/catalog/categories/new-category') {
      const input = request.postDataJSON();
      check(input.icon === 'apple', 'Wrong edit icon payload');
      categories = [{ ...categories[0], ...input, version: 2 }];
      return route.fulfill({ json: categories[0] });
    }
    if (path === '/api/v1/catalog/items/manage') return route.fulfill({ json: { items: [{ id: 'product', name: 'Café molido', categoryId: 'new-category', type: 'PRODUCT', status: 'ACTIVE', trackInventory: false, baseUnit: 'UNIT', price: '100.00', priceVersion: 1, sku: null, barcode: null, version: 1 }] } });
    if (path === '/api/v1/inventory/stocks') return route.fulfill({ json: { stocks: [], nextCursor: null } });
    throw new Error(`Unhandled category icon fixture: ${path}`);
  });
  await page.goto('http://localhost:3000/workspace/catalog/categories');
  await page.getByRole('button', { name: 'Elegir icono' }).click();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    check(await page.getByRole('radio').count() === 52, 'Missing library icons');
    check(await page.getByText('Carpeta general', { exact: true }).count() === 0, 'Visible icon labels');
    check(await page.locator('span').filter({ hasText: /^Icono:/ }).count() === 0, 'Visible preview name');
    check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'Icon library overflow');
    await page.evaluate(source => {
      document.querySelectorAll('nextjs-portal').forEach(portal => portal.remove());
      const script = document.createElement('script');
      script.nonce = document.querySelector('script[nonce]')?.nonce ?? '';
      script.textContent = source; document.head.append(script);
    }, AXE_SOURCE);
    const violations = await page.evaluate(async () => (await window.axe.run(document)).violations.map(v => v.id));
    check(violations.length === 0, JSON.stringify(violations));
    await page.screenshot({ path: `output/playwright/category-icon-library-${width}.png`, fullPage: true });
    check(await page.locator('img[data-category-icon]').evaluateAll(images => images.every(img => img.complete && img.naturalWidth > 0)), 'SVG asset failed to load');
  }
  const search = page.getByRole('searchbox', { name: 'Buscar icono' });
  await search.fill('inexistente');
  await page.getByText('No encontramos iconos. Probá con otra palabra.').waitFor();
  await search.fill('gaseosas');
  await page.getByRole('radio', { name: 'Gaseosas y refrescos' }).focus();
  await page.keyboard.press('Space');
  check(await page.getByRole('button', { name: 'Elegir icono' }).evaluate(el => el === document.activeElement), 'Icon selection lost keyboard focus');
  await page.getByRole('textbox', { name: 'Nombre de la categoría' }).fill('Cafetería');
  await page.getByRole('button', { name: 'Crear categoría' }).click();
  await page.getByText('Categoría creada.', { exact: true }).waitFor();
  await page.reload();
  await page.getByRole('button', { name: 'Editar Cafetería' }).click();
  await page.getByRole('button', { name: 'Cambiar icono de Cafetería' }).click();
  await page.getByRole('radio', { name: 'Frutas' }).click();
  await page.getByRole('button', { name: 'Guardar nombre de Cafetería' }).click();
  await page.getByText('Categoría actualizada.', { exact: true }).waitFor();
  await page.goto('http://localhost:3000/workspace/catalog');
  await page.getByRole('checkbox', { name: 'Agrupar por categorías' }).check();
  const folder = page.getByRole('button', { name: 'Abrir categoría Cafetería' });
  check(await folder.locator('img').getAttribute('data-category-icon') === 'apple', 'Folder ignored category icon');
  return { library: 52, creation: true, reload: true, edit: true, folder: true, keyboard: true, axe: true, widths: [1440, 390] };
}
