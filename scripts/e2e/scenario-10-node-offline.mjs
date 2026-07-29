// Scenario 10: support-node offline resilience.
//
// The support node (shim on :7711) is bootstrap + blob storage ONLY — the P2P
// data path must not depend on it. This scenario OWNS the shim process:
//   1. with the shim up: two clients register, share a server, befriend, DM;
//   2. the shim is SIGKILLed: channel messages, DMs, and reactions must keep
//      flowing peer-to-peer; the first node-bound action (an upload attempt)
//      must fail fast, flip the client's node-health to offline, raise the
//      global "Node offline" banner, and disable the attach button with the
//      canonical message;
//   3. a THIRD client registers and joins the server BY INVITE while the node
//      is down (onboarding needs only the relay + peers);
//   4. the shim restarts: the recovery prober clears the banner and uploads
//      work again.
//
// PRIVACY NOTE: node-health detection is passive (no polling while healthy —
// scenario-06 asserts zero node requests during a chat session), so the banner
// legitimately appears only after a node-bound request fails. The steps below
// assert that contract, not instant global awareness.
//
// Prereqs: relay (:9999) + vite (:8080) running as usual. The ambient shim
// must NOT be running — this scenario spawns its own on :7711.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { Scenario, until } from './harness.mjs';
import { register, createServer, copyInvite, joinByInvite, sendMessage, waitForMessage } from './flows.mjs';
import { assertPortFree, startShim, stopShim } from './support-shim.mjs';

const NODE_OFFLINE_MESSAGE = 'No node currently available. This feature only works with at least one node online.';
const BANNER = '[data-testid="node-offline-banner"]';

const rnd = Math.random().toString(36).slice(2, 7);
const SERVER = `Offline Proving Ground ${rnd}`;
const SHIM_DATA = path.join(os.tmpdir(), `harmolyn-e2e-10-shim-${Date.now()}`);
fs.mkdirSync(SHIM_DATA, { recursive: true });

const s = await new Scenario('10-node-offline').start();
let shim = null;

const bodyText = async (c) => c.page.locator('body').innerText();

/** Hover a message (by its text) and click one of its hover-bar actions. */
async function msgAction(c, text, label) {
  const row = c.page.getByText(text, { exact: false }).first();
  for (let attempt = 0; attempt < 3; attempt++) {
    await row.scrollIntoViewIfNeeded().catch(() => {});
    await row.hover();
    const btn = c.page.getByRole('button', { name: label, exact: true }).first();
    try {
      await btn.waitFor({ timeout: 2500 });
      await c.page.waitForTimeout(200);
      await btn.click();
      return;
    } catch {
      await c.page.getByRole('textbox', { name: 'Message Input' }).hover().catch(() => {});
      await c.page.waitForTimeout(250);
    }
  }
  throw new Error(`hover action "${label}" not reachable on message "${text}" for ${c.name}`);
}

async function openFriendsPanel(c) {
  const { page } = c;
  const marker = page.getByRole('button', { name: /^(ADD FRIEND|CLOSE)$/ });
  if (await marker.count()) return;
  // The Friends entry lives on the HOME view; clients sitting in a server
  // (e.g. right after createServer/join) must navigate home first.
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  const rail = page.getByRole('button', { name: 'Friends', exact: true });
  if (await rail.count()) await rail.first().click();
  else await page.getByRole('button', { name: /Add a friend/ }).first().click();
  await marker.first().waitFor({ timeout: 10000 });
}

function friendRow(c, peerText) {
  return c.page.locator('div.p-3.rounded-r2').filter({ hasText: peerText });
}

async function openDmFromFriends(c, peerId) {
  const { page } = c;
  await openFriendsPanel(c);
  await page.getByRole('button', { name: /^ALL/ }).first().click();
  const msgBtn = friendRow(c, peerId).getByRole('button', { name: 'Message', exact: true }).first();
  await msgBtn.waitFor({ timeout: 15000 });
  await msgBtn.click();
  await page.getByRole('textbox', { name: 'Message Input' }).waitFor({ timeout: 10000 });
}

