// Scenario 00: first-run boot — one client loads the app against the local
// stack. Captures the initial UX (aria tree + screenshot) and console errors
// so later scenarios can use real selectors.
import { Scenario, until } from './harness.mjs';

const s = await new Scenario('00-boot').start();
try {
  const alice = await s.client('alice');

  await s.step('app boots to first-run UI', async () => {
    await until(async () => (await alice.page.locator('#root').innerText()).length > 50,
      { what: 'app render', timeout: 20000 });
  });

  await s.step('capture initial aria + screenshot', async () => {
    const snap = await s.aria(alice, 'first-run');
    await s.shot(alice, 'first-run');
    console.log('---- ARIA (first 120 lines) ----');
    console.log(snap.split('\n').slice(0, 120).join('\n'));
  });

  await s.step('report console errors', async () => {
    const errs = alice.logs.filter(l => l.kind === 'pageerror' || l.kind === 'error');
    console.log(`console errors so far: ${errs.length}`);
    for (const e of errs.slice(0, 10)) console.log(`  [${e.kind}] ${e.text.slice(0, 300)}`);
  });
} finally {
  await s.finish();
}
