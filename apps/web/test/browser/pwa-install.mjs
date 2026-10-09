/* global window, navigator, URL, Image */
// eslint-disable-next-line @typescript-eslint/no-unused-expressions
async page => {
  const check = (value, message) => { if (!value) throw new Error(message); };
  await page.goto('http://localhost:3001');
  const link = await page.locator('link[rel="manifest"]').getAttribute('href');
  check(link, 'Production page has no manifest');
  const manifest = await (await page.request.get(new URL(link, page.url()).href)).json();
  check(manifest.display === 'standalone' && manifest.start_url === '/workspace', 'Standalone entry point missing');
  for (const size of [192, 512]) {
    const icon = manifest.icons.find(value => value.sizes === `${size}x${size}`);
    check(icon && icon.type === 'image/png', 'Manifest icon missing');
    const response = await page.request.get(new URL(icon.src, page.url()).href);
    check(response.ok() && response.headers()['content-type'].includes('image/png'), 'Icon not served as PNG');
    check(await page.evaluate(async ({ src, size }) => {
      const image = new Image(); image.src = src; await image.decode();
      return image.naturalWidth === size && image.naturalHeight === size;
    }, { src: icon.src, size }), 'Decoded icon dimensions differ');
  }
  await page.evaluate(async () => {
    await navigator.serviceWorker.register('/sw.js'); await navigator.serviceWorker.ready;
  });
  const worker = await page.request.get('http://localhost:3001/sw.js');
  check(worker.headers()['cache-control'].includes('no-cache'), 'Worker lacks no-cache');
  const cdp = await page.context().newCDPSession(page);
  const app = await cdp.send('Page.getAppManifest');
  check(app.errors.length === 0, `Browser rejected manifest: ${JSON.stringify(app.errors)}`);
  const install = await cdp.send('Page.getInstallabilityErrors');
  check(install.installabilityErrors.length === 0, `Not installable: ${JSON.stringify(install)}`);
  const id = new URL(manifest.id ?? manifest.start_url, page.url()).href;
  await cdp.send('PWA.install', { manifestId: id, installUrlOrBundleUrl: page.url() });
  const state = await cdp.send('PWA.getOsAppState', { manifestId: id });
  check(state.badgeCount !== undefined, 'No installed app state');
  await cdp.send('PWA.changeAppUserSettings', { manifestId: id, displayMode: 'standalone' });
  const launched = page.context().waitForEvent('page');
  await cdp.send('PWA.launch', { manifestId: id });
  const appPage = await launched;
  await appPage.waitForLoadState();
  check(await appPage.evaluate(() => window.matchMedia('(display-mode: standalone)').matches), 'Installed app did not launch standalone');
  await appPage.close();
  await cdp.send('PWA.uninstall', { manifestId: id });
  return { passed: true, browser: page.context().browser().version(), os: await page.evaluate(() => navigator.platform), manifest, installedStandalone: true };
}
