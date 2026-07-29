// Scenario 02: server/channel management across two clients.
// Alice (owner) creates/renames/deletes channels, switches a channel to the
// Announce surface, renames the server; Bob (member) must see every change
// propagate over P2P. Then Bob leaves (browser confirm) and re-joins with the
// same invite.
import { Scenario, until } from './harness.mjs';
import { register, createServer, copyInvite, joinByInvite, sendMessage, waitForMessage } from './flows.mjs';

const s = await new Scenario('02-channels').start();

/** Channel rail region (aria-label="Channel List") so channel-name assertions
 *  never match message text or the chat header. */
const rail = (c) => c.page.getByRole('complementary', { name: 'Channel List' });
const chanBtn = (c, name) => rail(c).getByRole('button', { name, exact: true });

const present = (loc, what, timeout = 10000) =>
  until(async () => (await loc.count()) > 0, { what: `${what} present`, timeout });
const absent = (loc, what, timeout = 10000) =>
  until(async () => (await loc.count()) === 0, { what: `${what} absent`, timeout });

/** Auto-accept browser confirm() dialogs (leave server / delete channel) and log them. */
function autoAcceptDialogs(c) {
  c.page.on('dialog', (d) => {
    c.logs.push({ t: Date.now(), kind: 'dialog', text: `${d.type()}: ${d.message()}` });
    d.accept().catch(() => {});
  });
}

/** Owner-only inline channel creation via the rail "Add channel" (+) button. */
async function addTextChannel(c, name) {
  await rail(c).getByRole('button', { name: 'Add channel' }).first().click();
  const input = c.page.getByPlaceholder('channel-name');
  await input.waitFor({ timeout: 5000 });
  await input.fill(name);
  await rail(c).getByRole('button', { name: 'Create', exact: true }).click();
  await chanBtn(c, name).waitFor({ timeout: 10000 });
}

