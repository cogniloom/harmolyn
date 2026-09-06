// Real production-bundle UI validation; no mocked React, icons, styles, or settings.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { preview } from 'vite';
import { chromium } from 'playwright-core';

const evidence = path.resolve(process.env.HARMOLYN_APPEARANCE_EVIDENCE ?? '.generated/appearance-evidence');
await fs.mkdir(evidence, { recursive: true });
const server = await preview({ preview: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
const address = server.httpServer.address();
const url = `http://127.0.0.1:${address.port}/`;
let browser;
const errors = [], consoleMessages = [], checks = [];
let page;
try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
  page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', event => { if (['error', 'warning'].includes(event.type())) consoleMessages.push({ type: event.type(), text: event.text() }); });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Just looking? Browse as a guest', exact: true }).click({ timeout: 60000 });
  await page.getByRole('button', { name: 'SETTINGS', exact: true }).click({ timeout: 30000 });
  await page.getByRole('combobox', { name: 'Settings section' }).selectOption('appearance');
  await page.getByRole('heading', { name: 'Appearance', exact: true }).waitFor();
  assert.match(await page.title(), /Harmolyn/i);
  assert.equal(await page.locator('vite-error-overlay').count(), 0);
  assert.equal(await page.locator('input[name="harmolyn-theme"]').count(), 10);
  checks.push('Production app → browse as guest → Settings → Appearance');
  const themes = ['midnight','graphite','oled','ocean','forest','ember','rose','violet','daylight','sand'];
  for (const width of [1440, 768, 390, 320]) {
    await page.setViewportSize({ width, height: width >= 768 ? 1000 : 844 });
    // Compact layouts intentionally unmount the desktop rail; they use bottom navigation.
    await page.waitForFunction(w => !!document.querySelector('[data-testid="server-rail-home"]') === (w >= 1100), width);
    for (const theme of themes) {
      await page.locator(`input[name="harmolyn-theme"][value="${theme}"]`).locator('..').click();
      await page.waitForFunction(value => document.documentElement.dataset.appearance === value, theme);
      const fits = await page.locator('.appearance-settings').evaluate(el => el.scrollWidth <= el.clientWidth + 1 && document.documentElement.scrollWidth <= window.innerWidth + 1);
      assert.ok(fits, `${theme} overflows at ${width}px`);
      if (width >= 1100) {
        const homeContrast = await page.getByTestId('server-rail-home').evaluate(el => {
          const style = getComputedStyle(el);
          const parse = color => color.match(/[\d.]+/g).map(Number);
          const luminance = values => values.slice(0, 3).map(value => {
            const channel = value / 255;
            return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
          }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
          const foreground = parse(style.color), background = parse(style.backgroundColor);
          const a = luminance(foreground), b = luminance(background);
          return { opaque: background.length === 3 || background[3] >= 0.99, ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) };
        });
        assert.ok(homeContrast.opaque && homeContrast.ratio >= 4.5, `${theme} active Home button loses contrast`);
      }
      if (['midnight', 'daylight'].includes(theme)) {
        await page.locator('.appearance-heading').scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(evidence, `${theme}-${width}.png`) });
      }
    }
    checks.push(`All ten themes selected, no horizontal overflow at ${width}px${width >= 1100 ? "; desktop active navigation contrast verified" : "; compact navigation verified"}`);
  }
  await page.locator('input[name="harmolyn-theme"][value="midnight"]').locator('..').click();
  await page.getByLabel('Accent', { exact: true }).fill('#88BBCC');
  await page.getByLabel('Accent', { exact: true }).press('Enter');
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('harmolyn:appearance:v1') ?? '{}').custom?.midnight?.accent === '#88BBCC');
  await page.getByLabel('Accent', { exact: true }).fill('url(x)');
  await page.getByLabel('Accent', { exact: true }).press('Enter');
  assert.equal(await page.getByLabel('Accent', { exact: true }).getAttribute('aria-invalid'), 'true');
  await page.getByLabel('Accent', { exact: true }).press('Escape');
  assert.equal(await page.getByLabel('Accent', { exact: true }).inputValue(), '#88BBCC');
  await page.locator('input[name="harmolyn-theme"][value="daylight"]').locator('..').click();
  await page.locator('input[name="harmolyn-theme"][value="midnight"]').locator('..').click();
  assert.equal(await page.getByLabel('Accent', { exact: true }).inputValue(), '#88BBCC');
  checks.push('Custom color persists per theme; unsafe CSS input rejected; Escape restores value');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.documentElement.dataset.appearance === 'midnight');
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('harmolyn:appearance:v1')).custom.midnight.accent), '#88BBCC');
  await page.getByRole('button', { name: 'SETTINGS', exact: true }).click({ timeout: 30000 });
  await page.getByRole('combobox', { name: 'Settings section' }).selectOption('appearance');
  assert.equal(await page.getByLabel('Accent', { exact: true }).inputValue(), '#88BBCC');
  await page.getByRole('button', { name: 'Reset colors' }).click();
  assert.equal(await page.getByLabel('Accent', { exact: true }).inputValue(), '#A5B4FC');
  await page.locator('input[name="harmolyn-message-layout"][value="bubbles"]').locator('..').click();
  assert.ok(await page.locator('.appearance-conversation-bubbles').isVisible());
  checks.push('Real storage survives reload; reset and message layout callbacks work');
  const second = await context.newPage();
  await second.goto(url, { waitUntil: 'domcontentloaded' });
  await second.waitForFunction(() => !!document.documentElement.dataset.appearance);
  await page.locator('input[name="harmolyn-theme"][value="sand"]').locator('..').click();
  await second.waitForFunction(() => document.documentElement.dataset.appearance === 'sand');
  checks.push('Theme synchronizes to another real browser tab');
  await page.locator('input[name="harmolyn-theme"][value="daylight"]').locator('..').click();
  await page.evaluate(() => document.documentElement.classList.add('high-contrast'));
  const contrastMode = await page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    return ['--appearance-background-rgb', '--appearance-surface-rgb', '--appearance-elevated-rgb'].map(key => style.getPropertyValue(key).trim());
  });
  assert.deepEqual(contrastMode, ['0 0 0', '10 10 10', '17 17 17']);
  await page.locator('.appearance-heading').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(evidence, 'high-contrast-320.png') });
  await page.evaluate(() => document.documentElement.classList.remove('high-contrast'));
  await page.locator('input[name="harmolyn-theme"][value="sand"]').locator('..').click();
  checks.push('High contrast overrides light-theme surfaces without losing the saved theme');
  await second.close();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('button', { name: 'Close settings', exact: true }).filter({ visible: true }).first().click();
  await page.locator('.settings-screen').waitFor({ state: 'detached' });
  await page.screenshot({ path: path.join(evidence, 'application-shell-sand-1440.png') });
  assert.deepEqual(errors, [], 'Uncaught application exceptions');
  checks.push('No uncaught application exceptions');
  await context.close();
} catch (error) {
  if (page) {
    await page.screenshot({ path: path.join(evidence, 'failure.png'), fullPage: true }).catch(() => {});
    await fs.writeFile(path.join(evidence, 'failure-dom.txt'), await page.locator('body').innerText().catch(() => 'unavailable'));
  }
  process.exitCode = 1;
  console.error(error);
} finally {
  await fs.writeFile(path.join(evidence, 'results.json'), JSON.stringify({ productionBundle: true, checks, errors, consoleMessages }, null, 2));
  await browser?.close();
  await server.close();
}
