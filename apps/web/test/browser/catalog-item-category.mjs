/* global document, window, URL */
// eslint-disable-next-line @typescript-eslint/no-unused-expressions
async page => {
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const origin = new URL(page.url()).origin;
  const login = await page.request.post(`${origin}/api/v1/auth/login`, {
    headers: { Origin: origin }, data: { email: 'category-browser@example.com', password: 'correct-password' },
  });
  check(login.status() === 204, 'Real HTTP login failed');
  await page.reload();
  const mutations = [];
  page.on('request', request => {
    if (['POST', 'PATCH'].includes(request.method()) && /\/catalog\/items(?:\/[^/]+)?$/.test(new URL(request.url()).pathname)) mutations.push(request);
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole('textbox', { name: 'Nombre del ítem nuevo' }).fill('Producto navegador');
  const initialPrice = page.getByRole('textbox', { name: 'Precio de venta opcional' });
  const alignedFields = await Promise.all(['#item-new-category', '#item-new-price', '#item-new-sku'].map(selector => page.locator(selector).boundingBox()));
  check(alignedFields.every(box => box && Math.abs(box.y - alignedFields[0].y) < 2), 'Category, price and SKU controls are not aligned on desktop');
  await initialPrice.fill('-1');
  await page.getByRole('button', { name: 'Crear ítem', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Ingresá un precio' }).waitFor();
  check(mutations.length === 0, 'Invalid price sent a mutation');
  await initialPrice.fill('1500,50');
  await page.getByRole('combobox', { name: 'Categoría del ítem nuevo' }).selectOption({ label: 'Almacén navegador' });
  const createResponse = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/catalog/items'));
  await page.getByRole('button', { name: 'Crear ítem', exact: true }).click();
  check((await createResponse).status() === 201, 'Category assignment on creation failed');
  await page.getByText('Precio: 1500.50', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Editar Producto navegador', exact: true }).click();
  const category = page.getByRole('combobox', { name: 'Categoría de Producto navegador', exact: true });
  check(await category.locator('option:checked').textContent() === 'Almacén navegador', 'Current category is not selected');
  const source = await (await page.request.get(`${origin}/apps/web/node_modules/axe-core/axe.min.js`)).text();
  await page.addScriptTag({ content: source });
  check((await page.evaluate(async () => (await window.axe.run(document)).violations)).length === 0, 'Desktop item form accessibility failed');
  check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'Desktop item form overflows');
  await page.screenshot({ path: 'output/playwright/t236q-initial-price-1280.png', fullPage: true });
  await category.selectOption({ label: 'Bebidas navegador' });
  const changeResponse = page.waitForResponse(response => response.request().method() === 'PATCH');
  await page.getByRole('button', { name: 'Guardar cambios de Producto navegador' }).click();
  check((await changeResponse).status() === 200, 'Changing category failed');
  await page.getByText('Categoría: Bebidas navegador', { exact: true }).waitFor();
  await page.reload();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Editar Producto navegador', exact: true }).click();
  check(await category.locator('option:checked').textContent() === 'Bebidas navegador', 'Assignment did not persist on reload');
  await page.getByText('Precio: 1500.50', { exact: true }).waitFor();
  await page.addScriptTag({ content: source });
  check((await page.evaluate(async () => (await window.axe.run(document)).violations)).length === 0, 'Item form accessibility failed');
  check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'Item form overflows on mobile');
  await page.screenshot({ path: 'output/playwright/t236q-initial-price-390.png', fullPage: true });
  await category.selectOption('');
  const removeResponse = page.waitForResponse(response => response.request().method() === 'PATCH');
  await page.getByRole('button', { name: 'Guardar cambios de Producto navegador' }).click();
  check((await removeResponse).status() === 200, 'Removing category failed');
  await page.getByText('Categoría: Sin categoría', { exact: true }).waitFor();
  check(mutations.length === 3, 'Unexpected item mutations');
  check(mutations.every(request => request.headers()['idempotency-key']), 'Missing idempotency');
  check(mutations[1].headers()['if-match'] === '2' && mutations[2].headers()['if-match'] === '3', 'Incorrect versions');
  check(mutations[0].postDataJSON().price === '1500.50', 'Price was not sent as a canonical decimal string');
  return { passed: true, mutations: mutations.length, backend: 'real NestJS/PostgreSQL runtime' };
}
