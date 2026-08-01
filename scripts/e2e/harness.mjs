// Two-client E2E harness for the local xorein stack.
//
// Prereqs (started outside this script):
//   - a current Xorein relay/archivist with its browser gateway and WebSocket
//     listener enabled (the turnkey relay defaults do this)
//   - Vite dev server on :8080
//   - XOREIN_NODE_ENDPOINT set to that browser-gateway origin
//
// Each client() is an isolated browser context (own IndexedDB/localStorage) —
// a genuinely independent harmolyn peer. Evidence (screenshots, console logs,
// step timings) lands in EVIDENCE_DIR/<scenario>/.
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const APP_URL = process.env.HARMOLYN_URL ?? 'http://127.0.0.1:8080/';
const EVIDENCE_ROOT = process.env.EVIDENCE_DIR
  ?? '/tmp/claude-1000/-home-wenga-src-harmolyn/c5d0e408-1a62-4312-81de-c5a267f348cf/scratchpad/e2e';

function chromePath() {
  for (const p of ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome']) {
    if (fs.existsSync(p)) return p;
  }
  return undefined; // fall back to playwright-managed
}

export class Scenario {
  constructor(name) {
    this.name = name;
    this.dir = path.join(EVIDENCE_ROOT, name);
    fs.rmSync(this.dir, { recursive: true, force: true });
    fs.mkdirSync(this.dir, { recursive: true });
    this.browser = null;
    this.clients = [];
    this.stepIndex = 0;
    this.failures = [];
  }

  async start() {
    this.browser = await chromium.launch({
      headless: true,
      executablePath: chromePath(),
      args: [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        '--autoplay-policy=no-user-gesture-required',
        // Multiple client pages share one headless browser; all but one count
        // as "background" and Chromium throttles their timers/scheduling,
        // adding tens of ms of fake latency the real app (visible tab per
        // user) never sees. Disable so measurements reflect foreground reality.
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        '--disable-backgrounding-occluded-windows',
      ],
    });
    return this;
  }

  /** New isolated client (fresh profile). name like "alice"/"bob". */
  async client(name) {
    const context = await this.browser.newContext({
      viewport: { width: 1440, height: 900 },
      permissions: ['microphone', 'camera', 'clipboard-read', 'clipboard-write'],
    });
    const selectedNodeEndpoint = process.env.XOREIN_NODE_ENDPOINT?.trim();
    if (selectedNodeEndpoint) {
      await context.addInitScript((endpoint) => {
        localStorage.setItem('harmolyn:xorein:selected-control-endpoint', endpoint);
      }, selectedNodeEndpoint);
    }
    const page = await context.newPage();
    const logs = [];
    page.on('console', msg => logs.push({ t: Date.now(), kind: msg.type(), text: msg.text() }));
    page.on('pageerror', err => logs.push({ t: Date.now(), kind: 'pageerror', text: String(err) }));
    const c = { name, context, page, logs };
    this.clients.push(c);
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    return c;
  }

  /** Run one labeled step; screenshots every client on failure. */
  async step(label, fn) {
    const n = ++this.stepIndex;
    const started = Date.now();
    try {
      const out = await fn();
      console.log(`  ok ${n}. ${label} (${Date.now() - started}ms)`);
      return out;
    } catch (err) {
      console.log(`FAIL ${n}. ${label}: ${String(err).split('\n')[0]}`);
      this.failures.push({ step: n, label, error: String(err) });
      for (const c of this.clients) {
        await this.shot(c, `fail-step${n}-${c.name}`).catch(() => {});
      }
      throw err;
    }
  }

  async shot(c, tag) {
    const file = path.join(this.dir, `${String(this.stepIndex).padStart(2, '0')}-${tag}.png`);
    await c.page.screenshot({ path: file, fullPage: false });
    return file;
  }

  /** Dump the page accessibility tree (roles/names) for selector discovery. */
  async aria(c, tag) {
    const snap = await c.page.locator('body').ariaSnapshot();
    const file = path.join(this.dir, `${String(this.stepIndex).padStart(2, '0')}-${tag}.aria.yaml`);
    fs.writeFileSync(file, snap);
    return snap;
  }

  async finish() {
    for (const c of this.clients) {
      fs.writeFileSync(
        path.join(this.dir, `console-${c.name}.jsonl`),
        c.logs.map(l => JSON.stringify(l)).join('\n') + '\n',
      );
      const errors = c.logs.filter(l => l.kind === 'pageerror' || l.kind === 'error');
      if (errors.length) {
        console.log(`  [${c.name}] ${errors.length} console error(s) — see console-${c.name}.jsonl`);
      }
    }
    await this.browser?.close();
    if (this.failures.length) {
      console.log(`\n${this.name}: ${this.failures.length} FAILED step(s); evidence in ${this.dir}`);
      process.exitCode = 1;
    } else {
      console.log(`\n${this.name}: all steps passed; evidence in ${this.dir}`);
    }
  }
}

/**
 * Poll until fn() is truthy (default 15s). The interval bounds how precisely a
 * latency measured with this helper can be reported — keep it small enough that
 * the poll granularity is not mistaken for real cross-client delivery time.
 */
export async function until(fn, { timeout = 15000, interval = 25, what = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await fn();
      if (last) return last;
    } catch (err) {
      last = err;
    }
    await new Promise(r => setTimeout(r, interval));
  }
  throw new Error(`timeout waiting for ${what}: last=${String(last)}`);
}
