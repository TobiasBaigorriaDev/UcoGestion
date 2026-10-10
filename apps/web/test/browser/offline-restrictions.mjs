/* global window, document */
// eslint-disable-next-line @typescript-eslint/no-unused-expressions
async (page) => {
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  let requests = 0;
  page.on('request', request => { if (request.url().includes('/api/v1/')) requests++; });
  await page.waitForFunction(() => Boolean(window.restrictionsHarness));
  await page.getByRole('button', { name: 'Confirmar compra' }).waitFor();
  const screenshots = [];
  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await page.context().setOffline(true);
    await page.getByRole('heading', { name: 'Esta pantalla necesita conexión' }).waitFor();
    check(await page.getByRole('button', { name: 'Confirmar compra' }).count() === 0, 'Cached form still usable');
    check(await page.getByText('Reporte privado ya cargado').count() === 0, 'Cached report exposed');
    check(await page.evaluate(() => document.activeElement?.getAttribute('role') === 'alert'), 'Offline notice lacks focus');
    check((await page.evaluate(() => window.restrictionsHarness.restrictedRequests())).length === 25, 'Forbidden request accepted');
    check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'Offline notice overflows');
    const file = `output/playwright/offline-restrictions-${viewport.width}.png`;
    await page.screenshot({ path: file, fullPage: true }); screenshots.push(file);
    await page.context().setOffline(false);
    await page.getByRole('button', { name: 'Confirmar compra' }).waitFor();
  }
  check(requests === 0, 'Administrative transport invoked offline');
  return { passed: true, requests, screenshots, scenarios: ['network-loss', 'cached-form-block', 'cached-report-block',
    'api-and-csv-block', 'focus', 'desktop-mobile', 'network-return'] };
}
