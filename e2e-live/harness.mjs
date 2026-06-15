// Two fully-isolated browser peers driving https://web.harmolyn.com end-to-end.
// Each peer = its own chromium.launch() (separate process, storage, IndexedDB).
// PROD ONLY. No dev/vite server. Evidence (screenshots + logs) under ./evidence.
import path from 'path';
import { existsSync } from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const BASE = 'https://web.harmolyn.com';
export const EVIDENCE = path.resolve(__dirname, 'evidence');

export function resolveChrome() {
  const explicit = [
    process.env.PLAYWRIGHT_CHROME_PATH,
    '/usr/bin/google-chrome',
    '/opt/google/chrome/chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  for (const c of explicit) if (existsSync(c)) return c;
  try {
    const managed = chromium.executablePath();
    if (managed && existsSync(managed)) return managed;
  } catch {}
  return undefined;
}

const ts = () => new Date().toISOString().slice(11, 23);

export class Peer {
  constructor(label) {
    this.label = label;
    this.logs = [];
    this.errors = [];
    this.peerId = null;
    this.displayName = null;
  }
  log(msg) {
    const line = `[${ts()}] [${this.label}] ${msg}`;
    console.log(line);
  }
  async launch() {
    this.browser = await chromium.launch({
      headless: true,
      executablePath: resolveChrome(),
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
    });
    this.context = await this.browser.newContext({
      viewport: { width: 1366, height: 900 },
      permissions: ['clipboard-read', 'clipboard-write'],
      ignoreHTTPSErrors: true,
    });
    await this.context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
    this.page = await this.context.newPage();
    // Destructive actions (leave/delete server, revoke invite) gate behind a
    // window.confirm(); auto-accept so the E2E exercises the real path.
    this.page.on('dialog', (d) => { d.accept().catch(() => {}); });
    this.page.on('console', (m) => {
      const t = m.type();
      const txt = `${t}: ${m.text()}`;
      this.logs.push(`[${ts()}] ${txt}`);
      if (t === 'error') this.errors.push(txt);
    });
    this.page.on('pageerror', (e) => {
      const txt = `PAGEERROR: ${e.message}`;
      this.logs.push(`[${ts()}] ${txt}`);
      this.errors.push(txt);
    });
    return this;
  }
  async goto() {
    await this.page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
  }
  async shot(name) {
    const file = path.join(EVIDENCE, `${this.label}-${name}.png`);
    try { await this.page.screenshot({ path: file, fullPage: false }); } catch (e) { this.log(`shot failed: ${e.message}`); }
    return file;
  }
  async dumpLogs() {
    await writeFile(path.join(EVIDENCE, `${this.label}-console.log`), this.logs.join('\n'), 'utf8');
  }
  async close() {
    try { await this.browser?.close(); } catch {}
  }
}

// --- onboarding ---------------------------------------------------------------
export async function onboard(peer, name, password) {
  peer.displayName = name;
  const p = peer.page;
  peer.log(`onboarding as "${name}"`);
  // Welcome overlay
  const createBtn = p.getByRole('button', { name: 'Create an account' });
  await createBtn.waitFor({ state: 'visible', timeout: 45000 });
  await createBtn.click();
  // Register screen
  await p.getByPlaceholder('e.g. Sam').waitFor({ state: 'visible', timeout: 15000 });
  await p.getByPlaceholder('e.g. Sam').fill(name);
  await p.getByPlaceholder('At least 10 characters').fill(password);
  await p.getByPlaceholder('Re-enter your password').fill(password);
  await p.locator('form').getByRole('button', { name: 'Create account' }).click();
  // Key reveal -> continue
  const cont = p.getByRole('button', { name: /Continue/ });
  await cont.waitFor({ state: 'visible', timeout: 45000 });
  // Grab the revealed public key text if present
  await cont.click();
  peer.log('identity created, key-reveal dismissed');
  // App shell
  await p.getByRole('navigation', { name: 'Servers' }).waitFor({ state: 'visible', timeout: 30000 }).catch(() => {});
}

export async function waitConnected(peer, timeout = 60000) {
  const p = peer.page;
  // network status badge in channel/home footer says "Connected"
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const txt = await p.locator('body').innerText().catch(() => '');
    if (/\bCONNECTED\b/i.test(txt) || /connected to the xorein network/i.test(txt)) return true;
    await p.waitForTimeout(1000);
  }
  return false;
}

export async function capturePeerId(peer) {
  const p = peer.page;
  try {
    const copyBtn = p.getByRole('button', { name: /Copy my ID/i }).first();
    if (await copyBtn.count()) {
      await copyBtn.click({ timeout: 5000 });
      await p.waitForTimeout(300);
      const id = await p.evaluate(() => navigator.clipboard.readText().catch(() => ''));
      if (id && id.trim()) { peer.peerId = id.trim(); return peer.peerId; }
    }
  } catch (e) { peer.log(`capturePeerId clipboard failed: ${e.message}`); }
  return null;
}

export async function ensureEvidence() {
  await mkdir(EVIDENCE, { recursive: true });
}
