// Scenario 12: the live peer graph replaces dedicated infrastructure.
//
// Topology before infrastructure loss:
//
//   Alice <──── direct WebRTC ────> Bob <──── direct WebRTC ────> Carol
//
// Alice and Carol deliberately share no server/contact before the relay dies.
// After the node is stopped, Bob must act as an opaque router for:
//   - Alice -> Carol friend request and Carol -> Alice acceptance;
//   - Seal prekey lookup and end-to-end encrypted DM traffic;
//   - Carol joining Alice's new server and restoring its pre-join history.
//
// Bob is not a member of that final server and cannot read routed payloads.
// Restarting the same node must be discovered automatically and reconnect all
// clients without reloading them.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Scenario, until } from './harness.mjs';
import {
  register,
  createServer,
  copyInvite,
  joinByInvite,
  sendMessage,
  waitForMessage,
} from './flows.mjs';

const HTTP_PORT = 17711;
const WS_PORT = 19999;
const TCP_PORT = 19400;
const NODE_ENDPOINT = `http://127.0.0.1:${HTTP_PORT}`;
const XOREIN_BIN = process.env.XOREIN_BIN
  ?? path.resolve(process.cwd(), '../xorein/bin/aether');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'harmolyn-peer-router-'));
const rnd = Math.random().toString(36).slice(2, 7);
const AB_SERVER = `Alice Bob Link ${rnd}`;
const BC_SERVER = `Bob Carol Link ${rnd}`;
const BD_SERVER = `Bob Dave Mailbox ${rnd}`;
const ROUTED_SERVER = `Routed Join ${rnd}`;
const ACCOUNT_PASSWORD = 'correct horse battery';

process.env.XOREIN_NODE_ENDPOINT = NODE_ENDPOINT;

function portOpen(port, timeoutMs = 500) {
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = open => {
      socket.destroy();
      resolve(open);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(timeoutMs, () => done(false));
  });
}

