/* global window, document, URL */
// eslint-disable-next-line @typescript-eslint/no-unused-expressions
async page => {
  const check = (value, message) => { if (!value) throw new Error(message); };
  const origin = new URL(page.url()).origin;
  check((await page.request.post(`${origin}/api/v1/auth/login`, { headers: { Origin: origin },
    data: { email: 'sale-id-browser@example.com', password: 'correct-password' } })).status() === 204, 'Login failed');
  await page.reload();
  await page.getByRole('button', { name: 'Consultar venta por ID' }).click();
  const history = page.getByRole('region', { name: 'Historial de ventas' });
  await history.getByLabel('Desde', { exact: true }).fill('2025-01-01');
  await history.getByLabel('Hasta', { exact: true }).fill('2025-01-01');
  await history.getByRole('button', { name: 'Aplicar filtros' }).click();
  await history.locator('svg polyline').first().waitFor({ state: 'attached' });
  check(await history.locator('svg polyline').count() === 2, 'Sales trends are not line charts');
  const list = history.getByRole('list', { name: 'Ventas de las sucursales autorizadas' });
  await list.getByRole('listitem').first().waitFor();
  await page.waitForFunction(() => document.querySelectorAll('ul[aria-label="Ventas de las sucursales autorizadas"] > li').length === 25);
  const firstIds = await list.getByRole('button').allTextContents();
  await history.getByRole('button', { name: 'Siguiente' }).click();
  await history.getByText('Página 2', { exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelectorAll('ul[aria-label="Ventas de las sucursales autorizadas"] > li').length === 2);
  const secondIds = await list.getByRole('button').allTextContents();
  check(secondIds.every(id => !firstIds.includes(id)), 'Cursor repeated sales');
  check(await history.getByRole('button', { name: 'Siguiente' }).isDisabled(), 'Last page has next cursor');
  await history.getByRole('button', { name: 'Anterior' }).click();
  await history.getByText('Página 1', { exact: true }).waitFor();
  await list.getByRole('button').first().focus(); await page.keyboard.press('Enter');
  const detail = page.getByRole('region', { name: /^Venta / });
  await detail.getByRole('button', { name: 'Ver para imprimir' }).waitFor();
  await detail.getByLabel('Motivo de anulación').fill('Error de carga');
  await detail.getByRole('button', { name: 'Anular venta', exact: true }).click();
  await detail.getByText(/Error de carga/).waitFor();
  await history.getByLabel('Estado de venta').selectOption('CANCELLED');
  await history.getByRole('button', { name: 'Aplicar filtros' }).click();
  await page.waitForFunction(() => document.querySelectorAll('ul[aria-label="Ventas de las sucursales autorizadas"] > li').length === 1);
  await list.getByText('Anulada', { exact: true }).waitFor();
  const axeSource = await (await page.request.get(`${origin}/apps/web/node_modules/axe-core/axe.min.js`)).text();
  await page.addScriptTag({ content: axeSource });
  for (const width of [390, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `Overflow at ${width}`);
    check((await page.evaluate(async () => (await window.axe.run(document)).violations)).length === 0, `Accessibility at ${width}`);
    await page.screenshot({ path: `output/playwright/sales-history-${width}.png`, fullPage: true });
  }
  await history.getByLabel('Desde').fill('2024-01-01'); await history.getByLabel('Hasta').fill('2024-01-01');
  await history.getByRole('button', { name: 'Aplicar filtros' }).click();
  await history.getByText('No hay ventas para estos filtros.', { exact: true }).waitFor();
  return { passed: true, backend: 'real NestJS/PostgreSQL runtime', pages: [25, 2], widths: [390, 768, 1280] };
}
