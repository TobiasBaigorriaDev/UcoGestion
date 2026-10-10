/* global window, URL */
// Playwright CLI evaluates this file as a function expression.
// eslint-disable-next-line @typescript-eslint/no-unused-expressions
async page => {
  const check = (value, message) => { if (!value) throw new Error(message); };
  await page.waitForFunction(() => Boolean(window.prerequisites));
  const stages = [];
  async function blocked(stage) {
    const result = await page.evaluate(() => window.prerequisites.open());
    check(Boolean(result.error) && JSON.stringify(result.before) === JSON.stringify(result.after), `${stage}: offline opening produced effects`);
    stages.push({ stage, error: result.error });
  }
  await blocked('no online authentication, authorization or synchronization');
  const anonymous = await page.evaluate(() => window.prerequisites.unauthorizedBootstrap());
  check(anonymous.status === 401, 'Anonymous bootstrap accepted');
  const origin = new URL(page.url()).origin;
  const login = await page.request.post(`${origin}/api/v1/auth/login`, { headers: { Origin: origin }, data: { email: 'category-browser@example.com', password: 'correct-password' } });
  check(login.status() === 204, 'Online authentication failed');
  const unregistered = await page.evaluate(() => window.prerequisites.unauthorizedBootstrap());
  check(unregistered.status === 403 && unregistered.body.code === 'OFFLINE_BOOTSTRAP_FORBIDDEN', 'Unregistered bootstrap accepted');
  await blocked('authenticated without device authorization');
  const registered = await page.evaluate(() => window.prerequisites.register());
  check(registered.status === 201, 'Device registration failed');
  await blocked('authorized device without synchronized bootstrap');
  const bootstrap = await page.evaluate(() => window.prerequisites.bootstrap());
  check(bootstrap.status === 201, 'Bootstrap failed');
  await blocked('bootstrap reservation without completed synchronization');
  const incomplete = await page.evaluate(() => window.prerequisites.grant(true));
  check(incomplete.status === 409 && incomplete.body.code === 'OFFLINE_SYNC_INCOMPLETE', 'Incomplete synchronization issued grant');
  await blocked('incomplete synchronization');
  const granted = await page.evaluate(() => window.prerequisites.grant(false));
  check(granted.status === 201, 'Verified initial synchronization failed');
  await page.context().setOffline(true);
  const allowed = await page.evaluate(() => window.prerequisites.open());
  check(Boolean(allowed.result?.sessionId) && allowed.after.envelopes === 1, 'Prepared offline opening failed');
  await page.context().setOffline(false);
  return { passed: true, stages, allowed, deviceId: registered.body.id, grantId: JSON.parse(bootstrap.body.payload).grantId };
}
