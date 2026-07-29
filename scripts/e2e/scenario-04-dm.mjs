// Scenario 04: friends + Seal DMs between two fresh clients (no server).
// Alice and Bob register; Alice friend-requests Bob by peer id; Bob accepts;
// both open the 1:1 DM (SEAL badge), exchange + edit E2EE messages; probes
// typing indicator + custom-status propagation (reported as findings, not
// hard failures); Bob reloads and must keep DM history and receive fresh
// messages (session persistence + ratchet survival).
//
// Selector notes (discovered via failure screenshots):
//  - Friends tab buttons render "<LABEL><count>" with NO whitespace in the
//    accessible name ("ALL2", "PENDING1"), so tab selectors use /^LABEL/.
//  - The friends list unions accepted friends with presence keys, which
//    includes YOURSELF — Message clicks must be scoped to the row containing
//    the counterparty's peer id, never `.first()`.
import { Scenario, until } from './harness.mjs';
import { register, sendMessage, waitForMessage } from './flows.mjs';

const s = await new Scenario('04-dm').start();

const rnd = Math.random().toString(36).slice(2, 7);
const MSG_A = `dm-alpha-${rnd}`;
const MSG_B = `dm-bravo-${rnd}`;
const MSG_EDIT = `dm-alpha-edited-${rnd}`;
const MSG_FRESH = `dm-fresh-${rnd}`;
const STATUS_TEXT = `status-probe-${rnd}`;

const findings = [];

/** Run a non-critical step: log failure but keep the scenario going. */
async function soft(label, fn) {
  try { return await s.step(label, fn); } catch { return undefined; }
}

/** Open the Friends panel (rail "Friends" button on home, else welcome tile). */
async function openFriendsPanel(c) {
  const { page } = c;
  const marker = page.getByRole('button', { name: /^(ADD FRIEND|CLOSE)$/ });
  if (await marker.count()) return; // already open
  const rail = page.getByRole('button', { name: 'Friends', exact: true });
  if (await rail.count()) {
    await rail.first().click();
  } else {
    await page.getByRole('button', { name: /Add a friend/ }).first().click();
  }
  await marker.first().waitFor({ timeout: 10000 });
}

/** Friend-row locator (FriendsPanel row card) containing `peerText`. */
function friendRow(c, peerText) {
  return c.page.locator('div.p-3.rounded-r2').filter({ hasText: peerText });
}

/** From the Friends panel ALL tab, open the DM with the given peer id. */
async function openDmFromFriends(c, peerId) {
  const { page } = c;
  await openFriendsPanel(c);
  await page.getByRole('button', { name: /^ALL/ }).first().click();
  const msgBtn = friendRow(c, peerId).getByRole('button', { name: 'Message', exact: true }).first();
  await msgBtn.waitFor({ timeout: 15000 });
  await msgBtn.click();
  await page.getByRole('textbox', { name: 'Message Input' }).waitFor({ timeout: 10000 });
}

async function bodyText(c) { return c.page.locator('body').innerText(); }

