/* global window, document, URL */
// Playwright CLI evaluates this file as a function expression.
// eslint-disable-next-line @typescript-eslint/no-unused-expressions
async page => {
  const check = (value, message) => { if (!value) throw new Error(message); };
  const params = new URL(page.url()).searchParams;
  const organizationId = params.get('organizationId'), other = params.get('other'), userId = params.get('userId');
  await page.getByRole('combobox', { name: 'Organización activa' }).waitFor();
  const before = await page.evaluate(() => window.switchEvidence());
  check(before.active === organizationId && before.unlocked, 'Missing active offline identity');
  check(await page.evaluate(() => window.readPrior()) === 'private-a', 'Prior encrypted state not readable before switch');
  for (const id of params.get('denied').split(',')) {
    const denied = await page.evaluate(id => window.switchAttempt(id), id);
    check(denied.status === 403 && denied.code === 'ORGANIZATION_NOT_AVAILABLE', 'Invalid membership accepted');
    const unchanged = await page.evaluate(() => window.switchEvidence());
    check(unchanged.active === organizationId && unchanged.unlocked, 'Rejected switch retired current valid context');
  }
  const otherTab = await page.context().newPage();
  await otherTab.goto(page.url());
  await otherTab.getByRole('combobox', { name: 'Organización activa' }).waitFor();
  const response = page.waitForResponse(r => r.url().includes(`/organizations/${other}/select`));
  await page.getByRole('combobox', { name: 'Organización activa' }).selectOption(other);
  check((await response).status() === 201, 'Backend rejected valid membership');
  await page.waitForFunction(other => document.querySelector('select')?.value === other, other);
  const after = await page.evaluate(() => window.switchEvidence());
  check(after.active === other, 'Organization did not switch');
  check(after.branch !== before.branch && after.rememberedBranch === null, 'Previous branch state remains');
  check(!after.unlocked && after.retired?.includes(userId), 'Previous offline identity still authorized');
  check(await page.evaluate(() => window.readPrior()) === 'ACCESS_RETIRED', 'Prior private state remains readable');
  check(JSON.stringify(after.pending) === '[1,2,3]', 'Switch lost pending sealed envelope');
  await otherTab.getByRole('heading', { name: 'Acceso local cerrado' }).waitFor();
  const retiredTab = await otherTab.evaluate(() => window.switchEvidence());
  check(!retiredTab.unlocked, 'Other tab retained previous identity keys');
  await otherTab.close();
  return { passed: true, before, after };
}
