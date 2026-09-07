// Real IndexedDB + encryption, simulated provider responses, no WAN claims.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { build, preview } from 'vite';
import { chromium } from 'playwright-core';
const root = process.cwd();
await fs.mkdir(path.join(root, '.generated'), { recursive: true });
const temp = await fs.mkdtemp(path.join(root, '.generated/blob-upload-harness-'));
const outDir = path.join(temp, 'dist');
const evidence = process.env.HARMOLYN_BLOB_EVIDENCE || path.join(root, '.generated/blob-evidence');
await fs.mkdir(evidence, { recursive: true });
await fs.writeFile(path.join(temp, 'index.html'), '<!doctype html><title>Harmolyn attachment verification</title><h1>Attachment lifecycle checks</h1><script type="module" src="/scripts/fixtures/blobUpload.ts"></script>');
let browser, server;
const errors = [], requests = [];
try {
  await build({ configFile: false, root, logLevel: 'error', resolve: { alias: { '@': path.join(root, 'src') } },
    define: { __APP_VERSION__: JSON.stringify('blob-test') },
    build: { outDir, emptyOutDir: true, rollupOptions: { input: path.join(temp, 'index.html') } } });
  server = await preview({ configFile: false, root, logLevel: 'error', build: { outDir }, preview: { host: '127.0.0.1', port: 0 } });
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROME_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } : {}) });
  const page = await browser.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/^https?:/.test(request.url()) && !request.url().startsWith(origin + '/')) requests.push(request.url()); });
  await page.goto(`${origin}/${path.relative(root, temp)}/index.html`, { waitUntil: 'networkidle' });
  assert.match(await page.title(), /Harmolyn attachment verification/);
  await page.waitForFunction(() => typeof window.verifyBlobUploads === 'function');
  const checks = await page.evaluate(() => window.verifyBlobUploads());
  assert.deepEqual(errors, []);
  assert.deepEqual(requests, []);
  await fs.writeFile(path.join(evidence, 'results.json'), JSON.stringify({ checks, errors, externalRequests: requests }, null, 2));
  console.log(JSON.stringify({ checks, errors, externalRequests: requests }, null, 2));
} finally {
  await browser?.close();
  await server?.httpServer.close();
  await fs.rm(temp, { recursive: true, force: true });
}
