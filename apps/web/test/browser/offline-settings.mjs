/* global document, window */
// eslint-disable-next-line @typescript-eslint/no-unused-expressions
async page => {
  const check = (value, message) => { if (!value) throw new Error(message); };
  await page.context().setOffline(false);
  await page.goto('http://127.0.0.1:4179/apps/web/test/browser/offline-settings.html');
  await page.getByRole('button', { name: 'Desbloquear mi identidad' }).waitFor();
  await page.getByLabel('PIN offline', { exact: true }).fill('offline-pin');
  await page.getByRole('button', { name: 'Desbloquear mi identidad' }).focus(); await page.keyboard.press('Enter');
  await page.getByRole('heading', { name: 'Mis operaciones pendientes' }).waitFor();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.evaluate(() => document.fonts.ready);
    check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'Offline settings overflow');
    check((await page.evaluate(() => window.axe.run(document))).violations.length === 0, 'Offline axe failed');
    await page.screenshot({ path: `output/playwright/offline-settings-${width}.png`, fullPage: true });
  }
  const before = await page.evaluate(async () => (await window.offlineSettingsHarness.pending()).map(row => ({ id: row.id, bytes: Array.from(row.envelope) })));
  await page.context().setOffline(true);
  await page.getByRole('button', { name: 'Sincronizar mis pendientes' }).click();
  await page.getByRole('alert').waitFor();
  check(JSON.stringify(before) === JSON.stringify(await page.evaluate(async () => (await window.offlineSettingsHarness.pending()).map(row => ({ id: row.id, bytes: Array.from(row.envelope) })))), 'Recoverable error changed pending bytes');
  await page.context().setOffline(false);
  await page.getByRole('button', { name: 'Sincronizar mis pendientes' }).click();
  await page.getByText('No tenés operaciones pendientes.', { exact: true }).waitFor();
  await page.evaluate(() => window.offlineSettingsHarness.retire());
  check(await page.getByRole('heading', { name: 'Mis operaciones pendientes' }).count() === 0, 'Retired identity detail remained visible');
  await page.evaluate(() => window.offlineSettingsHarness.seedForeign());
  await page.getByText(/1 entregas pendientes en este equipo/).waitFor();
  check(!/foreign-private|77777777|11111111|22222222|33333333/.test(await page.locator('body').innerText()), 'Foreign identity metadata leaked');
  await page.context().setOffline(true);
  await page.getByRole('button', { name: 'Reintentar entrega del equipo' }).click();
  await page.getByText(/La entrega no pudo completarse/).waitFor();
  check(!/foreign-private|77777777|11111111|22222222|33333333/.test(await page.locator('body').innerText()), 'Retry leaked foreign payload');
  check((await page.evaluate(() => window.axe.run(document))).violations.length === 0, 'Generic retry axe failed');
  await page.screenshot({ path: 'output/playwright/opaque-progress-retired-390.png', fullPage: true });
  await page.context().setOffline(false);
  await page.getByRole('button', { name: 'Reintentar entrega del equipo' }).click();
  await page.getByText(/0 entregas pendientes en este equipo/).waitFor();
  return { passed: true, scenarios: ['real-pin', 'verified-identity-queue', 'keyboard', 'mobile', 'axe-with-contrast', 'recoverable-error-exact-bytes', 'signed-ack', 'retirement', 'generic-foreign-pending', 'generic-error-no-private-data', 'generic-signed-ack'] };
}
