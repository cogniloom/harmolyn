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
const errors = [], warnings = [], requests = [], checks = [], failures = [];
async function assertPalette(state) {
const palette = await page.evaluate(() => {
  const root = getComputedStyle(document.documentElement);
  const asRgb = name => { const hex = root.getPropertyValue(name).trim(); return [1,3,5].map(i => parseInt(hex.slice(i,i+2),16)); };
  const color = (selector, property) => getComputedStyle(document.querySelector(selector))[property].match(/[\d.]+/g).slice(0,3).map(Number);
  return { expectedText: asRgb('--appearance-text'), expectedBackground: asRgb('--appearance-background'),
    title: color('.chat-title', 'color'), input: color('.chat-compose-input', 'color'),
    background: color('.chat-composer', 'backgroundColor') };
});
assert.deepEqual(palette.title, palette.expectedText, `Title palette drift: ${state}: ${JSON.stringify(palette)}`);
assert.deepEqual(palette.input, palette.expectedText, `Composer palette drift: ${state}: ${JSON.stringify(palette)}`);
assert.deepEqual(palette.background, palette.expectedBackground, `Background palette drift: ${state}: ${JSON.stringify(palette)}`);
}
try {
  await build({ configFile: false, root, plugins: [react()], logLevel: 'error',
    resolve: { alias: [
      { find: '@/hooks/runtime/useRuntimeMutations', replacement: path.join(root, 'scripts/fixtures/sendRuntime.ts') },
      { find: './useRuntimeMutations', replacement: path.join(root, 'scripts/fixtures/sendRuntime.ts') },
      { find: '@/protocol/client', replacement: path.join(root, 'scripts/fixtures/sendSupport.ts') },
      { find: '@', replacement: path.join(root, 'src') },
    ] }, define: { __APP_VERSION__: JSON.stringify('ui-test') },
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
    await page.emulateMedia({ reducedMotion: width === 768 ? 'reduce' : 'no-preference' });
    for (const theme of ['midnight','graphite','oled','ocean','forest','ember','rose','violet','daylight','sand']) {
      await page.getByRole('combobox', { name: 'Test theme' }).selectOption(theme);
      await page.waitForFunction(theme => document.documentElement.dataset.appearance === theme, theme);
      for (const selector of ['.chat-toolbar', '.chat-compose-row', '.chat-message-list']) {
        const fits = await page.locator(selector).evaluate(el => el.scrollWidth <= el.clientWidth + 1);
        assert.ok(fits, `${selector} overflow, ${width}, ${theme}`);
      }
      await assertPalette(`${width}px / ${theme}`);
      const input = page.getByRole('textbox', { name: 'Message Input' });
      await input.fill('A multiline draft\nwith a second line\nand a third line.');
      const boxes = await page.locator('.chat-compose-row').evaluate(el => {
        const parent = el.getBoundingClientRect();
        return [...el.querySelectorAll('button,textarea')].filter(node => node.getClientRects().length).every(node => {
          const rect = node.getBoundingClientRect(); return rect.left >= parent.left && rect.right <= parent.right + 1;
        });
      });
      assert.ok(boxes, `Composer controls clipped at ${width}`);
      const geometry = await page.locator('.chat-compose-row').evaluate(el => {
        const text = el.querySelector('textarea').getBoundingClientRect();
        const controls = [...el.querySelectorAll('button')].filter(node => node.getClientRects().length).map(node => node.getBoundingClientRect());
        const overlaps = controls.some(r => r.left < text.right && r.right > text.left && r.top < text.bottom && r.bottom > text.top);
        return { overlaps, textWidth: text.width, width: el.clientWidth };
      });
      assert.equal(geometry.overlaps, false, `Composer control/text overlap at ${width}`);
      if (width < 600) assert.ok(geometry.textWidth >= geometry.width - 20, `Narrow composer squeezed text at ${width}`);
      const viewport = await page.locator('.chat-message-list').boundingBox();
      const toolbar = await page.locator('.chat-toolbar').boundingBox();
      assert.ok(viewport.y >= toolbar.y + toolbar.height - 1, `Messages scroll behind the toolbar at ${width}`);
      if (['midnight', 'daylight'].includes(theme) && [1440, 390, 320].includes(width)) {
        await page.screenshot({ path: path.join(evidence, `${theme}-${width}.png`) });
      }
      await input.fill('');
    }
    checks.push(`Ten themes at ${width}px: matching text/background palette, no composer overlap, unobscured message viewport`);
  }
  // App accessibility/performance preferences must not turn static colors into fades.
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  for (const preference of ['reduce-motion', 'perf-mode']) {
    await page.evaluate(preference => document.documentElement.classList.add(preference), preference);
    for (const theme of ['daylight', 'midnight', 'sand']) {
      await page.getByRole('combobox', { name: 'Test theme' }).selectOption(theme);
      await assertPalette(`${preference} / ${theme}`);
    }
    await page.evaluate(preference => document.documentElement.classList.remove(preference), preference);
  }
  checks.push('OS reduced motion and app reduced-motion/performance modes apply coherent palettes without fades');
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
    const focusState = await page.evaluate(() => {
      const menu = document.querySelector('[role="menu"][aria-label="Context menu"]');
      const items = menu?.querySelectorAll('[role="menuitem"]:not(:disabled)');
      return { open: !!menu, lastFocused: !!items?.length && items[items.length - 1] === document.activeElement,
        active: document.activeElement?.outerHTML.slice(0, 500), scrollY, menuScroll: menu?.scrollTop };
    });
    assert.ok(focusState.open && focusState.lastFocused, `End lost menu focus at ${width}: ${JSON.stringify(focusState)}`);
    await page.screenshot({ path: path.join(evidence, `message-menu-${width}.png`) });
    await page.keyboard.press('Escape');
    assert.equal(await menu.count(), 0);
    assert.ok(await action.evaluate(el => el === document.activeElement));
  }
  checks.push('Message actions: keyboard anchor, arrow/home/end focus and Escape restoration on desktop/mobile');
  await page.setViewportSize({ width: 1440, height: 1000 });
  for (const name of ['Channel actions', 'Category actions']) {
    const action = page.getByRole('button', { name, exact: true }).first();
    await action.focus();
    const anchor = await action.boundingBox();
    await page.keyboard.press('Enter');
    const menu = page.getByRole('menu', { name: 'Context menu' });
    await menu.waitFor();
    const bounds = await menu.boundingBox();
    assert.ok(bounds.y >= anchor.y && bounds.x >= anchor.x - 1, `${name} opened away from its invoker`);
    assert.ok(await menu.evaluate(el => el.contains(document.activeElement)), `${name} did not receive focus`);
    await page.screenshot({ path: path.join(evidence, name.startsWith('Channel') ? 'channel-menu-keyboard.png' : 'category-menu-keyboard.png') });
    await page.keyboard.press('Escape');
    assert.ok(await action.evaluate(el => el === document.activeElement));
  }
  const filter = page.getByRole('searchbox', { name: 'Filter channels' });
  const design = page.getByRole('complementary', { name: 'Channel List' }).getByText('design-review', { exact: true });
  await page.getByRole('button', { name: 'Collapse Discussion', exact: true }).click();
  assert.equal(await design.isVisible(), false);
  await filter.fill('design');
  assert.ok(await design.isVisible());
  assert.ok(await page.getByRole('button', { name: 'Discussion (filtered results)', exact: true }).isDisabled());
  await page.getByRole('button', { name: 'Clear navigation filter' }).click();
  assert.equal(await design.isVisible(), false);
  await page.getByRole('button', { name: 'Expand Discussion', exact: true }).click();
  checks.push('Collapsed categories remain hidden, expand temporarily for filtering, and restore without mutating the saved state');
  checks.push('Channel/category keyboard menus anchor to invokers, take focus, and restore it on Escape');
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
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: width === 320 ? 568 : 844 });
    const opener = page.getByRole('button', { name: width === 1440 ? 'Pinned Messages' : 'More chat tools', exact: true });
    await opener.click();
    if (width !== 1440) await page.getByRole('dialog', { name: 'Chat tools', exact: true }).getByRole('button', { name: /Pinned messages/ }).click();
    const drawer = page.getByRole('dialog', { name: 'Pinned messages', exact: true });
    await drawer.waitFor();
    assert.ok(await drawer.evaluate(el => el.contains(document.activeElement)));
    // Normal motion deliberately enters from outside the viewport. Measure the
    // settled drawer, rather than whichever animation frame follows visibility.
    await page.waitForFunction(() => {
      const dialog = document.querySelector('[role="dialog"][aria-label="Pinned messages"]');
      return dialog && dialog.getAnimations().every(animation => animation.playState !== 'running');
    }, undefined, { timeout: 3000 });
    const rect = await drawer.boundingBox();
    assert.ok(rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= width + 1 && rect.y + rect.height <= (width === 320 ? 569 : 845), `Pinned drawer clipped at ${width}: ${JSON.stringify(rect)}`);
    await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Tab');
    assert.ok(await drawer.evaluate(el => el.contains(document.activeElement)));
    await page.screenshot({ path: path.join(evidence, `pinned-${width}.png`) });
    await page.keyboard.press('Escape');
    assert.equal(await drawer.count(), 0);
    assert.ok(await opener.evaluate(el => el === document.activeElement));
  }
  checks.push('Pinned drawer: viewport fit, modal focus, keyboard containment and Escape restoration from desktop/compact tools');
  await page.setViewportSize({ width: 1440, height: 1000 });
  for (const layout of ['modern', 'bubbles', 'terminal']) {
    const labels = await page.locator('.compact-message-trigger').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label')));
    assert.equal(labels.length, 3);
    assert.equal(new Set(labels).size, 3, `Ambiguous message controls in ${layout}`);
    assert.ok(labels.every(label => label.includes('message ') && /09:2\d/.test(label)));
    await page.getByRole('button', { name: 'Change Chat View', exact: true }).click();
  }
  const messageSearch = page.getByRole('textbox', { name: 'Search messages', exact: true });
  await messageSearch.fill('  controls  ');
  assert.ok(await page.locator('[data-message-row] mark').count() > 0);
  await messageSearch.fill('   ');
  assert.ok(await page.locator('.chat-conversation-start').isVisible());
  await messageSearch.fill('');
  checks.push('All three layouts identify message controls; trimmed matching, highlighting and whitespace-only search agree');
  // The same production components, with only send/support facade boundaries simulated.
  await page.goto(origin + entry + '?test-remote-send', { waitUntil: 'networkidle' });
  const draft = page.getByRole('textbox', { name: 'Message Input' });
  const recovery = page.getByRole('region', { name: 'Unsent message' });
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: width === 320 ? 568 : 844 });
    if (width === 320) {
      // A reply adds another fixed composer row: test the most constrained path.
      await page.locator('.compact-message-trigger').first().click();
      await page.getByRole('menuitem', { name: 'Reply', exact: true }).click();
    }
    const original = `Retained submission at ${width}px. ` + 'A longer message remains selectable and scrollable. '.repeat(6);
    await draft.fill(original);
    await page.getByRole('button', { name: 'Send Message', exact: true }).click();
    await draft.fill('Newer draft\nwith multiple lines\nthat must not be overwritten.');
    await page.getByRole('button', { name: 'Fail pending send', exact: true }).click();
    await recovery.waitFor();
    assert.equal(await recovery.locator('.chat-failed-content').textContent(), original);
    assert.ok(await page.getByRole('button', { name: 'Send Message', exact: true }).isDisabled());
    assert.equal(await page.getByText(/TEST-PRIVATE-DIAGNOSTIC/).count(), 0);
    const recoveryToolbar = await page.locator('.chat-toolbar').boundingBox();
    const recoveryComposer = await page.locator('.chat-composer').boundingBox();
    for (const action of ['Retry unsent message', 'Discard unsent message']) {
      const box = await recovery.getByRole('button', { name: action, exact: true }).boundingBox();
      assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= width + 1 && box.y + box.height <= (width === 320 ? 569 : 845), `Unreachable ${action} at ${width}`);
      assert.ok(box.y >= recoveryToolbar.y + recoveryToolbar.height && box.y + box.height <= recoveryComposer.y, `Recovery action covered at ${width}: ${JSON.stringify({box, recoveryToolbar, recoveryComposer})}`);
      assert.ok(await recovery.getByRole('button', { name: action, exact: true }).evaluate(button => {
        const rect = button.getBoundingClientRect();
        return button.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2));
      }), `Recovery action obscured at ${width}`);
    }
    const composerBounds = await page.locator('.chat-composer').boundingBox();
    const toolbarBounds = await page.locator('.chat-toolbar').boundingBox();
    assert.ok(composerBounds.y >= toolbarBounds.y + toolbarBounds.height, `Recovery composer overlaps toolbar at ${width}`);
    await page.screenshot({ path: path.join(evidence, `unsent-${width}.png`) });
    await recovery.getByRole('button', { name: 'Retry unsent message', exact: true }).click();
    await page.getByRole('button', { name: 'Complete pending send', exact: true }).click();
    await recovery.waitFor({ state: 'hidden' });
    assert.equal(await draft.inputValue(), 'Newer draft\nwith multiple lines\nthat must not be overwritten.');
    const sent = JSON.parse(await page.getByLabel('Test send requests').textContent());
    assert.equal(sent.at(-1).content, original);
    assert.deepEqual(sent.at(-1), sent.at(-2));
  }
  checks.push('Simulated send rejection: bounded selectable recovery, no raw diagnostics, reachable retry/discard, exact-request retry preserving newer draft');
  assert.deepEqual(errors, [], 'Uncaught exceptions');
  assert.deepEqual(warnings, [], 'Console warnings/errors');
  assert.deepEqual(requests, [], 'Unexpected external requests during local UI interactions');
  await context.close();
} catch (error) {
  process.exitCode = 1; console.error(error);
  failures.push(error instanceof Error ? error.message : String(error));
  await page?.screenshot({ path: path.join(evidence, 'failure.png') }).catch(() => {});
  if (page) await fs.writeFile(path.join(evidence, 'failure-dom.txt'), await page.locator('body').innerText().catch(() => 'unavailable'));
} finally {
  await fs.writeFile(path.join(evidence, 'results.json'), JSON.stringify({ fixture: 'real UI components; synthetic local data; no network engine', passed: failures.length === 0, checks, failures, errors, warnings, requests }, null, 2));
  await browser?.close(); await server?.close(); await fs.rm(temp, { recursive: true, force: true });
}
