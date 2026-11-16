// eslint-disable-next-line @typescript-eslint/no-unused-expressions
async page => {
  await page.reload();
  await page.getByLabel('Tipo de reporte').selectOption('inventory');
  const quantities = page.locator('td[data-label="Cantidad"]');
  await quantities.first().waitFor();
  const values = await quantities.allTextContents();
  if (values[0] !== '24' || values[1] !== '1,24' || values[2] !== '0,50') {
    throw new Error(`Unexpected quantities: ${JSON.stringify(values)}`);
  }
  const minimums = await page.locator('td[data-label="Mínimo"]').allTextContents();
  if (minimums.some(value => value !== '5')) throw new Error('Minimum quantities were not formatted');
  await page.getByLabel('Tipo de reporte').selectOption('inventory-movements');
  await page.locator('td[data-label="Cambio"]').first().waitFor();
  const deltas = await page.locator('td[data-label="Cambio"]').allTextContents();
  if (deltas.some((value, index) => value !== (index % 2 === 0 ? '2' : '-2'))) throw new Error('Movement quantities were not formatted');
  return 'Inventory quantities: integers without decimals, fractions rounded with comma and two decimals.';
}
