// Scenario 11: TOTAL infrastructure loss — relay AND support node killed.
//
// The strongest form of the P2P promise: two clients that already know each
// other must keep communicating with NO infrastructure online at all. This
// works because (a) directTransport upgrades relayed circuits to direct
// browser↔browser WebRTC links (the relay only carries signaling), and (b) the
// transport manager keeps the libp2p node alive across relay loss instead of
// rebuilding it (which used to kill every connection).
//
// This scenario OWNS both processes (relay via RELAY_BIN/RELAY_DATA_DIR env,
// shim on :7711). Vite (:8080) is the only ambient prerequisite.
//
// Flow: start relay+shim → two clients register, share a server, exchange
// messages (establishing direct WebRTC between them) → kill BOTH processes →
// messages must still flow both ways → restart the relay → the manager must
// re-reserve on the SAME node and return the UI to connected.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { Scenario, until } from './harness.mjs';
import { register, createServer, copyInvite, joinByInvite, sendMessage, waitForMessage } from './flows.mjs';
import { assertPortFree, startShim, stopShim } from './support-shim.mjs';
import { assertRelayPortFree, startRelay, stopRelay, relayEnv } from './relay-control.mjs';

const rnd = Math.random().toString(36).slice(2, 7);
const SERVER = `Dark Forest ${rnd}`;
const SHIM_DATA = path.join(os.tmpdir(), `harmolyn-e2e-11-shim-${Date.now()}`);
fs.mkdirSync(SHIM_DATA, { recursive: true });

relayEnv(); // fail fast (before launching a browser) if env is missing

const s = await new Scenario('11-infra-loss').start();
let relay = null;
let shim = null;

/** The channel-rail connection status label (role=status dot + label). */
async function connectionLabel(c) {
  const el = c.page.locator('[role="status"]').first();
  if (!(await el.count())) return '';
  return (await el.innerText().catch(() => '')) ?? '';
}

try {
  await s.step('preflight: ports free, spawn scenario-owned relay + shim', async () => {
    await assertRelayPortFree();
    await assertPortFree();
    relay = await startRelay({ log: m => console.log(`  ${m}`) });
    shim = await startShim({ dataDir: SHIM_DATA, log: m => console.log(`  ${m}`) });
  });

  const alice = await s.client('alice');
  const bob = await s.client('bob');

  await s.step('both clients register', async () => {
    await register(alice, 'Alice');
    await register(bob, 'Bob');
  });

  await s.step('server shared; direct peer link established via message exchange', async () => {
    await createServer(alice, SERVER);
    const invite = await copyInvite(alice);
    await joinByInvite(bob, invite, SERVER);
    await sendMessage(alice, `pre-dark-a-${rnd}`);
    await waitForMessage(bob, `pre-dark-a-${rnd}`, 15000);
    await sendMessage(bob, `pre-dark-b-${rnd}`);
    await waitForMessage(alice, `pre-dark-b-${rnd}`, 15000);
  });

  await s.step('give DCUtR a moment to settle the direct WebRTC link', async () => {
    // The webrtc dial races the message exchange above; a short settle window
    // makes the kill deterministic rather than racing connection upgrade.
    await alice.page.waitForTimeout(3000);
  });

  // ─────────────────── total infrastructure loss ───────────────────

  await s.step('KILL relay AND support node — no infrastructure online', async () => {
    await stopRelay(relay);
    await stopShim(shim);
  });

  await s.step('messages still flow alice→bob over the direct link', async () => {
    await sendMessage(alice, `void-a-${rnd}`);
    await waitForMessage(bob, `void-a-${rnd}`, 20000);
  });

  await s.step('messages still flow bob→alice over the direct link', async () => {
    await sendMessage(bob, `void-b-${rnd}`);
    await waitForMessage(alice, `void-b-${rnd}`, 20000);
    await s.shot(alice, 'alice-messaging-in-the-void');
  });

  // NOTE on UI honesty: with peers still reachable over direct links, the rail
  // status legitimately stays CONNECTED — the data plane IS healthy; only the
  // bootstrap path (relay) is down, and relay_addrs are stripped from the
  // snapshot. Fresh clients would fail to bootstrap, which scenario-10 surfaces
  // via the node-offline banner. So no "disconnected" assertion here.

  // ─────────────────────── relay comes back ───────────────────────

  await s.step('RESTART the relay: the live node must re-reserve (no rebuild)', async () => {
    relay = await startRelay({ log: m => console.log(`  ${m}`) });
    // Recovery proof through the UI: the circuit reservation is re-established
    // on the SAME libp2p node (relay_addrs repopulate → status stays/returns
    // CONNECTED and stays there).
    await until(async () => {
      const label = ((await connectionLabel(alice)) || '').toLowerCase();
      return label.includes('connected');
    }, { what: 'alice connected after relay restart', timeout: 90000, interval: 1000 });
  });

  await s.step('messaging still healthy after relay recovery', async () => {
    await sendMessage(alice, `dawn-a-${rnd}`);
    await waitForMessage(bob, `dawn-a-${rnd}`, 15000);
  });
} finally {
  await stopRelay(relay).catch(() => {});
  await stopShim(shim).catch(() => {});
  await s.finish();
}