try {
  const alice = await s.client('alice');
  const bob = await s.client('bob');
  autoAcceptDialogs(alice);
  autoAcceptDialogs(bob);

  // ── Setup (same shape as scenario-01) ────────────────────────────────────
  await s.step('alice registers', () => register(alice, 'Alice'));
  await s.step('alice creates server "Test Hub"', () => createServer(alice, 'Test Hub'));
  const invite = await s.step('alice copies invite', () => copyInvite(alice));
  console.log(`  invite: ${invite.slice(0, 80)}...`);
  await s.step('bob registers', () => register(bob, 'Bob'));
  await s.step('bob joins via invite', () => joinByInvite(bob, invite, 'Test Hub'));
  await s.step('bob opens #general; alice sees Bob in member list', async () => {
    await bob.page.getByRole('button', { name: 'general' }).click();
    await bob.page.getByText('Welcome to #general').waitFor({ timeout: 20000 });
    await present(alice.page.getByLabel('Send DM to Bob'), 'Bob in alice member list', 20000);
  });

  // ── 1. Add text channel "random"; must propagate to Bob <10s ────────────
  let haveRandom = false;
  try {
    await s.step('alice adds text channel "random"', async () => {
      await addTextChannel(alice, 'random');
    });
    haveRandom = true;
    await s.step('"random" propagates to bob (<10s)', async () => {
      const t0 = Date.now();
      await present(chanBtn(bob, 'random'), 'bob rail #random', 10000);
      console.log(`  channel-create propagation A->B: ${Date.now() - t0}ms`);
    });
    await s.shot(bob, 'bob-sees-random');
  } catch { /* group failure recorded; later groups still run */ }

  // ── 2. Rename "random" -> "random2" via context menu Edit Channel ────────
  let haveRandom2 = false;
  if (haveRandom) {
    try {
      await s.step('alice renames "random" -> "random2" (context menu > Edit Channel)', async () => {
        await chanBtn(alice, 'random').click({ button: 'right' });
        await alice.page.getByRole('menuitem', { name: 'Edit Channel' }).click();
        const modal = alice.page
          .locator('div.fixed')
          .filter({ has: alice.page.getByRole('heading', { name: 'Edit Text Channel' }) })
          .first();
        await modal.waitFor({ timeout: 5000 });
        const nameInput = modal.locator('input[type="text"]').first();
        await nameInput.fill('random2');
        await modal.getByRole('button', { name: 'Save Changes' }).click();
        await present(chanBtn(alice, 'random2'), 'alice rail #random2', 10000);
        await absent(chanBtn(alice, 'random'), 'alice rail old #random', 5000);
      });
      haveRandom2 = true;
      await s.step('bob sees rename "random2" (<10s)', async () => {
        const t0 = Date.now();
        await present(chanBtn(bob, 'random2'), 'bob rail #random2', 10000);
        await absent(chanBtn(bob, 'random'), 'bob rail old #random', 5000);
        console.log(`  channel-rename propagation A->B: ${Date.now() - t0}ms`);
      });
    } catch { /* continue */ }
  } else {
    console.log('SKIP rename group: "random" was never created');
  }

  // ── 3. Announcement-type channel: create "news", switch kind, publish ────
  const annBody = `crew update from alice ${Date.now()}`;
  try {
    await s.step('alice adds channel "news"; bob sees it', async () => {
      await addTextChannel(alice, 'news');
      await present(chanBtn(bob, 'news'), 'bob rail #news', 10000);
    });
    await s.step('alice switches "news" to Announce type', async () => {
      await chanBtn(alice, 'news').click();
      const toAnnounce = alice.page.getByRole('button', { name: 'Set channel type to Announce' });
      await toAnnounce.waitFor({ timeout: 10000 });
      await toAnnounce.click();
      await alice.page.getByRole('button', { name: 'Change type' }).click();
      // Announce surface header shows BROADCAST // CHANNEL
      await alice.page.getByText('BROADCAST // CHANNEL').waitFor({ timeout: 10000 });
    });
    await s.step('alice publishes an announcement', async () => {
      await alice.page.getByRole('button', { name: 'New', exact: true }).click();
      await alice.page.getByPlaceholder('Announcement title').fill('Launch Update');
      await alice.page.getByPlaceholder('Write the announcement body...').fill(annBody);
      await alice.page.getByRole('button', { name: /PUBLISH THROUGH XOREIN/ }).click();
      // Success = compose form closes AND the entry lands in the feed. The
      // role=status banner surfaces publish/load errors — bubble its text so a
      // failure carries the app's own diagnostic.
      await until(async () => {
        // Multiple role=status elements exist (connection pill etc.) — find the
        // announce feedback banner specifically.
        const banners = await alice.page.locator('[role="status"]').allInnerTexts().catch(() => []);
        const err = banners.find((t) => /no local handler|unable|failed|denied|before publishing|runtime/i.test(t));
        if (err) throw new Error(`announce banner: "${err.trim()}"`);
        const composeOpen = await alice.page.getByPlaceholder('Announcement title').count();
        const entry = await alice.page.getByText(annBody).count();
        return composeOpen === 0 && entry > 0;
      }, { what: 'announcement published into feed', timeout: 15000 });
    });
    await s.shot(alice, 'alice-announcement');
    await s.step('bob receives the announcement in #news (<10s)', async () => {
      const t0 = Date.now();
      await chanBtn(bob, 'news').click();
      await waitForMessage(bob, annBody, 10000);
      console.log(`  announcement propagation A->B: ${Date.now() - t0}ms`);
    });
    await s.shot(bob, 'bob-announcement');
  } catch {
    console.log('  NOTE: announce group aborted — remaining announce assertions skipped');
  }

  // ── 4. Server rename via Server Settings gear ────────────────────────────
  let serverName = 'Test Hub';
  try {
    await s.step('alice renames server to "Test Hub 2" in Server Settings', async () => {
      await rail(alice).getByRole('button', { name: 'Server Settings' }).click();
      const nameInput = alice.page.locator('#server-name-input');
      await nameInput.waitFor({ timeout: 10000 });
      await nameInput.fill('Test Hub 2');
      await alice.page.getByRole('button', { name: 'Save changes' }).click();
      await alice.page.keyboard.press('Escape');
      await present(alice.page.getByRole('button', { name: 'Server: Test Hub 2' }), 'alice rail server rename', 10000);
    });
    serverName = 'Test Hub 2';
    await s.step('bob sees new server name "Test Hub 2" (<10s)', async () => {
      const t0 = Date.now();
      await present(bob.page.getByRole('button', { name: 'Server: Test Hub 2' }), 'bob rail server rename', 10000);
      console.log(`  server-rename propagation A->B: ${Date.now() - t0}ms`);
    });
    await s.shot(bob, 'bob-server-renamed');
  } catch { /* continue */ }

  // ── 5. Delete "random2"; must disappear for Bob ──────────────────────────
  if (haveRandom2 || haveRandom) {
    const victim = haveRandom2 ? 'random2' : 'random';
    try {
      await s.step(`alice deletes "${victim}" (context menu > Delete Channel)`, async () => {
        await chanBtn(alice, victim).click({ button: 'right' });
        await alice.page.getByRole('menuitem', { name: 'Delete Channel' }).click();
        // browser confirm auto-accepted by dialog handler
        await absent(chanBtn(alice, victim), `alice rail #${victim}`, 10000);
      });
      await s.step(`"${victim}" disappears for bob (<10s)`, async () => {
        const t0 = Date.now();
        await absent(chanBtn(bob, victim), `bob rail #${victim}`, 10000);
        console.log(`  channel-delete propagation A->B: ${Date.now() - t0}ms`);
      });
    } catch { /* continue */ }
  } else {
    console.log('SKIP delete group: no channel to delete');
  }

  // ── 6. Bob leaves the server (browser confirm) ───────────────────────────
  let bobLeft = false;
  try {
    await s.step('bob leaves the server (Server menu > Leave Server + confirm)', async () => {
      await rail(bob).getByRole('button', { name: 'Server menu' }).click();
      await bob.page.getByRole('menuitem', { name: 'Leave Server' }).click();
      await absent(bob.page.getByRole('button', { name: `Server: ${serverName}` }), 'bob server rail entry', 15000);
    });
    bobLeft = true;
    await s.shot(bob, 'bob-after-leave');
    await s.step('alice member list drops Bob', async () => {
      const t0 = Date.now();
      await absent(alice.page.getByLabel('Send DM to Bob'), 'Bob in alice member list', 20000);
      console.log(`  leave propagation B->A: ${Date.now() - t0}ms`);
    });
    await s.shot(alice, 'alice-after-bob-left');
  } catch { /* continue */ }

  // ── 7. Bob re-joins with the same invite ─────────────────────────────────
  if (bobLeft) {
    await s.step('bob re-joins with the same invite', () => joinByInvite(bob, invite, serverName));
    await s.step('server works again after re-join (message + member list)', async () => {
      await bob.page.getByRole('button', { name: 'general' }).click();
      await chanBtn(alice, 'general').click();
      const probe = `welcome back bob ${Date.now()}`;
      await sendMessage(alice, probe);
      await waitForMessage(bob, probe, 30000);
      await present(alice.page.getByLabel('Send DM to Bob'), 'Bob back in alice member list', 20000);
    });
    await s.shot(bob, 'bob-rejoined');
  } else {
    console.log('SKIP re-join group: bob never left');
  }

  await s.shot(alice, 'alice-final');
  await s.shot(bob, 'bob-final');
} finally {
  await s.finish();
}
