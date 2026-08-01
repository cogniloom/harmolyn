// Interactive-ish UI explorer: performs the action list, dumping aria after each.
// Edit ACTIONS and re-run to walk deeper into a flow.
import { Scenario, until } from './harness.mjs';

const s = await new Scenario('explore').start();
const c = await s.client('probe');
const page = c.page;

async function dump(tag) {
  const snap = await s.aria(c, tag);
  await s.shot(c, tag);
  console.log(`\n===== ${tag} =====`);
  console.log(snap.split('\n').slice(0, 160).join('\n'));
}

try {
  await until(async () => (await page.locator('#root').innerText()).length > 50, { what: 'boot' });

  // ---- ACTIONS ----
  await page.getByRole('button', { name: 'Create an account' }).click();
  await page.waitForTimeout(400);
  await page.getByPlaceholder('e.g. Sam').fill('Alice');
  await page.getByPlaceholder('At least 10 characters').fill('correct horse battery');
  await page.getByPlaceholder('Re-enter your password').fill('correct horse battery');
  await page.getByRole('checkbox', { name: /Confirm age/ }).check();
  await page.getByRole('button', { name: 'Create account', exact: true }).first().click();
  await page.waitForTimeout(2500);
  await page.getByRole('button', { name: 'Continue without a backup' }).click();
  await page.getByRole('button', { name: 'Continue anyway' }).click();
  await page.getByRole('button', { name: 'SKIP' }).click();
  await page.waitForTimeout(300);
  await page.getByRole('button', { name: /^Create a Space/ }).click();
  await page.waitForTimeout(400);
  await page.getByRole('textbox', { name: 'Space Name' }).fill('Test Hub');
  await page.getByRole('button', { name: 'Create Space' }).click();
  await page.waitForTimeout(2000);
  await dump('after-server-created');
} catch (err) {
  console.log('EXPLORE FAILED:', String(err).split('\n')[0]);
  await dump('failure').catch(() => {});
} finally {
  const errs = c.logs.filter(l => l.kind === 'pageerror' || l.kind === 'error');
  for (const e of errs.slice(0, 8)) console.log(`  [${e.kind}] ${e.text.slice(0, 200)}`);
  await s.finish();
}
