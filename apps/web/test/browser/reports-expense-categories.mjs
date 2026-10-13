/* global document, window */
// eslint-disable-next-line @typescript-eslint/no-unused-expressions
async page => {
  const check = (value, message) => { if (!value) throw new Error(message); };
  await page.reload();
  await page.getByLabel('Tipo de reporte').selectOption('expenses');
  const chart = page.getByRole('region', { name: 'Gastos por categoría · ARS', exact: true });
  await chart.waitFor();
  check(await chart.locator('polyline').count() === 3, 'Expense categories are not on a single plot');
  const colors = await chart.locator('polyline').evaluateAll(lines => lines.map(line => window.getComputedStyle(line).stroke));
  check(new Set(colors).size === 3, 'Category colors are not distinct');
  const axe = await page.request.get('http://127.0.0.1:5183/node_modules/axe-core/axe.min.js');
  await page.addScriptTag({ content: await axe.text() });
  await chart.getByText('Ver valores por hora').focus();
  await page.keyboard.press('Enter');
  for (const name of ['Luz', 'Agua', 'Alquiler']) await chart.getByRole('columnheader', { name }).waitFor();
  for (const width of [1280, 768, 390]) {
    await page.setViewportSize({ width, height: 900 });
    check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `Overflow at ${width}`);
    const violations = await page.evaluate(async () => (await window.axe.run(document)).violations);
    check(violations.length === 0, `Accessibility at ${width}: ${JSON.stringify(violations.map(value => value.id))}`);
    await page.screenshot({ path: `output/playwright/reports-expense-categories-${width}.png`, fullPage: true });
  }
  await page.getByRole('button', { name: 'Esta semana', exact: true }).click();
  await chart.getByText('Ver valores diarios').waitFor();
  return 'Expense categories: shared plot, distinct colors, responsive, keyboard and axe passed.';
}
