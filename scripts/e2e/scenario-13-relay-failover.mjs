// Scenario 13: a preferred relay dies while another independently running
// relay remains healthy. The browser must learn relay B through signed PEX,
// authenticate its role over Noise, and fail over without a page reload or a
// manual node switch.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Scenario, until } from './harness.mjs';
import { register } from './flows.mjs';

const XOREIN_BIN = process.env.XOREIN_BIN
  ?? path.resolve(process.cwd(), '../xorein/bin/aether');
const NODE_A = {
  name: 'node-a', http: 17711, ws: 19999, tcp: 19400,
  turn: 13478, turnMin: 55200, turnMax: 55299,
};
const NODE_B = {
  name: 'node-b', http: 27711, ws: 29999, tcp: 29400,
  turn: 23478, turnMin: 55300, turnMax: 55399,
};
const NODE_A_ENDPOINT = `http://127.0.0.1:${NODE_A.http}`;
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'harmolyn-relay-failover-'));
process.env.XOREIN_NODE_ENDPOINT = NODE_A_ENDPOINT;

function portOpen(port, timeoutMs = 400) {
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

async function health(node) {
  try {
    const response = await fetch(`http://127.0.0.1:${node.http}/health`, {
      signal: AbortSignal.timeout(1_000),
    });
    return response.ok ? response.json() : null;
  } catch {
    return null;
  }
}

async function startNode(node, extra = [], log = () => {}) {
  const dataDir = path.join(ROOT, node.name);
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const child = spawn(XOREIN_BIN, [
    '--role', 'relay',
    '--data-dir', dataDir,
    '--listen', `127.0.0.1:${node.tcp}`,
    '--ws-listen', `127.0.0.1:${node.ws}`,
    '--browser-listen', `127.0.0.1:${node.http}`,
    '--turn-listen', `127.0.0.1:${node.turn}`,
    '--turn-tcp-listen', `127.0.0.1:${node.turn}`,
    '--turn-tls-listen', '-',
    '--turn-public-ip', '127.0.0.1',
    '--turn-relay-min-port', String(node.turnMin),
    '--turn-relay-max-port', String(node.turnMax),
    '--enable-mdns=false',
    '--enable-nat=false',
    '--auto-update=false',
    ...extra,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', data => log(`[${node.name}] ${data}`.trimEnd()));
  child.stderr.on('data', data => log(`[${node.name}!] ${data}`.trimEnd()));
  const result = await until(async () => {
    if (child.exitCode !== null) throw new Error(`${node.name} exited with ${child.exitCode}`);
    const state = await health(node);
    return state?.peer_id ? state : null;
  }, { what: `${node.name} gateway`, timeout: 15_000, interval: 100 });
  return { ...node, child, dataDir, peerID: result.peer_id };
}

async function stopNode(node) {
  if (!node?.child || node.child.exitCode !== null) return;
  node.child.kill('SIGTERM');
  await until(async () =>
    !(await portOpen(node.http, 150)) && !(await portOpen(node.ws, 150)),
  { what: `${node.name} shutdown`, timeout: 8_000, interval: 100 });
}

function runtimeSnapshot(page) {
  return page.evaluate(() =>
    window.__HARMOLYN_XOREIN_RUNTIME__
    ?? window.__HARMOLYN_RUNTIME_SNAPSHOT__
    ?? window.__XOREIN_RUNTIME_SNAPSHOT__
    ?? null);
}

const scenario = await new Scenario('13-relay-failover').start();
let nodeA = null;
let nodeB = null;

try {
  await scenario.step('start two independent turnkey relays', async () => {
    if (!fs.existsSync(XOREIN_BIN)) throw new Error(`xorein binary not found: ${XOREIN_BIN}`);
    for (const port of [
      NODE_A.http, NODE_A.ws, NODE_A.tcp, NODE_A.turn,
      NODE_B.http, NODE_B.ws, NODE_B.tcp, NODE_B.turn,
    ]) {
      if (await portOpen(port)) throw new Error(`port ${port} must be free`);
    }
    nodeB = await startNode(NODE_B, [], message => console.log(`  ${message}`));
    const nodeBAddr = `/ip4/127.0.0.1/tcp/${NODE_B.tcp}/p2p/${nodeB.peerID}`;
    nodeA = await startNode(
      NODE_A,
      ['--manual-peers', nodeBAddr],
      message => console.log(`  ${message}`),
    );
  });

  const client = await scenario.client('client');
  await scenario.step('browser starts on relay A', async () => {
    await register(client, 'Failover Client');
    await until(async () => {
      const runtime = await runtimeSnapshot(client.page);
      return runtime?.transport_state === 'connected'
        && runtime?.relay_addrs?.some(address => String(address).includes(`/tcp/${NODE_A.ws}/`));
    }, { what: 'relay A reservation', timeout: 30_000, interval: 250 });
  });

  await scenario.step('relay B is learned automatically through signed peer exchange', async () => {
    await until(async () => {
      const runtime = await runtimeSnapshot(client.page);
      return runtime?.known_peers?.some(peer =>
        peer.peer_id === nodeB.peerID
        && peer.role === 'relay'
        && peer.addresses?.some(address => String(address).includes(`/tcp/${NODE_B.ws}/`)));
    }, { what: 'authenticated relay B discovery', timeout: 75_000, interval: 250 });
  });

  await scenario.step('kill preferred relay A and fail over to B without reload', async () => {
    await stopNode(nodeA);
    nodeA = null;
    await until(async () => {
      const runtime = await runtimeSnapshot(client.page);
      return runtime?.transport_state === 'connected'
        && runtime?.relay_addrs?.some(address =>
          String(address).includes(`/tcp/${NODE_B.ws}/ws/p2p/${nodeB.peerID}`));
    }, { what: 'live relay B reservation', timeout: 60_000, interval: 250 });
    const preferred = await client.page.evaluate(() =>
      localStorage.getItem('harmolyn:xorein:selected-control-endpoint'));
    if (preferred !== NODE_A_ENDPOINT) {
      throw new Error(`test expected failover without a manual preference change, got ${preferred}`);
    }
    await scenario.shot(client, 'automatic-relay-b-failover');
  });
} finally {
  await stopNode(nodeA).catch(() => {});
  await stopNode(nodeB).catch(() => {});
  await scenario.finish();
}
