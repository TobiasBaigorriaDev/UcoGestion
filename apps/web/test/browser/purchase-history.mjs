/* global document, window, URL */
// eslint-disable-next-line @typescript-eslint/no-unused-expressions
async page => {
  const check = (value, message) => { if (!value) throw new Error(message); };
  const origin = new URL(page.url()).origin;
  check((await page.request.post(`${origin}/api/v1/auth/login`, { headers: { Origin: origin },
    data: { email: 'purchase-history-browser@example.com', password: 'correct-password' } })).status() === 204,
  'Login failed');
  await page.reload();
  const history = page.getByRole('region', { name: 'Historial de compras' });
  await history.getByText('Bodega Sur').waitFor();
  await history.locator('svg polyline').first().waitFor();
  check(await history.locator('svg polyline').count() === 2, 'Purchase trends are not line charts');
  check(await history.getByText('Cajas × 2.000').count() === 1, 'Historic products missing');
  await history.getByRole('button', { name: /Ver compra/ }).focus();
  await page.keyboard.press('Enter');
  const detail = page.getByRole('region', { name: 'Detalle de compra' });
  await detail.getByText('Bodega Sur').waitFor();
  check(await detail.getByText(/Cajas/).count() === 1, 'Historic detail missing');
  const axeSource = await (await page.request.get(`${origin}/apps/web/node_modules/axe-core/axe.min.js`)).text();
  await page.addScriptTag({ content: axeSource });
  for (const width of [390, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `Overflow at ${width}`);
    if (width === 1280) {
      const layout = await page.evaluate(() => {
        const create = document.querySelector('[aria-labelledby="purchase-create-heading"]')?.getBoundingClientRect();
        const lookup = document.querySelector('[aria-labelledby="purchase-lookup-heading"]')?.getBoundingClientRect();
        const detailButton = document.querySelector('[aria-label^="Ver compra"]')?.getBoundingClientRect();
        const quantity = document.querySelector('#purchase-quantity-0')?.getBoundingClientRect();
        const cost = document.querySelector('#purchase-cost-0')?.getBoundingClientRect();
        const reason = document.querySelector('#purchase-cancel-reason')?.getBoundingClientRect();
        return { create: create && { x: create.x, width: create.width },
          lookup: lookup && { x: lookup.x, width: lookup.width }, buttonWidth: detailButton?.width,
          quantityY: quantity?.y, costY: cost?.y, reasonWidth: reason?.width, reasonHeight: reason?.height };
      });
      check(layout.create && layout.lookup && layout.lookup.x > layout.create.x + layout.create.width,
        `Purchase operations are not side by side on desktop: ${JSON.stringify(layout)}`);
      check(layout.buttonWidth && layout.buttonWidth < 180,
        `History detail button stretches across desktop row: ${JSON.stringify(layout)}`);
      check(layout.quantityY === layout.costY && layout.reasonWidth && layout.reasonWidth > 300
        && layout.reasonHeight && layout.reasonHeight >= 100,
      `Purchase form wastes desktop space: ${JSON.stringify(layout)}`);
    }
    await page.screenshot({ path: `output/playwright/purchase-history-${width}.png`, fullPage: true });
    const violations = await page.evaluate(async () => (await window.axe.run(document)).violations);
    check(violations.length === 0, `Accessibility at ${width}: ${JSON.stringify(violations.map(violation => ({
      id: violation.id, nodes: violation.nodes.map(node => node.target),
    })))}`);
  }
  await history.getByLabel('Desde').fill('2024-01-01');
  await history.getByLabel('Hasta').fill('2024-01-01');
  await history.getByRole('button', { name: 'Aplicar filtros' }).click();
  await history.getByText('No hay compras para estos filtros.').waitFor();
  return { passed: true, backend: 'real NestJS/PostgreSQL runtime', widths: [390, 768, 1280] };
}
