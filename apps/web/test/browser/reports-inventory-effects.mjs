/* global document, window */
// eslint-disable-next-line @typescript-eslint/no-unused-expressions
async page => {
  await page.reload();
  await page.getByLabel('Tipo de reporte').selectOption('inventory-movements');
  const effects = page.locator('td[data-label="Efecto"] span');
  await effects.first().waitFor();
  const expected = [
    ['Ingreso', 'rgb(22, 101, 52)'], ['Egreso', 'rgb(180, 35, 24)'],
    ['Entrada por traslado', 'rgb(22, 101, 52)'], ['Salida por traslado', 'rgb(180, 35, 24)'],
  ];
  const axe = await page.request.get('http://127.0.0.1:5183/node_modules/axe-core/axe.min.js');
  await page.addScriptTag({ content: await axe.text() });
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const values = await effects.evaluateAll(elements => elements.map(element => ({
      text: element.textContent, color: window.getComputedStyle(element).color,
    })));
    if (values.length !== 8 || values.some((value, index) =>
      value.text !== expected[index % 4][0] || value.color !== expected[index % 4][1])) {
      throw new Error(`Incorrect inventory effects: ${JSON.stringify(values)}`);
    }
    const violations = await page.evaluate(async () => (await window.axe.run(document)).violations);
    if (violations.length) throw new Error(`Accessibility at ${width}: ${JSON.stringify(violations.map(value => value.id))}`);
    await page.screenshot({ path: `output/playwright/reports-inventory-effects-${width}.png`, fullPage: true });
  }
  return 'Spanish inventory effects with green increases and red decreases, including transfers; desktop/mobile and axe passed.';
}