async function startNode(log = () => {}) {
  const child = spawn(XOREIN_BIN, [
    '--role', 'relay',
    '--data-dir', DATA_DIR,
    '--listen', `127.0.0.1:${TCP_PORT}`,
    '--ws-listen', `127.0.0.1:${WS_PORT}`,
    '--browser-listen', `127.0.0.1:${HTTP_PORT}`,
    '--enable-mdns=false',
    '--enable-nat=false',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', data => log(`[node] ${data}`.trimEnd()));
  child.stderr.on('data', data => log(`[node!] ${data}`.trimEnd()));
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await portOpen(HTTP_PORT, 250) && await portOpen(WS_PORT, 250)) return child;
    if (child.exitCode !== null) {
      throw new Error(`xorein exited early with code ${child.exitCode}`);
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  child.kill('SIGTERM');
  throw new Error('xorein browser gateway/relay did not start within 15 seconds');
}

async function stopNode(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (!(await portOpen(HTTP_PORT, 200)) && !(await portOpen(WS_PORT, 200))) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  child.kill('SIGKILL');
  throw new Error('scenario-owned xorein node did not stop');
}

async function controlState() {
  const token = fs.readFileSync(path.join(DATA_DIR, 'control.token'), 'utf8').trim();
  const socketPath = path.join(DATA_DIR, 'xorein-control.sock');
  return new Promise((resolve, reject) => {
    const request = http.request({
      socketPath,
      path: '/v1/state?nerd=true',
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Host: 'localhost' },
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        if (response.statusCode !== 200) {
          reject(new Error(`xorein control state returned ${response.statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (error) {
          reject(error);
        }
      });
    });
    request.once('error', reject);
    request.end();
  });
}

function relayQueueDepth(state) {
  return Object.values(state?.relay_queue ?? {}).reduce(
    (total, value) => total + (Number.isSafeInteger(value) ? value : 0),
    0,
  );
}

async function openFriendsPanel(client) {
  const { page } = client;
  const marker = page.getByRole('button', { name: /^(ADD FRIEND|CLOSE)$/ });
  if (await marker.count()) return;
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  const rail = page.getByRole('button', { name: 'Friends', exact: true });
  const addShortcut = page.getByRole('button', { name: /Add a friend/ });
  // Home navigation is a React transition. Do not sample count in the same
  // event-loop turn and then wait forever on whichever control happened not to
  // exist yet.
  await until(async () => (
    await rail.first().isVisible().catch(() => false)
    || await addShortcut.first().isVisible().catch(() => false)
  ), {
    what: 'Friends navigation appears after Home transition',
    timeout: 15_000,
    interval: 100,
  });
  if (await rail.first().isVisible().catch(() => false)) await rail.first().click();
  else await addShortcut.first().click();
  await marker.first().waitFor({ timeout: 10_000 });
}

function friendRow(client, peerID) {
  return client.page.locator('div.p-3.rounded-r2').filter({ hasText: peerID });
}

async function requestFriend(from, targetPeerID) {
  await openFriendsPanel(from);
  await from.page.getByRole('button', { name: 'ADD FRIEND', exact: true }).click();
  await from.page.getByRole('textbox', { name: 'Peer ID or multiaddr' }).fill(targetPeerID);
  await from.page.getByRole('button', { name: /SEND REQUEST|Sending/ }).click();
}

async function acceptFriend(client, requesterPeerID) {
  await openFriendsPanel(client);
  await client.page.getByRole('button', { name: /^PENDING/ }).first().click({ force: true });
  const row = friendRow(client, requesterPeerID);
  await row.getByRole('button', { name: 'Accept', exact: true }).waitFor({ timeout: 50_000 });
  await row.getByRole('button', { name: 'Accept', exact: true }).click({ force: true });
}

async function peerInboxDepth(client) {
  return client.page.evaluate(async () => {
    if (typeof indexedDB.databases === 'function') {
      const databases = await indexedDB.databases();
      if (!databases.some(database => database.name === 'harmolyn-peer-mailbox-v1')) return 0;
    }
    return new Promise(resolve => {
      const request = indexedDB.open('harmolyn-peer-mailbox-v1', 1);
      request.onerror = () => resolve(0);
      request.onupgradeneeded = () => resolve(0);
      request.onsuccess = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('entries')) {
          db.close();
          resolve(0);
          return;
        }
        const tx = db.transaction('entries', 'readonly');
        const count = tx.objectStore('entries').count();
        count.onerror = () => resolve(0);
        count.onsuccess = () => resolve(count.result);
        tx.oncomplete = () => db.close();
      };
    });
  });
}

async function openDM(client, peerID) {
  await openFriendsPanel(client);
  await client.page.getByRole('button', { name: /^ALL/ }).first().click({ force: true });
  const row = friendRow(client, peerID);
  await row.getByRole('button', { name: 'Message', exact: true }).waitFor({ timeout: 20_000 });
  await row.getByRole('button', { name: 'Message', exact: true }).click({ force: true });
  await client.page.getByRole('textbox', { name: 'Message Input' }).waitFor({ timeout: 10_000 });
}

async function openServer(client, name) {
  await client.page.getByRole('button', { name: `Space: ${name}` }).click();
  await client.page.getByRole('button', { name: 'general' }).first().click();
  await client.page.getByRole('textbox', { name: 'Message Input' }).waitFor({ timeout: 10_000 });
}

async function uploadTextFile(client, name, text) {
  const file = path.join(DATA_DIR, name);
  fs.writeFileSync(file, text);
  const chooser = client.page.waitForEvent('filechooser');
  await client.page.getByRole('button', { name: 'Add attachment' }).click();
  await (await chooser).setFiles(file);
}

async function downloadAndVerifyTextAttachment(client, name, expected) {
  const encrypted = client.page.getByRole('button', { name: new RegExp(name) }).first();
  await encrypted.waitFor({ timeout: 30_000 });
  await encrypted.click();
  const link = client.page.getByRole('link', { name: new RegExp(name) }).first();
  await link.waitFor({ timeout: 30_000 });
  const downloadPromise = client.page.waitForEvent('download');
  await link.click();
  const download = await downloadPromise;
  const downloadedPath = await download.path();
  if (!downloadedPath) throw new Error(`browser did not expose downloaded ${name}`);
  const actual = fs.readFileSync(downloadedPath, 'utf8');
  if (actual !== expected) {
    throw new Error(`attachment bytes mismatch: got ${JSON.stringify(actual)}`);
  }
}

async function reopenRegisteredClient(client) {
  const page = await client.context.newPage();
  page.on('console', msg => client.logs.push({ t: Date.now(), kind: msg.type(), text: msg.text() }));
  page.on('pageerror', err => client.logs.push({ t: Date.now(), kind: 'pageerror', text: String(err) }));
  client.page = page;
  await page.goto(process.env.HARMOLYN_URL ?? 'http://127.0.0.1:8080/', { waitUntil: 'domcontentloaded' });
  const password = page.getByPlaceholder('Your identity password');
  await password.waitFor({ timeout: 20_000 });
  await password.fill(ACCOUNT_PASSWORD);
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  await page.locator('[aria-label^="Network status:"]').first().waitFor({ timeout: 30_000 });
}

const scenario = await new Scenario('12-peer-router').start();
let node = null;

try {
  await scenario.step('preflight: own ports are free and turnkey node starts', async () => {
    if (await portOpen(HTTP_PORT) || await portOpen(WS_PORT) || await portOpen(TCP_PORT)) {
      throw new Error(`ports ${HTTP_PORT}/${WS_PORT}/${TCP_PORT} must be free`);
    }
    if (!fs.existsSync(XOREIN_BIN)) {
      throw new Error(`xorein binary not found: ${XOREIN_BIN}`);
    }
    node = await startNode(message => console.log(`  ${message}`));
  });

  const alice = await scenario.client('alice');
  const bob = await scenario.client('bob');
  const carol = await scenario.client('carol');
  const dave = await scenario.client('dave');

  const alicePeer = await scenario.step('four independent accounts register', async () => {
    const [a, b, c, d] = await Promise.all([
      register(alice, 'Alice'),
      register(bob, 'Bob'),
      register(carol, 'Carol'),
      register(dave, 'Dave'),
    ]);
    alice.peerID = a;
    bob.peerID = b;
    carol.peerID = c;
    dave.peerID = d;
    return a;
  });

  await scenario.step('Alice and Bob establish the first direct edge', async () => {
    await createServer(alice, AB_SERVER);
    const invite = await copyInvite(alice);
    await joinByInvite(bob, invite, AB_SERVER);
    await sendMessage(alice, `ab-a-${rnd}`);
    await waitForMessage(bob, `ab-a-${rnd}`);
    await sendMessage(bob, `ab-b-${rnd}`);
    await waitForMessage(alice, `ab-b-${rnd}`);
  });

  await scenario.step('Bob and Carol establish the second direct edge', async () => {
    await createServer(bob, BC_SERVER);
    const invite = await copyInvite(bob);
    await joinByInvite(carol, invite, BC_SERVER);
    await sendMessage(bob, `bc-b-${rnd}`);
    await waitForMessage(carol, `bc-b-${rnd}`);
    await sendMessage(carol, `bc-c-${rnd}`);
    await waitForMessage(bob, `bc-c-${rnd}`);
    await bob.page.waitForTimeout(5_000);
  });

  await scenario.step('turnkey node stores a recipient-inbox DM and drains after both parties disconnected', async () => {
    const offlineMessage = `inbox-bd-${rnd}`;
    await createServer(bob, BD_SERVER);
    const invite = await copyInvite(bob);
    await joinByInvite(dave, invite, BD_SERVER);
    await requestFriend(bob, dave.peerID);
    await acceptFriend(dave, bob.peerID);
    await openDM(bob, dave.peerID);
    await openDM(dave, bob.peerID);
    await sendMessage(bob, `inbox-warm-${rnd}`);
    await waitForMessage(dave, `inbox-warm-${rnd}`);

    await dave.page.close();
    await bob.page.waitForTimeout(1_000);
    const queueDepthBeforeOfflineSend = relayQueueDepth(await controlState());
    await openDM(bob, dave.peerID);
    await sendMessage(bob, offlineMessage);
    await until(async () =>
      relayQueueDepth(await controlState()) > queueDepthBeforeOfflineSend, {
      what: 'sealed delivery stored in the recipient inbox',
      timeout: 35_000,
      interval: 250,
    });
    // Prove this is durable storage, not a sender-side retry that only works
    // while Bob remains online.
    await bob.page.close();

    await reopenRegisteredClient(dave);
    await openDM(dave, bob.peerID);
    await waitForMessage(dave, offlineMessage, 30_000);
    await until(async () =>
      relayQueueDepth(await controlState()) <= queueDepthBeforeOfflineSend, {
      what: 'offline recipient-inbox delivery acknowledged after unlock',
      timeout: 20_000,
      interval: 250,
    });
    await reopenRegisteredClient(bob);
    await openDM(bob, dave.peerID);
    await sendMessage(dave, `inbox-drained-${rnd}`);
    await waitForMessage(bob, `inbox-drained-${rnd}`, 20_000);
    // Bob was deliberately restarted to prove sender-independent storage.
    // Re-warm both direct graph edges before removing their relay, exactly as a
    // real client does while the node is still available.
    await openServer(bob, AB_SERVER);
    await sendMessage(bob, `ab-rewarm-${rnd}`);
    await waitForMessage(alice, `ab-rewarm-${rnd}`, 20_000);
    await openServer(bob, BC_SERVER);
    await sendMessage(bob, `bc-rewarm-${rnd}`);
    await waitForMessage(carol, `bc-rewarm-${rnd}`, 20_000);
    await bob.page.waitForTimeout(5_000);
    await scenario.shot(dave, 'recipient-inbox-drained-from-turnkey-node');
  });

  await scenario.step('stop the only node: relay, storage, and gateway are all gone', async () => {
    await stopNode(node);
    node = null;
  });

  await scenario.step('both existing graph edges still carry channel traffic', async () => {
    await openServer(alice, AB_SERVER);
    await openServer(bob, AB_SERVER);
    await sendMessage(alice, `ab-dark-${rnd}`);
    await waitForMessage(bob, `ab-dark-${rnd}`, 20_000);
    await openServer(bob, BC_SERVER);
    await openServer(carol, BC_SERVER);
    await sendMessage(carol, `bc-dark-${rnd}`);
    await waitForMessage(bob, `bc-dark-${rnd}`, 20_000);
  });

  await scenario.step('encrypted attachment reconstructs from an ordinary peer with zero nodes', async () => {
    const name = `node-free-${rnd}.txt`;
    const content = `peer-owned encrypted bytes ${rnd}`;
    await openServer(alice, AB_SERVER);
    await openServer(bob, AB_SERVER);
    await uploadTextFile(alice, name, content);
    await waitForMessage(bob, name, 30_000);
    await downloadAndVerifyTextAttachment(bob, name, content);
    await scenario.shot(bob, 'attachment-restored-from-peer-with-zero-nodes');
  });

  await scenario.step('ordinary peer stores and forwards a first-contact request with no node', async () => {
    const carolCDP = await carol.context.newCDPSession(carol.page);
    const aliceCDP = await alice.context.newCDPSession(alice.page);
    const initialBobInboxDepth = await peerInboxDepth(bob);
    // Freeze Carol's page lifecycle without closing her authenticated browser
    // context or destroying the established peer edge. Alice's live route must
    // time out and fall back to Bob's durable peer inbox.
    await carolCDP.send('Page.setWebLifecycleState', { state: 'frozen' });
    await requestFriend(alice, carol.peerID);
    await until(async () => (await alice.page.locator('body').innerText()).includes('Friend request sent.'), {
      what: 'sender confirms durable friend request placement',
      timeout: 50_000,
      interval: 100,
    });
    await until(async () => (await peerInboxDepth(bob)) > initialBobInboxDepth, {
      what: 'Bob stores Carol recipient-inbox packet',
      timeout: 30_000,
      interval: 100,
    });

    // Freeze Alice too: Carol must recover from Bob's stored packet, not from a
    // late sender retry when her JS resumes.
    await aliceCDP.send('Page.setWebLifecycleState', { state: 'frozen' });
    await carolCDP.send('Page.setWebLifecycleState', { state: 'active' });
    // CDP lifecycle activation does not itself emit the platform's online
    // event. Emit the same wake signal a real runtime receives.
    await carol.page.evaluate(() => window.dispatchEvent(new Event('online')));
    await acceptFriend(carol, alicePeer);
    await until(async () => (await peerInboxDepth(bob)) > 0, {
      what: 'Bob stores Alice recipient-inbox acceptance',
      timeout: 30_000,
      interval: 100,
    });
    await aliceCDP.send('Page.setWebLifecycleState', { state: 'active' });
    await alice.page.evaluate(() => window.dispatchEvent(new Event('online')));
    await openFriendsPanel(alice);
    await alice.page.getByRole('button', { name: /^ALL/ }).first().click();
    await friendRow(alice, carol.peerID).waitFor({ state: 'visible', timeout: 50_000 });
    await scenario.shot(bob, 'ordinary-peer-held-bidirectional-recipient-inbox');
  });

  await scenario.step('Seal DM crosses the same peer-router path both ways', async () => {
    await openDM(alice, carol.peerID);
    await openDM(carol, alicePeer);
    await sendMessage(alice, `routed-dm-a-${rnd}`);
    await waitForMessage(carol, `routed-dm-a-${rnd}`, 20_000);
    await sendMessage(carol, `routed-dm-c-${rnd}`);
    await waitForMessage(alice, `routed-dm-c-${rnd}`, 20_000);
  });

  await scenario.step('Carol joins Alice server through Bob and restores history', async () => {
    await createServer(alice, ROUTED_SERVER);
    const historyOne = `before-join-one-${rnd}`;
    const historyTwo = `before-join-two-${rnd}`;
    await sendMessage(alice, historyOne);
    await sendMessage(alice, historyTwo);
    const invite = await copyInvite(alice);
    await joinByInvite(carol, invite, ROUTED_SERVER);
    await waitForMessage(carol, historyOne, 20_000);
    await waitForMessage(carol, historyTwo, 20_000);
    await sendMessage(carol, `joined-without-node-${rnd}`);
    await waitForMessage(alice, `joined-without-node-${rnd}`, 20_000);
    await scenario.shot(carol, 'joined-and-restored-through-peer-router');
  });

  await scenario.step('restart node and reconnect automatically without reload', async () => {
    node = await startNode(message => console.log(`  ${message}`));
    await until(async () => {
      const labels = await Promise.all([alice, bob, carol].map(async client => {
        const status = client.page.locator('[aria-label^="Network status:"]').first();
        return (await status.count()) ? ((await status.innerText()).toLowerCase()) : '';
      }));
      return labels.every(label => label.includes('connected'));
    }, { what: 'all clients reconnect after node restart', timeout: 90_000, interval: 500 });
  });
} finally {
  await stopNode(node).catch(() => {});
  await scenario.finish();
}