async function goToServerChannel(c) {
  const { page } = c;
  await page.getByRole('button', { name: `Server: ${SERVER}` }).click();
  await page.getByRole('button', { name: 'general' }).first().click();
  await page.getByRole('textbox', { name: 'Message Input' }).waitFor({ timeout: 10000 });
}

async function uploadTextFile(c, name, text) {
  const chooser = c.page.waitForEvent('filechooser');
  await c.page.getByRole('button', { name: 'Add attachment' }).click();
  const fc = await chooser;
  const tmp = path.join(SHIM_DATA, name);
  fs.writeFileSync(tmp, text);
  await fc.setFiles(tmp);
}

try {
  await s.step('preflight: port free, spawn scenario-owned shim', async () => {
    await assertPortFree();
    shim = await startShim({ dataDir: SHIM_DATA, log: m => console.log(`  ${m}`) });
  });

  const alice = await s.client('alice');
  const bob = await s.client('bob');

  const alicePeer = await s.step('alice registers', () => register(alice, 'Alice'));
  const bobPeer = await s.step('bob registers', () => register(bob, 'Bob'));
  console.log(`  alice=${alicePeer.slice(-8)} bob=${bobPeer.slice(-8)}`);

  await s.step('alice creates server; bob joins by invite', async () => {
    await createServer(alice, SERVER);
    const invite = await copyInvite(alice);
    await joinByInvite(bob, invite, SERVER);
  });

  await s.step('online sanity: channel messages both ways', async () => {
    await sendMessage(alice, `warm-a-${rnd}`);
    await waitForMessage(bob, `warm-a-${rnd}`, 15000);
    await sendMessage(bob, `warm-b-${rnd}`);
    await waitForMessage(alice, `warm-b-${rnd}`, 15000);
  });

  await s.step('friendship + Seal DM established (they "know each other")', async () => {
    await openFriendsPanel(alice);
    await alice.page.getByRole('button', { name: 'ADD FRIEND', exact: true }).click();
    await alice.page.getByRole('textbox', { name: 'Peer ID or multiaddr' }).fill(bobPeer);
    await alice.page.getByRole('button', { name: /SEND REQUEST|Sending/ }).click();
    await until(async () => (await bodyText(alice)).includes('Friend request sent.'),
      { what: 'friend request sent', timeout: 15000 });
    await openFriendsPanel(bob);
    await bob.page.getByRole('button', { name: /^PENDING/ }).first().click();
    const accept = bob.page.getByRole('button', { name: 'Accept', exact: true }).first();
    await accept.waitFor({ timeout: 10000 });
    await accept.click();
    await openDmFromFriends(alice, bobPeer);
    await openDmFromFriends(bob, alicePeer);
    await sendMessage(alice, `dm-warm-${rnd}`);
    await waitForMessage(bob, `dm-warm-${rnd}`, 15000);
  });

  // ───────────────────────── node goes down ─────────────────────────

  await s.step('KILL the support node', () => stopShim(shim));

  await s.step('DM keeps flowing peer-to-peer with the node dead', async () => {
    await sendMessage(bob, `dm-dark-${rnd}`);
    await waitForMessage(alice, `dm-dark-${rnd}`, 15000);
    await sendMessage(alice, `dm-dark-reply-${rnd}`);
    await waitForMessage(bob, `dm-dark-reply-${rnd}`, 15000);
  });

  await s.step('channel messages keep flowing peer-to-peer with the node dead', async () => {
    await goToServerChannel(alice);
    await goToServerChannel(bob);
    await sendMessage(alice, `dark-a-${rnd}`);
    await waitForMessage(bob, `dark-a-${rnd}`, 15000);
    await sendMessage(bob, `dark-b-${rnd}`);
    await waitForMessage(alice, `dark-b-${rnd}`, 15000);
  });

  await s.step('reactions propagate with the node dead', async () => {
    await msgAction(bob, `dark-a-${rnd}`, 'Add Reaction');
    await bob.page.getByRole('button', { name: '👍', exact: true }).first().click();
    await until(async () => (await bodyText(alice)).includes('👍'),
      { what: 'reaction visible on alice', timeout: 15000 });
  });

  await s.step('first node-bound action fails fast and flips node-health to offline', async () => {
    // Health detection is passive: this UPLOAD ATTEMPT is the discovery event.
    await uploadTextFile(alice, `probe-${rnd}.txt`, 'discovery probe');
    // Try to send it — the upload fails (connection refused) and the client
    // must now know the node is gone.
    await alice.page.getByRole('textbox', { name: 'Message Input' }).press('Enter').catch(() => {});
    await until(async () => (await alice.page.locator(BANNER).count()) > 0,
      { what: 'node-offline banner on alice', timeout: 20000 });
    await s.shot(alice, 'alice-node-offline-banner');
    const banner = await alice.page.locator(BANNER).innerText();
    if (!/Node offline/i.test(banner)) throw new Error(`banner lacks "Node offline": ${JSON.stringify(banner)}`);
  });

  await s.step('attach button is disabled with the canonical message', async () => {
    const btn = alice.page.getByRole('button', { name: 'Add attachment' });
    await until(async () => {
      const disabled = await btn.getAttribute('disabled');
      const aria = await btn.getAttribute('aria-disabled');
      return disabled !== null || aria === 'true';
    }, { what: 'attach disabled', timeout: 10000 });
    const title = (await btn.getAttribute('title')) ?? '';
    if (title !== NODE_OFFLINE_MESSAGE) {
      throw new Error(`attach tooltip mismatch: ${JSON.stringify(title)}`);
    }
  });

  await s.step('fresh client registers + joins by invite with the node STILL DOWN', async () => {
    const carol = await s.client('carol');
    await register(carol, 'Carol');
    // NOTE: in native mode a client makes ZERO node requests at launch (the
    // zero-trust contract scenario-06 asserts), so carol cannot — and must not —
    // "know" the node is down yet. Onboarding itself is pure P2P.
    const invite = await copyInvite(alice);
    await joinByInvite(carol, invite, SERVER);
    await goToServerChannel(carol);
    await sendMessage(carol, `carol-dark-${rnd}`);
    await waitForMessage(alice, `carol-dark-${rnd}`, 15000);
    await waitForMessage(bob, `carol-dark-${rnd}`, 15000);
    await s.shot(carol, 'carol-joined-node-down');
  });

  await s.step('carol discovers node-death on her FIRST node-bound action', async () => {
    const carol = s.clients.find(c => c.name === 'carol');
    await uploadTextFile(carol, `carol-probe-${rnd}.txt`, 'carol discovery probe');
    await carol.page.getByRole('textbox', { name: 'Message Input' }).press('Enter').catch(() => {});
    await until(async () => (await carol.page.locator(BANNER).count()) > 0,
      { what: 'node-offline banner on carol', timeout: 20000 });
  });

  // ───────────────────────── node comes back ─────────────────────────

  await s.step('RESTART the support node', async () => {
    shim = await startShim({ dataDir: SHIM_DATA, log: m => console.log(`  ${m}`) });
  });

  await s.step('recovery prober clears the banner (≤45s)', async () => {
    await until(async () => (await alice.page.locator(BANNER).count()) === 0,
      { what: 'banner cleared on alice', timeout: 45000, interval: 500 });
  });

  await s.step('uploads work again after recovery', async () => {
    const canary = `recovered-attachment-${rnd}`;
    await until(async () => {
      const btn = alice.page.getByRole('button', { name: 'Add attachment' });
      return (await btn.getAttribute('disabled')) === null && (await btn.getAttribute('aria-disabled')) !== 'true';
    }, { what: 'attach re-enabled', timeout: 10000 });
    await uploadTextFile(alice, `${canary}.txt`, canary);
    await sendMessage(alice, `see attachment ${canary}`);
    await until(async () => {
      const body = await bodyText(bob);
      return body.includes(canary);
    }, { what: 'bob sees recovered attachment message', timeout: 20000 });
  });
} finally {
  await stopShim(shim).catch(() => {});
  await s.finish();
}
