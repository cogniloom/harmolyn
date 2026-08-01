// Browser regression for Settings -> Network -> Switch Node.
//
// The scenario owns a current Xorein node and a random-port Vite server. It
// verifies that the chooser does not dismiss itself, a bare host:port can be
// tested from the browser, and Connect persists and activates that endpoint.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';
import { register } from './e2e/flows.mjs';

const ROOT = process.cwd();
const XOREIN_BIN = process.env.XOREIN_BIN
  ?? path.resolve(ROOT, '../xorein/bin/aether');
const NODE = {
  browser: 47711,
  ws: 49999,
  tcp: 49400,
  turn: 43478,
  turnMin: 55600,
  turnMax: 55699,
};
const NODE_ENDPOINT = `http://127.0.0.1:${NODE.browser}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'harmolyn-node-switch-'));

function browserExecutable() {
  for (const candidate of [
    process.env.PLAYWRIGHT_CHROME_PATH,
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean)) {
    if (fs.existsSync(candidate)) return candidate;
  }
  try {
    const managed = chromium.executablePath();
    if (managed && fs.existsSync(managed)) return managed;
  } catch {
    // chromium.launch below will provide the actionable error.
  }
  return undefined;
}

function portOpen(port, timeoutMs = 300) {
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

async function waitFor(check, label, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await check();
      if (last) return last;
    } catch (error) {
      last = error;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label}: ${String(last)}`);
}

async function startNode() {
  for (const port of [NODE.browser, NODE.ws, NODE.tcp, NODE.turn]) {
    if (await portOpen(port)) throw new Error(`node-switch E2E requires free port ${port}`);
  }
  if (!fs.existsSync(XOREIN_BIN)) throw new Error(`xorein binary not found: ${XOREIN_BIN}`);
  const child = spawn(XOREIN_BIN, [
    '--role', 'relay',
    '--data-dir', DATA_DIR,
    '--listen', `127.0.0.1:${NODE.tcp}`,
    '--ws-listen', `127.0.0.1:${NODE.ws}`,
    '--browser-listen', `127.0.0.1:${NODE.browser}`,
    '--turn-listen', `127.0.0.1:${NODE.turn}`,
    '--turn-relay-min-port', String(NODE.turnMin),
    '--turn-relay-max-port', String(NODE.turnMax),
    '--enable-mdns=false',
    '--enable-nat=false',
    '--auto-update=false',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  const logs = [];
  child.stdout.on('data', data => logs.push(String(data).trimEnd()));
  child.stderr.on('data', data => logs.push(String(data).trimEnd()));
  await waitFor(async () => {
    if (child.exitCode !== null) {
      throw new Error(`xorein exited with ${child.exitCode}: ${logs.join('\n')}`);
    }
    try {
      const response = await fetch(`${NODE_ENDPOINT}/health`, { signal: AbortSignal.timeout(500) });
      return response.ok;
    } catch {
      return false;
    }
  }, 'Xorein browser gateway');
  return child;
}

async function stopNode(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await waitFor(() => child.exitCode !== null, 'Xorein shutdown', 8_000)
    .catch(() => child.kill('SIGKILL'));
}

let node;
let viteServer;
let browser;
let context;
let page;
try {
  node = await startNode();
  viteServer = await createServer({
    root: ROOT,
    server: { host: '127.0.0.1', port: 0, strictPort: false },
    logLevel: 'error',
  });
  await viteServer.listen();
  const address = viteServer.httpServer?.address();
  if (!address || typeof address === 'string') throw new Error('Vite did not expose a TCP address');

  browser = await chromium.launch({
    headless: true,
    executablePath: browserExecutable(),
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  await context.addInitScript(() => {
    localStorage.setItem('harmolyn_onboarding_dismissed', 'true');
    localStorage.setItem('harmolyn:xorein:selected-control-endpoint', 'http://127.0.0.1:1');
  });
  page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(String(error)));
  await page.goto(`http://127.0.0.1:${address.port}`, { waitUntil: 'domcontentloaded' });

  const client = { name: 'node-switch', page, context, logs: [] };
  await register(client, 'Node Switch Test');
  await page.getByRole('button', { name: 'Open Settings' }).click();
  await page.getByRole('button', { name: 'Network', exact: true }).click();
  await page.getByRole('button', { name: 'Switch Node', exact: true }).click();

  const heading = page.getByRole('heading', { name: 'CHOOSE A NODE', exact: true });
  await heading.waitFor({ timeout: 10_000 });
  await page.waitForTimeout(4_000);
  if (!(await heading.isVisible())) throw new Error('node chooser dismissed itself without user action');

  await page.getByRole('textbox', { name: 'Node address' }).fill(`127.0.0.1:${NODE.browser}`);
  await page.getByRole('button', { name: 'Test Node', exact: true }).click();
  await page.getByText('Node reachable', { exact: true }).waitFor({ timeout: 10_000 });
  if (!(await heading.isVisible())) throw new Error('node chooser closed after Test Node');

  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await heading.waitFor({ state: 'hidden', timeout: 20_000 });
  await waitFor(async () => {
    const label = await page.locator('[aria-label^="Network status:"]').first().getAttribute('aria-label');
    return label?.toLowerCase().includes('connected to the xorein network') ? label : null;
  }, 'connected network indicator', 30_000);

  const stored = await page.evaluate(() =>
    localStorage.getItem('harmolyn:xorein:selected-control-endpoint'));
  if (stored !== NODE_ENDPOINT) {
    throw new Error(`normalized preferred endpoint was not persisted: ${stored}`);
  }
  if (pageErrors.length) throw new Error(`uncaught page errors: ${pageErrors.join('; ')}`);

  console.log('Node switch E2E: PASS');
  console.log('PASS chooser remains open until explicit action');
  console.log(`PASS bare address tested and normalized to ${NODE_ENDPOINT}`);
  console.log('PASS connected state and preferred endpoint persistence');
} finally {
  await context?.close().catch(() => {});
  await browser?.close().catch(() => {});
  await viteServer?.close().catch(() => {});
  await stopNode(node).catch(() => {});
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
}
