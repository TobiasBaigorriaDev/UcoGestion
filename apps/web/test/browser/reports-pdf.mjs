/* global URL, document */
// eslint-disable-next-line @typescript-eslint/no-unused-expressions
async page => {
  if (new URL(page.url()).pathname === '/login') {
    await page.getByLabel('Correo electrónico').fill('dueno@uco-demo.test');
    await page.getByLabel('Contraseña', { exact: true }).fill('DuenoPrueba2026!');
    await page.getByRole('button', { name: 'Iniciar sesión', exact: true }).click();
    await page.waitForURL('**/organizations/select');
  }
  if (new URL(page.url()).pathname === '/organizations/select') {
    await page.getByRole('button', { name: 'Almacén Don Pedro OWNER' }).click();
    await page.waitForURL('**/workspace');
  }
  await page.goto('http://localhost:3000/workspace/reports');
  await page.getByLabel('Tipo de reporte').selectOption('inventory');
  await page.getByRole('table', { name: 'Registros del reporte con los filtros aplicados' }).waitFor();
  await page.getByRole('button', { name: 'Generar PDF' }).click();
  const download = page.getByRole('link', { name: 'Descargar PDF listo' });
  await download.waitFor({ timeout: 30000 });
  const previousPath = new URL(await download.getAttribute('href')).pathname;
  await page.getByRole('button', { name: 'Generar PDF' }).click();
  await page.waitForFunction(previous => {
    const link = [...document.querySelectorAll('a')].find(item => item.textContent === 'Descargar PDF listo');
    return link && new URL(link.href).pathname !== previous;
  }, previousPath, { timeout: 30000 });
  const response = await page.request.get(await download.getAttribute('href'));
  if (!response.ok()) throw new Error(`PDF download failed: ${response.status()}`);
  const bytes = await response.body();
  if (bytes.subarray(0, 5).toString() !== '%PDF-') throw new Error('Downloaded content is not a PDF');
  const file = page.waitForEvent('download');
  await download.click();
  const downloaded = await file;
  if (!/^reporte-inventario-actual-\d{4}-\d{2}-\d{2}\.pdf$/.test(downloaded.suggestedFilename())) {
    throw new Error('PDF filename still exposes internal codes');
  }
  await downloaded.saveAs('output/pdf/inventario-actual.pdf');
  return { status: response.status(), type: response.headers()['content-type'], bytes: bytes.length };
}
