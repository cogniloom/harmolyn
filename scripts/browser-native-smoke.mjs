// Self-contained browser smoke for the native-engine-default architecture.
//
// This deliberately runs with a closed relay endpoint. The local runtime must
// still support account creation, server creation, durable local messaging,
// reload/unlock, and honest FINDING PEERS status without an HTTP control mock.
import path from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';
import { register, createServer as createPeerServer, sendMessage, waitForMessage } from './e2e/flows.mjs';

const ROOT = process.cwd();
const EVIDENCE_DIR = path.resolve(ROOT, '.generated/browser-evidence');
const MODE = process.argv[2] === 'no-peers' || process.argv[2] === 'missing-runtime'
  ? 'no-peers'
  : 'happy';
const PASSWORD = 'correct horse battery';
const RELAY_PEER_ID = '12D3KooWGWC3A4KawRYn9Mcyt9LjDg6TS7vF5uju7v6gTFsrEBS4';

// Keep this smoke deterministic and independent of public/ambient relays.
process.env.VITE_RELAY_PEER_ID = RELAY_PEER_ID;
process.env.VITE_RELAY_MULTIADDR = `/ip4/127.0.0.1/tcp/1/ws/p2p/${RELAY_PEER_ID}`;

function resolveChromeExecutable() {
  for (const candidate of [
    process.env.PLAYWRIGHT_CHROME_PATH,
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean)) {
    if (existsSync(candidate)) return candidate;
  }
  try {
    const managed = chromium.executablePath();
    if (managed && existsSync(managed)) return managed;
  } catch {
    // The launch below produces the useful environment error.
  }
  return undefined;
}

async function waitForHonestNoPeerStatus(page) {
  const connectionStatus = page.locator('[role="status"][aria-label^="Connection:"]').first();
  await connectionStatus.waitFor({ timeout: 30_000 });
  await page.waitForFunction(
    () => document.querySelector('[role="status"][aria-label^="Connection:"]')
      ?.getAttribute('aria-label')
      ?.includes('FINDING PEERS') === true,
    undefined,
    { timeout: 70_000 },
  );
  const connectionLabel = await connectionStatus.getAttribute('aria-label');

  const activityStatus = page.locator('[role="status"][aria-label^="Network status:"]').first();
  await activityStatus.waitFor({ timeout: 30_000 });
  const activityLabel = await activityStatus.getAttribute('aria-label');
  if (!activityLabel?.includes('FINDING PEERS')) {
    throw new Error(`bottom-left network state was not honest: ${String(activityLabel)}`);
  }
  return { connectionLabel, activityLabel };
}

await mkdir(EVIDENCE_DIR, { recursive: true });
const viteServer = await createServer({
  root: ROOT,
  server: { host: '127.0.0.1', port: 0, strictPort: false },
  logLevel: 'error',
});
await viteServer.listen();
const address = viteServer.httpServer?.address();
const port = typeof address === 'object' && address ? address.port : viteServer.config.server.port;
const baseUrl = `http://127.0.0.1:${port}`;
const browser = await chromium.launch({
  headless: true,
  executablePath: resolveChromeExecutable(),
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

let context;
let page;
let exitCode = 0;
try {
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
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });

  if (MODE === 'no-peers') {
    await page.getByText("You're browsing as a guest.", { exact: false }).waitFor({ timeout: 30_000 });
    const { connectionLabel, activityLabel } = await waitForHonestNoPeerStatus(page);
    const screenshot = path.join(EVIDENCE_DIR, 'native-no-peers-smoke.png');
    await page.screenshot({ path: screenshot, fullPage: true });
    if (pageErrors.length) throw new Error(`uncaught page errors: ${pageErrors.join('; ')}`);
    const report = [
      'Harmolyn native browser smoke: no-peer path',
      `Base URL: ${baseUrl}`,
      'Local runtime remained available with no relay.',
      'Connection indicator reported FINDING PEERS, not CONNECTED.',
      `Main indicator: ${connectionLabel}`,
      `Bottom-left indicator: ${activityLabel}`,
      `Evidence: ${path.relative(ROOT, screenshot)}`,
    ].join('\n');
    await writeFile(path.join(EVIDENCE_DIR, 'native-no-peers-smoke.txt'), report, 'utf8');
    console.log(report);
  } else {
    const client = { name: 'browser-smoke', page, context, logs: [] };
    const peerId = await register(client, 'Browser Smoke', PASSWORD);
    const suffix = Math.random().toString(36).slice(2, 7);
    const serverName = `Native Smoke ${suffix}`;
    const message = `durable-local-${suffix}`;

    await createPeerServer(client, serverName);
    await sendMessage(client, message);
    await waitForMessage(client, message, 20_000);

    const { connectionLabel, activityLabel } = await waitForHonestNoPeerStatus(page);

    await page.reload({ waitUntil: 'domcontentloaded' });
    const password = page.getByPlaceholder('Your identity password');
    await password.waitFor({ timeout: 30_000 });
    await password.fill(PASSWORD);
    await page.getByRole('button', { name: 'Unlock', exact: true }).click();
    await page.getByRole('button', { name: `Space: ${serverName}` }).waitFor({ timeout: 30_000 });
    if (await page.getByText(message, { exact: true }).count() === 0) {
      await page.getByRole('button', { name: `Space: ${serverName}` }).click();
      await page.getByRole('button', { name: 'general', exact: true }).first().click();
    }
    await page.getByText(message, { exact: true }).waitFor({ timeout: 30_000 });

    const screenshot = path.join(EVIDENCE_DIR, 'native-browser-smoke.png');
    await page.screenshot({ path: screenshot, fullPage: true });
    if (pageErrors.length) throw new Error(`uncaught page errors: ${pageErrors.join('; ')}`);
    const report = [
      'Harmolyn native browser smoke: happy path',
      `Base URL: ${baseUrl}`,
      `Registered peer: ${peerId}`,
      `Created Space: ${serverName}`,
      `Durable message survived reload/unlock: ${message}`,
      'Connection indicator remained FINDING PEERS with the relay deliberately absent.',
      `Main indicator: ${connectionLabel}`,
      `Bottom-left indicator: ${activityLabel}`,
      `Evidence: ${path.relative(ROOT, screenshot)}`,
    ].join('\n');
    await writeFile(path.join(EVIDENCE_DIR, 'native-browser-smoke.txt'), report, 'utf8');
    console.log(report);
  }
} catch (error) {
  if (page) {
    const failureScreenshot = path.join(EVIDENCE_DIR, `native-${MODE}-failure.png`);
    const failureText = path.join(EVIDENCE_DIR, `native-${MODE}-failure.txt`);
    await page.screenshot({ path: failureScreenshot, fullPage: true }).catch(() => undefined);
    const body = await page.locator('body').innerText().catch(() => '<body unavailable>');
    await writeFile(failureText, body, 'utf8').catch(() => undefined);
    console.error(`Failure evidence: ${path.relative(ROOT, failureScreenshot)}, ${path.relative(ROOT, failureText)}`);
  }
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  exitCode = 1;
} finally {
  await context?.close().catch(() => undefined);
  await browser.close();
  await viteServer.close();
}

process.exitCode = exitCode;
