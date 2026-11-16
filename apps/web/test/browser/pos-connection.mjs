/* global document, window */
// eslint-disable-next-line @typescript-eslint/no-unused-expressions
async page => {
  const check = (value, message) => { if (!value) throw new Error(message); };
  const faults = []; page.on('pageerror', error => faults.push(error.message));
  await page.context().setOffline(false);
  await page.goto('http://127.0.0.1:4179/apps/web/test/browser/offline-settings.html?connection');
  await page.waitForFunction(() => Boolean(window.offlineSettingsHarness));
  await page.getByRole('button', { name: 'Confirmar venta', exact: true }).waitFor();
  const screenshots = [];
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await page.context().setOffline(true);
    await page.getByRole('heading', { name: 'Estás sin internet' }).waitFor();
    check(!await page.getByRole('button', { name: 'Confirmar venta', exact: true }).isVisible(), 'Online sale still accessible');
    check(await page.evaluate(() => document.activeElement?.getAttribute('role') === 'alert'), 'Notice lacks focus');
    check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'Notice overflows');
    const violations = await page.evaluate(async () => (await window.axe.run(document)).violations);
    check(violations.length === 0, JSON.stringify(violations));
    const file = `output/playwright/pos-connection-${viewport.width}.png`;
    await page.screenshot({ path: file, fullPage: true }); screenshots.push(file);
    await page.getByRole('button', { name: 'Pasar al POS sin conexión' }).click();
    await page.getByLabel('PIN offline', { exact: true }).fill('offline-pin');
    await page.getByRole('button', { name: 'Desbloquear mi identidad' }).click();
    await page.getByRole('button', { name: 'Preparar cobro sin conexión' }).waitFor();
    check(!await page.getByRole('button', { name: 'Confirmar venta', exact: true }).isVisible(), 'Online sale visible in local mode');
    await page.context().setOffline(false);
    await page.getByRole('button', { name: 'Volver al POS online' }).click();
    check(await page.getByLabel('Carrito online').inputValue() === 'Venta a recuperar', 'Online cart lost');
    // Use the same initialized local mode on the second pass.
    if (viewport.width === 1440) {
      await page.getByRole('button', { name: 'Preparar o abrir POS sin conexión' }).click();
      await page.getByRole('button', { name: 'Bloquear datos offline' }).click();
      await page.getByRole('button', { name: 'Volver al POS online' }).click();
    }
  }
  check(faults.length === 0, faults.join('; '));
  return { passed: true, screenshots, scenarios: ['network-loss', 'online-controls-blocked', 'same-page-offline-unlock', 'real-crypto-and-local-pos', 'network-return', 'cart-preserved', 'desktop-mobile', 'axe-and-focus'] };
}
