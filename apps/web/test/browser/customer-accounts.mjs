/* global URL, document, window */
// eslint-disable-next-line @typescript-eslint/no-unused-expressions
async page => {
  const origin = new URL(page.url()).origin;
  const check = (value, message) => { if (!value) throw new Error(message); };
  const login = await page.request.post(`${origin}/api/v1/auth/login`, { headers: { Origin: origin }, data: { email: 'sale-id-browser@example.com', password: 'correct-password' } });
  check(login.status() === 204, 'Account browser login failed');
  await page.reload();
  await page.getByRole('button', { name: 'Clientes', exact: true }).click();
  await page.getByRole('button', { name: 'Cuenta corriente de Ana Cuenta', exact: true }).click();
  const account = page.getByRole('region', { name: 'Cuenta de Ana Cuenta', exact: true });
  await account.getByLabel('Tope de deuda').fill('7');
  await account.getByRole('button', { name: 'Guardar tope' }).click();
  try { await account.getByText('Tope de deuda actualizado.', { exact: true }).waitFor(); }
  catch (cause) { throw new Error(`Limit update failed: ${await account.innerText()}`, { cause }); }
  await page.getByRole('button', { name: 'Venta online', exact: true }).click();
  await page.getByLabel('Buscar producto').fill('Producto a cuenta navegador');
  await page.getByRole('button', { name: 'Agregar Producto a cuenta navegador', exact: true }).click();
  await page.getByLabel('Cliente de la venta').selectOption({ label: 'Ana Cuenta' });
  await page.getByLabel('A cuenta del cliente', { exact: true }).check();
  await page.getByText(/La compra supera el crédito disponible/).waitFor();
  check(await page.getByRole('button', { name: 'Confirmar venta', exact: true }).isDisabled(), 'Credit limit did not block full credit');
  await page.getByRole('button', { name: 'Agregar pago', exact: true }).click();
  await page.getByLabel('Importe aplicado 1', { exact: true }).fill('4.00');
  await page.getByText('6,00 ARS', { exact: true }).waitFor();
  const axeSource = await (await page.request.get(`${origin}/apps/web/node_modules/axe-core/axe.min.js`)).text();
  await page.addScriptTag({ content: axeSource });
  const inspect = async name => {
    for (const [width, viewport] of [[1280, 'desktop'], [390, 'mobile']]) {
      await page.setViewportSize({ width, height: 844 });
      await page.evaluate(() => document.fonts.ready);
      check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${name} overflows at ${width}`);
      const violations = await page.evaluate(async () => (await window.axe.run(document)).violations.map(item => ({ id: item.id, nodes: item.nodes.map(node => node.target) })));
      check(!violations.length, JSON.stringify(violations));
      await page.screenshot({ path: `.impeccable/review/${name}-${viewport}.png`, fullPage: true });
    }
  };
  await inspect('account-pos');
  await page.context().setOffline(true);
  await page.getByRole('button', { name: 'Confirmar venta', exact: true }).click();
  await page.getByRole('alert').waitFor();
  check(!(await page.getByRole('region', { name: 'Confirmación de venta' }).count()), 'Offline credit was confirmed locally');
  await page.context().setOffline(false);
  let saleDropped = false;
  await page.route('**/api/v1/sales', async route => {
    if (saleDropped || route.request().method() !== 'POST') return route.continue();
    const response = await route.fetch(); check(response.status() === 201, 'Lost-response credit sale was not committed');
    saleDropped = true; await route.abort('failed');
  });
  const saleResponseLost = page.waitForEvent('requestfailed', {
    predicate: request => request.method() === 'POST' && request.url().endsWith('/api/v1/sales'),
  });
  await page.getByRole('button', { name: 'Confirmar venta', exact: true }).click();
  await saleResponseLost;
  await page.getByText('Reintentá para recuperar el resultado de esta venta. Se conservaron los datos originales.', { exact: true }).waitFor();
  check(saleDropped, 'Credit sale response was not dropped');
  await page.evaluate(() => window.dispatchEvent(new window.Event('visibilitychange')));
  await page.getByText('1,00 ARS', { exact: true }).waitFor();
  check(await page.getByRole('button', { name: 'Confirmar venta', exact: true }).isEnabled(), 'Refreshed limit blocked sale recovery');
  await page.getByRole('button', { name: 'Confirmar venta', exact: true }).click();
  await page.getByRole('region', { name: 'Confirmación de venta' }).waitFor();
  await page.unroute('**/api/v1/sales');
  await page.getByRole('button', { name: 'Clientes', exact: true }).click();
  await page.getByText('Deuda: 6,00 ARS', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Cuenta corriente de Ana Cuenta', exact: true }).click();
  await account.locator('dl').getByText('6,00 ARS', { exact: true }).waitFor();
  let dropped = false;
  await page.route('**/account/collections', async route => {
    if (dropped) return route.continue();
    const response = await route.fetch(); check(response.status() === 201, 'Lost-response collection was not committed');
    dropped = true; await route.abort('failed');
  });
  await account.getByLabel('Importe a cobrar', { exact: true }).fill('2');
  await account.getByRole('button', { name: 'Registrar cobro', exact: true }).click();
  await account.getByRole('alert').waitFor();
  check(dropped, 'Lost response did not reach backend');
  await account.getByRole('button', { name: 'Registrar cobro', exact: true }).click();
  await account.locator('dl').getByText('4,00 ARS', { exact: true }).waitFor();
  await page.unroute('**/account/collections');
  await account.getByRole('button', { name: 'Revertir cobro', exact: true }).click();
  await account.getByLabel('Motivo de reversión', { exact: true }).fill('Cobro de prueba equivocado');
  await account.getByRole('button', { name: 'Confirmar reversión', exact: true }).click();
  await account.locator('dl').getByText('6,00 ARS', { exact: true }).waitFor();
  await inspect('customer-account');
  return { passed: true, backend: 'real NestJS/PostgreSQL runtime', partialCredit: '6.00', saleReplayedAfterCreditRefresh: true, collectionReplayedOnce: true, offlineCreditRejected: true, viewports: [1280, 390] };
}
