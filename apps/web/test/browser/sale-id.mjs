/* global window, document, navigator, URL, Buffer */
// eslint-disable-next-line @typescript-eslint/no-unused-expressions
async page => {
  try {
  const origin = new URL(page.url()).origin;
  const check = (value, message) => { if (!value) throw new Error(message); };
  check((await page.request.post(`${origin}/api/v1/auth/login`, { headers: { Origin: origin },
    data: { email: 'sale-id-browser@example.com', password: 'correct-password' } })).status() === 204, 'Login failed');
  await page.reload();
  await page.getByLabel('Buscar producto').fill('Producto navegador');
  await page.getByRole('button', { name: 'Agregar Producto navegador' }).click();
  await page.getByRole('button', { name: 'Confirmar venta', exact: true }).click();
  let region = page.getByRole('region', { name: 'Confirmación de venta' });
  await region.getByText('Venta confirmada', { exact: true }).waitFor();
  const onlineId = (await region.locator('dd').first().innerText()).trim();
  check(/^[0-9A-HJKMNP-TV-Z]{12}$/.test(onlineId), 'Short sale code absent');
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await region.getByRole('button', { name: 'Copiar ID de venta' }).focus(); await page.keyboard.press('Enter');
  check(await page.evaluate(() => navigator.clipboard.readText()) === onlineId, 'Keyboard copy changed ID');
  const popup = page.waitForEvent('popup');
  await region.getByRole('button', { name: 'Ver para imprimir' }).click();
  const printed = await popup; await printed.getByText(`ID de venta: ${onlineId}`, { exact: true }).waitFor(); await printed.close();
  const pdfDownload = page.waitForEvent('download'); await region.getByRole('button', { name: 'Descargar PDF' }).click();
  check((await pdfDownload).suggestedFilename() === `comprobante-${onlineId}.pdf`, 'Downloaded receipt mismatches ID');
  const sessionPage = page;
  page = await page.context().newPage(); await page.goto(sessionPage.url());
  region = page.getByRole('region', { name: 'Confirmación de venta' });
  await page.getByRole('button', { name: 'Venta offline', exact: true }).click();
  await page.getByLabel('PIN offline', { exact: true }).fill('offline-pin');
  await page.getByRole('button', { name: 'Autorizar este equipo y crear PIN' }).click();
  await page.getByRole('button', { name: 'Abrir caja sin conexión' }).waitFor();
  await page.getByLabel('Caja', { exact: true }).selectOption({ label: 'Caja offline' });
  await page.context().setOffline(true);
  await page.getByRole('button', { name: 'Abrir caja sin conexión' }).click();
  await page.getByLabel('Buscar producto').fill('Producto navegador');
  await page.getByRole('button', { name: 'Agregar Producto navegador' }).click();
  await page.getByRole('button', { name: 'Preparar cobro sin conexión' }).click();
  await page.getByRole('button', { name: 'Confirmar venta sin conexión' }).click();
  await region.getByText('Venta confirmada sin conexión', { exact: true }).waitFor();
  const offlineId = (await region.locator('dd').first().innerText()).trim();
  check(offlineId !== onlineId, 'Consecutive sale reused ID');
  await region.getByRole('button', { name: 'Copiar ID de venta' }).focus(); await page.keyboard.press('Enter');
  check(await page.evaluate(() => navigator.clipboard.readText()) === offlineId, 'Offline copy changed ID');
  await region.getByRole('button', { name: 'Ver comprobante local', exact: true }).click();
  await region.getByText(`ID de venta: ${offlineId}`, { exact: true }).waitFor();
  const localDownload = page.waitForEvent('download'); await region.getByRole('button', { name: 'Descargar comprobante local', exact: true }).click();
  const local = await localDownload;
  check(local.suggestedFilename() === `comprobante-${offlineId}.html`, 'Local download lost ID');
  const stream = await local.createReadStream(); const chunks = []; for await (const chunk of stream) chunks.push(chunk);
  check(Buffer.concat(chunks).toString().includes(`ID de venta: ${offlineId}`), 'Downloaded HTML lacks sale code');
  const localPopup = page.waitForEvent('popup'); await region.getByRole('button', { name: 'Ver comprobante local para imprimir' }).click();
  const localPrinted = await localPopup; await localPrinted.getByText(`ID de venta: ${offlineId}`, { exact: true }).waitFor(); await localPrinted.close();
  await page.context().setOffline(false);
  // The workspace shell revalidates online before unlocking the prepared identity.
  await page.close(); page = sessionPage; await page.reload();
  region = page.getByRole('region', { name: 'Confirmación de venta' });
  await page.getByRole('button', { name: 'Venta offline', exact: true }).click();
  await page.getByLabel('PIN offline', { exact: true }).fill('offline-pin');
  await page.getByRole('button', { name: 'Desbloquear mi identidad' }).click();
  await page.getByRole('button', { name: 'Ver comprobante de venta pendiente' }).click();
  await region.getByRole('button', { name: 'Ver comprobante local', exact: true }).click();
  await region.getByText(`ID de venta: ${offlineId}`, { exact: true }).waitFor();
  for (const width of [1280, 768, 390]) {
    await page.setViewportSize({ width, height: 844 });
    check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'Sale code overflows viewport');
    await page.screenshot({ path: `output/playwright/d03-sale-id-${width}.png`, fullPage: true });
  }
  const axeSource = await (await page.request.get(`${origin}/apps/web/node_modules/axe-core/axe.min.js`)).text();
  await page.addScriptTag({ content: axeSource });
  check((await page.evaluate(async () => (await window.axe.run(document)).violations)).length === 0, 'Offline interface accessibility failed');
  let dropped = false;
  await page.route('**/api/v1/offline/delivery/push', async route => {
    await route.fetch(); dropped = true; await route.abort('failed');
  });
  await page.getByRole('button', { name: 'Sincronizar mis pendientes' }).click();
  await page.getByRole('alert').filter({ hasText: 'No pudimos completar la acción' }).waitFor();
  check(dropped, 'Lost ACK regression did not reach the real backend');
  check(await region.locator('dd').first().innerText() === offlineId, 'Lost ACK changed ID');
  await page.unroute('**/api/v1/offline/delivery/push');
  await page.getByRole('button', { name: 'Sincronizar mis pendientes' }).click();
  await page.getByText('No tenés operaciones pendientes.', { exact: true }).waitFor();
  check(await region.locator('dd').first().innerText() === offlineId, 'ACK changed displayed ID');
  await page.getByText(`ID de venta: ${offlineId}`, { exact: true }).waitFor({ state: 'detached' });
  await page.getByRole('button', { name: 'Consultar venta por ID' }).click();
  await page.getByLabel('ID de venta', { exact: true }).fill(offlineId);
  await page.getByRole('button', { name: 'Consultar venta', exact: true }).click();
  await page.getByRole('heading', { name: `Venta ${offlineId}` }).waitFor();
  return { passed: true, onlineId, offlineId, backend: 'real NestJS/PostgreSQL runtime' };
  } catch (error) {
    await page.screenshot({ path: 'output/playwright/d03-failure.png', fullPage: true }).catch(() => {});
    throw new Error(`${error.message}; UI: ${await page.locator('body').innerText().catch(() => 'unavailable')}`, { cause: error });
  }
}
