// Production empty-state component + injected local snapshot; no network engine.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { build, preview } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright-core';
const root = process.cwd();
await fs.mkdir(path.join(root, '.generated'), { recursive: true });
const temp = await fs.mkdtemp(path.join(root, '.generated/empty-state-harness-'));
const outDir = path.join(temp, 'dist');
const evidence = path.join(root, '.generated/empty-state-evidence');
await fs.mkdir(evidence, { recursive: true });
await fs.writeFile(path.join(temp, 'index.html'), '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Harmolyn empty-state verification</title></head><body style="margin:0"><div id="root"></div><script type="module" src="/scripts/fixtures/emptyState.tsx"></script></body></html>');
let browser, server;
const errors = [], requests = [], checks = [];
try {
  await build({ configFile: false, root, plugins: [react()], logLevel: 'error', resolve: { alias: { '@': path.join(root, 'src') } },
    define: { __APP_VERSION__: JSON.stringify('empty-state-test') },
    build: { outDir, emptyOutDir: true, rollupOptions: { input: path.join(temp, 'index.html') } } });
  server = await preview({ configFile: false, root, logLevel: 'error', build: { outDir }, preview: { host: '127.0.0.1', port: 0 } });
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ reducedMotion: 'reduce' });
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/^https?:/.test(request.url()) && !request.url().startsWith(origin + '/')) requests.push(request.url()); });
  await page.goto(`${origin}/${path.relative(root, temp)}/index.html`, { waitUntil: 'networkidle' });
  assert.match(await page.title(), /Harmolyn empty-state verification/);
  assert.equal(await page.locator('vite-error-overlay').count(), 0);
  for (const width of [1440, 320]) {
    await page.setViewportSize({ width, height: width === 320 ? 568 : 900 });
    for (const theme of ['midnight', 'graphite', 'oled', 'ocean', 'forest', 'ember', 'rose', 'violet', 'daylight', 'sand']) {
      await page.getByRole('combobox', { name: 'Test theme' }).selectOption(theme);
      await page.getByRole('heading', { name: 'No text channel selected' }).waitFor();
      assert.equal(await page.getByText('Welcome to Harmolyn').count(), 0);
      assert.equal(await page.getByRole('button', { name: 'Create a Space', exact: true }).count(), 0);
      assert.ok(await page.locator('section').evaluate(element => element.scrollWidth <= element.clientWidth + 1));
      await page.getByRole('button', { name: 'Open friends and direct messages' }).click();
      await page.getByText('Friends requested', { exact: true }).waitFor();
      if (theme === (width === 320 ? 'midnight' : 'daylight')) await page.screenshot({ path: path.join(evidence, `no-text-${width}.png`) });
    }
    checks.push(`Voice-only empty state at ${width}px across ten themes: no false onboarding, no horizontal overflow, action responds`);
  }
  await page.getByRole('button', { name: 'Toggle Space membership' }).click();
  await page.getByRole('heading', { name: 'Welcome to Harmolyn' }).waitFor();
  assert.equal(await page.getByRole('heading', { name: 'No text channel selected' }).count(), 0);
  await page.getByRole('button', { name: /Create a Space/ }).click();
  await page.getByText('Create requested', { exact: true }).waitFor();
  checks.push('Removing the final Space restores genuine first-time onboarding and its create action');
  assert.deepEqual(errors, []); assert.deepEqual(requests, []);
  await fs.writeFile(path.join(evidence, 'results.json'), JSON.stringify({ checks, errors, externalRequests: requests }, null, 2));
  console.log(JSON.stringify({ checks, errors, externalRequests: requests }, null, 2));
} finally {
  await browser?.close(); await server?.httpServer.close(); await fs.rm(temp, { recursive: true, force: true });
}
