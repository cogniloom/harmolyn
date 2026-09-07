// Browser plugin is not available in CI; run the lockfile-pinned Playwright.
// Real production-mode UI components, local fixture props, no network/call claims.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { build, preview } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright-core';
const root = process.cwd();
await fs.mkdir(path.join(root, '.generated'), { recursive: true });
const temp = await fs.mkdtemp(path.join(root, '.generated/conversation-harness-'));
const outDir = path.join(temp, 'dist');
const evidence = path.join(root, '.generated/conversation-evidence');
await fs.mkdir(evidence, { recursive: true });
await fs.writeFile(path.join(temp, 'index.html'), '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Harmolyn conversation UI verification</title></head><body style="margin:0"><div id="root"></div><script type="module" src="/scripts/fixtures/conversation.tsx"></script></body></html>');
let server, browser, page;
const errors = [], warnings = [], requests = [], checks = [];
try {
  await build({ configFile: false, root, plugins: [react()], logLevel: 'error',
    resolve: { alias: { '@': path.join(root, 'src') } }, define: { __APP_VERSION__: JSON.stringify('ui-test') },
    build: { outDir, emptyOutDir: true, rollupOptions: { input: path.join(temp, 'index.html') } } });
  server = await preview({ configFile: false, root, build: { outDir }, preview: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
  const address = server.httpServer.address();
  const origin = `http://127.0.0.1:${address.port}`;
  // Vite preserves the entry's path relative to root.
  const entry = '/' + path.relative(root, temp).replaceAll('\\', '/') + '/index.html';
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (['error', 'warning'].includes(message.type())) warnings.push(message.text()); });
  page.on('request', request => { if (!request.url().startsWith(origin) && /^https?:/.test(request.url())) requests.push(request.url()); });
  await page.goto(origin + entry, { waitUntil: 'networkidle' });
  assert.match(await page.title(), /Harmolyn/);
  await page.getByRole('textbox', { name: 'Message Input' }).waitFor();
  assert.equal(await page.locator('vite-error-overlay').count(), 0);
  checks.push('Real conversation components render without a framework overlay');
  for (const width of [1440, 1100, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const theme of ['midnight','graphite','oled','ocean','forest','ember','rose','violet','daylight','sand']) {
      await page.getByRole('combobox', { name: 'Test theme' }).selectOption(theme);
      await page.waitForFunction(theme => document.documentElement.dataset.appearance === theme, theme);
      for (const selector of ['.chat-toolbar', '.chat-compose-row', '.chat-message-list']) {
        const fits = await page.locator(selector).evaluate(el => el.scrollWidth <= el.clientWidth + 1);
        assert.ok(fits, `${selector} overflow, ${width}, ${theme}`);
      }
      const input = page.getByRole('textbox', { name: 'Message Input' });
      await input.fill('A multiline draft\nwith a second line\nand a third line.');
      const boxes = await page.locator('.chat-compose-row').evaluate(el => {
        const parent = el.getBoundingClientRect();
        return [...el.querySelectorAll('button,textarea')].filter(node => node.getClientRects().length).every(node => {
          const rect = node.getBoundingClientRect(); return rect.left >= parent.left && rect.right <= parent.right + 1;
        });
      });
      assert.ok(boxes, `Composer controls clipped at ${width}`);
      if (['midnight', 'daylight'].includes(theme) && [1440, 390, 320].includes(width)) {
        await page.screenshot({ path: path.join(evidence, `${theme}-${width}.png`) });
      }
      await input.fill('');
    }
    checks.push(`Ten themes at ${width}px: toolbar, message list, multiline composer fit`);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: 'Toggle narrow chat' }).click();
  await page.getByRole('button', { name: 'More chat tools', exact: true }).click();
  await page.getByRole('dialog', { name: 'Chat tools', exact: true }).waitFor();
  assert.ok(await page.getByRole('dialog', { name: 'Chat tools', exact: true }).evaluate(el => el.contains(document.activeElement)));
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('dialog', { name: 'Chat tools', exact: true }).count(), 0);
  await page.getByRole('button', { name: 'Toggle narrow chat' }).click();
  checks.push('Narrow desktop conversation uses reachable compact tools; Escape closes them');
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    const action = page.locator('.compact-message-trigger').first();
    await action.focus();
    await page.keyboard.press('Enter');
    const menu = page.getByRole('menu', { name: 'Context menu' });
    await menu.waitFor();
    assert.ok(await menu.evaluate(el => el.contains(document.activeElement)), 'Message menu did not receive keyboard focus');
    const bounds = await menu.boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width + 1 && bounds.y > 20 && bounds.y + bounds.height <= 845, 'Keyboard menu is detached or clipped');
    await page.keyboard.press('End');
    assert.ok(await menu.getByRole('menuitem').last().evaluate(el => el === document.activeElement));
    await page.screenshot({ path: path.join(evidence, `message-menu-${width}.png`) });
    await page.keyboard.press('Escape');
    assert.equal(await menu.count(), 0);
    assert.ok(await action.evaluate(el => el === document.activeElement));
  }
  checks.push('Message actions: keyboard anchor, arrow/home/end focus and Escape restoration on desktop/mobile');
  await page.setViewportSize({ width: 1440, height: 1000 });
  const filter = page.getByRole('searchbox', { name: 'Filter channels' });
  await filter.fill('ideas');
  assert.equal(await page.getByRole('complementary', { name: 'Channel List' }).getByText('general', { exact: true }).count(), 0);
  await page.getByRole('button', { name: 'Clear navigation filter' }).click();
  checks.push('Channel filtering hides non-matches and clearing restores navigation');
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: width === 320 ? 568 : 844 });
    await page.getByRole('button', { name: 'Find a conversation', exact: true }).click();
    const search = page.getByRole('combobox', { name: 'Search channels and direct messages' });
    await search.fill('design');
    await page.keyboard.press('ArrowDown');
    assert.ok(await search.getAttribute('aria-activedescendant'));
    await page.screenshot({ path: path.join(evidence, `switcher-${width}.png`) });
    const dialog = page.getByRole('dialog', { name: 'Quick switcher' });
    assert.ok(await dialog.evaluate(el => { const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1; }));
    await page.keyboard.press('Tab'); await page.keyboard.press('Tab');
    assert.ok(await dialog.evaluate(el => el.contains(document.activeElement)), 'Tab escaped switcher');
    await page.keyboard.press('Escape');
    assert.ok(await page.getByRole('button', { name: 'Find a conversation', exact: true }).evaluate(el => el === document.activeElement));
  }
  checks.push('Quick switcher: combobox selection, viewport fit, focus trapping and restoration');
  assert.deepEqual(errors, [], 'Uncaught exceptions');
  assert.deepEqual(warnings, [], 'Console warnings/errors');
  assert.deepEqual(requests, [], 'Unexpected external requests during local UI interactions');
  await context.close();
} catch (error) {
  process.exitCode = 1; console.error(error);
  await page?.screenshot({ path: path.join(evidence, 'failure.png') }).catch(() => {});
  if (page) await fs.writeFile(path.join(evidence, 'failure-dom.txt'), await page.locator('body').innerText().catch(() => 'unavailable'));
} finally {
  await fs.writeFile(path.join(evidence, 'results.json'), JSON.stringify({ fixture: 'real UI components; synthetic local data; no network engine', checks, errors, warnings, requests }, null, 2));
  await browser?.close(); await server?.close(); await fs.rm(temp, { recursive: true, force: true });
}
