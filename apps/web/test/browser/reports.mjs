/* global document, window */
// eslint-disable-next-line @typescript-eslint/no-unused-expressions
async page => {
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  await page.reload();
  await page.getByRole('region', { name: 'Importe neto · ARS', exact: true }).waitFor();
  const response = await page.request.get('http://127.0.0.1:5183/node_modules/axe-core/axe.min.js');
  await page.addScriptTag({ content: await response.text() });
  for (const width of [1280, 768, 390]) {
    await page.setViewportSize({ width, height: 900 });
    check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `Overflow at ${width}`);
    const violations = await page.evaluate(async () => (await window.axe.run(document)).violations);
    check(violations.length === 0, `Accessibility at ${width}: ${JSON.stringify(violations.map(value => ({ id: value.id, nodes: value.nodes.map(node => node.target) })))}`);
    await page.screenshot({ path: `output/playwright/reports-${width}.png`, fullPage: true });
  }
  await page.getByRole('button', { name: 'Esta semana', exact: true }).click();
  await page.getByRole('button', { name: 'Personalizado', exact: true }).click();
  await page.getByLabel('Desde', { exact: true }).fill('2026-10-01');
  await page.getByLabel('Hasta', { exact: true }).fill('2026-10-01');
  await page.getByRole('button', { name: 'Aplicar filtros' }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('region', { name: 'Importe neto · ARS', exact: true }).getByText('Máximo: 45.000,00 ARS').waitFor();
  check(await page.locator('polyline').count() === 2, 'Line charts missing');
  await page.getByRole('button', { name: 'Todo el historial' }).click();
  await page.getByText(/Los gráficos admiten hasta 31 días/).waitFor();
  await page.getByLabel('Tipo de reporte').selectOption('inventory');
  check(await page.getByRole('group', { name: 'Período del reporte' }).count() === 0, 'Current inventory has historical controls');
  return 'Reports: responsive, contrast/axe, keyboard, presets, custom dates and inventory passed.';
}
