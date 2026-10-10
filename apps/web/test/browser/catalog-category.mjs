/* global window, document, URL */
// eslint-disable-next-line @typescript-eslint/no-unused-expressions
async page => {
  const url = page.url();
  const origin = new URL(url).origin;
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const login = await page.request.post(`${origin}/api/v1/auth/login`, {
    headers: { Origin: origin }, data: { email: 'category-browser@example.com', password: 'correct-password' },
  });
  check(login.status() === 204, 'Real HTTP login failed');
  await page.reload();
  await page.getByRole('button', { name: 'Editar Original navegador' }).waitFor();
  const patches = [];
  page.on('request', request => {
    if (request.method() === 'PATCH') patches.push(request);
  });
  const screenshots = [];
  for (const [index, viewport] of [{ width: 1280, height: 800 }, { width: 390, height: 844 }].entries()) {
    await page.setViewportSize(viewport);
    const oldName = index === 0 ? 'Original navegador' : 'Renombrada escritorio';
    const newName = index === 0 ? 'Renombrada escritorio' : 'Renombrada móvil';
    await page.getByRole('button', { name: `Editar ${oldName}` }).click();
    const input = page.getByRole('textbox', { name: `Nuevo nombre de ${oldName}` });
    await input.fill('');
    await page.getByRole('button', { name: `Guardar nombre de ${oldName}` }).click();
    await page.getByRole('alert').filter({ hasText: 'Ingresá un nombre' }).waitFor();
    check(patches.length === index, 'Invalid form sent a mutation');
    await input.fill(newName);
    await page.keyboard.press('Tab');
    const response = page.waitForResponse(response => response.request().method() === 'PATCH');
    await page.keyboard.press('Enter');
    check((await response).status() === 200, 'Real category edit failed');
    await page.getByRole('button', { name: `Editar ${newName}` }).waitFor();
    check(patches[index].headers()['if-match'] === String(index + 1), 'UI sent an incorrect version');
    check(Boolean(patches[index].headers()['idempotency-key']), 'UI omitted idempotency');
    await page.getByRole('button', { name: `Editar ${newName}` }).click();
    const source = await (await page.request.get(`${origin}/apps/web/node_modules/axe-core/axe.min.js`)).text();
    await page.addScriptTag({ content: source });
    check((await page.evaluate(async () => (await window.axe.run(document)).violations)).length === 0, 'Category form accessibility failed');
    check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'Category form overflows');
    const file = `output/playwright/t236i-category-${viewport.width}.png`;
    await page.screenshot({ path: file, fullPage: true }); screenshots.push(file);
    await page.getByRole('button', { name: `Cancelar edición de ${newName}` }).click();
  }
  const count = patches.length;
  await page.context().setOffline(true);
  await page.getByRole('heading', { name: 'Esta pantalla necesita conexión' }).waitFor();
  check(await page.getByRole('button', { name: /Editar/ }).count() === 0, 'Offline exposes administrative commands');
  check(patches.length === count, 'Offline sent a mutation');
  await page.context().setOffline(false);
  await page.getByRole('button', { name: 'Editar Renombrada móvil' }).waitFor();
  return { passed: true, patches: patches.length, screenshots, backend: 'real NestJS/PostgreSQL runtime' };
}
