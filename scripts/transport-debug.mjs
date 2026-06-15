import path from 'path';
import { existsSync } from 'fs';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';

const ROOT = process.cwd();

function resolveChromeExecutable() {
  for (const c of ['/usr/bin/google-chrome','/usr/bin/chromium','/usr/bin/chromium-browser']) {
    if (existsSync(c)) return c;
  }
  return undefined;
}

const viteServer = await createServer({
  root: ROOT,
  server: { host: '127.0.0.1', port: 0 },
  logLevel: 'error',
});
await viteServer.listen();
const address = viteServer.httpServer?.address();
const port = address?.port ?? 8080;
const url = `http://127.0.0.1:${port}/p0-test.html`;
console.log('Test URL:', url);

const browser = await chromium.launch({
  headless: true,
  executablePath: resolveChromeExecutable(),
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

const page = await browser.newPage();
page.on('console', msg => { if (msg.type() !== 'log') console.log('[BROWSER]', msg.type(), msg.text().substring(0, 200)); });
page.on('pageerror', err => console.log('[PAGE ERROR]', err.message));

await page.goto(url);
await page.waitForFunction(() => typeof window.__p0?.createNode === 'function', { timeout: 10_000 }).catch(e => console.log('FAILED to load __p0:', e.message));

const result = await page.evaluate(async () => {
  try {
    const node = await window.__p0.createNode();
    return { ok: true, peerId: node.peerId.toString().substring(0, 20), addrs: node.getMultiaddrs().map(m => m.toString()) };
  } catch(err) {
    return { ok: false, error: err.message };
  }
});

console.log('Node result:', JSON.stringify(result, null, 2));

await browser.close();
await viteServer.close();