try {
  const alice = await s.client('alice');
  const bob = await s.client('bob');

  // ---- 1. registration --------------------------------------------------
  const alicePeer = await s.step('alice registers', () => register(alice, 'Alice'));
  console.log(`  alice peer: ${alicePeer}`);
  const bobPeer = await s.step('bob registers', () => register(bob, 'Bob'));
  console.log(`  bob peer: ${bobPeer}`);

  // ---- 2/3. friend request over P2P ------------------------------------
  await s.step('bob opens Friends panel on PENDING tab (before request exists)', async () => {
    await openFriendsPanel(bob);
    await bob.page.getByRole('button', { name: /^PENDING/ }).first().click();
  });

  const tRequestSent = await s.step('alice sends friend request by bob peer id', async () => {
    await openFriendsPanel(alice);
    await alice.page.getByRole('button', { name: 'ADD FRIEND', exact: true }).click();
    await alice.page.getByRole('textbox', { name: 'Peer ID or multiaddr' }).fill(bobPeer);
    const t0 = Date.now();
    await alice.page.getByRole('button', { name: /SEND REQUEST|Sending/ }).click();
    // Success or an explicit error banner — surface whichever appears.
    await until(async () => {
      const text = await bodyText(alice);
      if (text.includes('Friend request sent.')) return true;
      const err = text.match(/Unable to send friend request[^\n]*|Failed to [^\n]*friend[^\n]*/);
      if (err) throw new Error(`add-friend error banner: ${err[0]}`);
      return false;
    }, { what: 'friend request sent feedback', timeout: 15000 });
    return t0;
  });

  await s.step('bob sees incoming friend request (<10s) and accepts', async () => {
    const accept = bob.page.getByRole('button', { name: 'Accept', exact: true }).first();
    await accept.waitFor({ timeout: 10000 });
    console.log(`  friend request A->B visible after ${Date.now() - tRequestSent}ms`);
    await s.shot(bob, 'bob-incoming-request');
    await accept.click();
    await until(async () => (await bodyText(bob)).includes('Friend request accepted.'),
      { what: 'accept feedback', timeout: 10000 });
  });

  // ---- 4. friends lists + DM open --------------------------------------
  await s.step('alice sees bob in her friends list', async () => {
    await alice.page.getByRole('button', { name: /^ALL/ }).first().click();
    await friendRow(alice, bobPeer).first().waitFor({ timeout: 20000 });
    // Papercut probes (non-fatal): raw peer ids instead of display names;
    // your own identity listed as a friend via the presence union.
    const showsName = (await bodyText(alice)).includes('Bob');
    if (!showsName) findings.push('Friends list rows show raw peer ids, never display names');
    if (await friendRow(alice, alicePeer).count()) {
      findings.push('Your OWN identity appears as a row in your friends list (presence union includes self)');
    }
    await s.shot(alice, 'alice-friends-list');
  });

  await soft('alice outgoing request flips to accepted (friends.accept sync-back)', async () => {
    // When the count hits 0 the tab accessible name is exactly "PENDING".
    try {
      await until(async () => (await alice.page.getByRole('button', { name: 'PENDING', exact: true }).count()) > 0,
        { what: 'alice pending drained', timeout: 20000 });
      console.log('  friends.accept sync-back: OK (outgoing pending flipped to accepted)');
    } catch (err) {
      findings.push("DEFECT: requester's outgoing friend request stays PENDING forever after the peer accepts (friends.accept never applied), even though the acceptor's presence arrives");
      await s.shot(alice, 'alice-pending-stuck');
      throw err;
    }
  });

  await s.step('bob opens DM with alice from his friends list', () => openDmFromFriends(bob, alicePeer));
  await s.step('alice opens DM with bob from her friends list', () => openDmFromFriends(alice, bobPeer));

  // ---- 5. DM exchange + SEAL badge -------------------------------------
  await s.step('SEAL E2EE badge visible on both sides', async () => {
    await alice.page.getByText('SEAL // 1:1 E2EE').first().waitFor({ timeout: 10000 });
    await bob.page.getByText('SEAL // 1:1 E2EE').first().waitFor({ timeout: 10000 });
    await s.shot(alice, 'alice-dm-seal');
    await s.shot(bob, 'bob-dm-seal');
  });

  await s.step('alice DM composer is enabled', async () => {
    await until(async () => {
      const box = alice.page.getByRole('textbox', { name: 'Message Input' });
      await box.fill('probe');
      const disabled = await alice.page.getByRole('button', { name: 'Send Message' }).isDisabled();
      await box.fill('');
      return !disabled;
    }, { what: 'alice DM composer enabled', timeout: 15000 });
  });

  await s.step('alice sends DM; bob receives (<5s)', async () => {
    const t0 = Date.now();
    await sendMessage(alice, MSG_A);
    await waitForMessage(alice, MSG_A, 10000);
    await waitForMessage(bob, MSG_A, 20000);
    const latency = Date.now() - t0;
    console.log(`  DM delivery A->B: ${latency}ms`);
    if (latency > 5000) throw new Error(`DM A->B took ${latency}ms (> 5000ms budget)`);
  });

  await s.step('bob replies; alice receives', async () => {
    const t0 = Date.now();
    await sendMessage(bob, MSG_B);
    await waitForMessage(bob, MSG_B, 10000);
    await waitForMessage(alice, MSG_B, 20000);
    console.log(`  DM delivery B->A: ${Date.now() - t0}ms`);
  });

  // ---- 6. E2EE edit -----------------------------------------------------
  await s.step('alice edits her DM message', async () => {
    // Hover the chat-area copy (.last() — the rail DM preview can also match)
    // to reveal the action toolbar, then Edit Message.
    await alice.page.getByText(MSG_A, { exact: false }).last().hover();
    await alice.page.getByRole('button', { name: 'Edit Message', exact: true }).first().click();
    const editBox = alice.page.locator('input:focus');
    await editBox.waitFor({ timeout: 5000 });
    await editBox.fill(MSG_EDIT);
    await editBox.press('Enter');
    await waitForMessage(alice, MSG_EDIT, 10000);
  });

  await s.step('bob sees the edited content (E2EE edit propagation)', async () => {
    const t0 = Date.now();
    await waitForMessage(bob, MSG_EDIT, 15000);
    console.log(`  edit propagation A->B: ${Date.now() - t0}ms`);
    const hasMarker = (await bodyText(bob)).includes('(edited)');
    console.log(`  bob sees "(edited)" marker: ${hasMarker}`);
    if (!hasMarker) findings.push('Edited DM shows no "(edited)" marker on the receiving side');
    await s.shot(bob, 'bob-sees-edit');
  });

  // ---- 7. typing indicator probe (finding, not hard assert) -------------
  await soft('typing indicator probe: alice types, does bob see it?', async () => {
    const box = alice.page.getByRole('textbox', { name: 'Message Input' });
    await box.click();
    await box.pressSequentially('typing probe do not send', { delay: 40 });
    let seen = false;
    try {
      await until(async () => /is typing/.test(await bodyText(bob)),
        { what: 'typing indicator on bob', timeout: 6000, interval: 250 });
      seen = true;
    } catch { /* not seen within 6s */ }
    console.log(`  FINDING typing indicator on bob within 6s: ${seen ? 'YES' : 'NO'}`);
    if (!seen) findings.push('No typing indicator: the composer never publishes typing presence (TypingIndicator UI exists but no producer)');
    await s.shot(bob, 'bob-typing-probe');
    await box.fill('');
  });

  // ---- 8. custom status probe (finding, not hard assert) ----------------
  await soft('alice sets a custom status; does bob see it?', async () => {
    await alice.page.getByRole('button', { name: 'Set Status', exact: true }).click();
    const dialog = alice.page.getByRole('dialog', { name: 'Status picker' });
    await dialog.waitFor({ timeout: 5000 });
    const input = dialog.getByPlaceholder('Set a custom status...');
    await input.fill(STATUS_TEXT);
    await input.press('Enter');
    await alice.page.keyboard.press('Escape');
    // Locally visible in alice's rail footer:
    await alice.page.getByText(STATUS_TEXT).first().waitFor({ timeout: 5000 });
    let onBob = false;
    try {
      await until(async () => (await bodyText(bob)).includes(STATUS_TEXT),
        { what: 'custom status on bob (DM view)', timeout: 8000, interval: 400 });
      onBob = true;
    } catch { /* not visible in DM view */ }
    if (!onBob) {
      // Also look at bob's friends list, where presence would surface.
      await openFriendsPanel(bob);
      await bob.page.getByRole('button', { name: /^ALL/ }).first().click();
      try {
        await until(async () => (await bodyText(bob)).includes(STATUS_TEXT),
          { what: 'custom status in bob friends list', timeout: 5000, interval: 400 });
        onBob = true;
      } catch { /* still not visible */ }
      await s.shot(bob, 'bob-status-probe');
      // Return bob to the DM for the reload leg.
      const msgBtn = friendRow(bob, alicePeer).getByRole('button', { name: 'Message', exact: true }).first();
      await msgBtn.click();
      await bob.page.getByRole('textbox', { name: 'Message Input' }).waitFor({ timeout: 10000 });
    }
    console.log(`  FINDING alice custom status visible to bob: ${onBob ? 'YES' : 'NO'}`);
    if (!onBob) findings.push("Custom status is not reflected anywhere on the peer's side (friends list or DM view)");
  });

  // ---- 9. reload persistence + ratchet survival -------------------------
  await s.step('bob reloads; DM history survives (session + ratchet persistence)', async () => {
    await bob.page.reload({ waitUntil: 'domcontentloaded' });
    // Boot; the registered identity may auto-unlock (persisted session) or
    // present the manual password UnlockScreen.
    await until(async () => (await bob.page.locator('#root').innerText()).length > 50,
      { what: 'bob reboot', timeout: 30000 });
    const pw = bob.page.getByPlaceholder('Your identity password');
    try {
      await pw.waitFor({ timeout: 8000 });
      findings.push('Reload always demands the full identity password again (no persisted unlock session) — Discord-class apps stay signed in');
      await pw.fill('correct horse battery');
      await bob.page.getByRole('button', { name: /Unlock/ }).click();
    } catch { /* auto-unlocked; nothing to do */ }
    // Unlock overlay must be gone before the UI below is interactable.
    await until(async () => (await pw.count()) === 0,
      { what: 'bob unlock overlay gone', timeout: 30000 });
    await s.shot(bob, 'bob-post-unlock');
    // The registered identity must be BACK (footer shows "Bob", no guest
    // banner) — if the app is in read-only Guest mode after a successful
    // unlock, session persistence is broken.
    try {
      await until(async () => {
        const text = await bodyText(bob);
        return text.includes('Bob') && !text.includes('browsing as a guest');
      }, { what: 'bob identity restored after unlock (not Guest)', timeout: 30000 });
    } catch (err) {
      findings.push('DEFECT: after reload + correct password unlock, the app stays in read-only GUEST mode (engine restarts with the registered peer id, but display name, friends, DMs and message history are never rehydrated)');
      await s.aria(bob, 'bob-stuck-guest');
      await s.shot(bob, 'bob-stuck-guest');
      throw err;
    }
    // Get back to the DM (app may or may not restore the last-open scope).
    const composer = bob.page.getByRole('textbox', { name: 'Message Input' });
    const where = await until(async () => {
      if (await composer.count()) return 'dm';
      if (await bob.page.getByRole('button', { name: 'Friends', exact: true }).count()) return 'home';
      return null;
    }, { what: 'bob post-reload UI', timeout: 30000 });
    if (where !== 'dm') await openDmFromFriends(bob, alicePeer);
    await waitForMessage(bob, MSG_EDIT, 20000);
    await waitForMessage(bob, MSG_B, 10000);
    await s.shot(bob, 'bob-after-reload');
  });

  await s.step('alice sends post-reload DM; bob receives (ratchet survived)', async () => {
    const t0 = Date.now();
    await sendMessage(alice, MSG_FRESH);
    await waitForMessage(bob, MSG_FRESH, 20000);
    console.log(`  post-reload DM delivery A->B: ${Date.now() - t0}ms`);
  });

  await s.shot(alice, 'alice-final');
  await s.shot(bob, 'bob-final');
} finally {
  if (findings.length) {
    console.log('\nFINDINGS (non-fatal):');
    for (const f of findings) console.log(`  - ${f}`);
  }
  await s.finish();
}
