// Minimal browser boot smoke for CI.
//
// The full multi-step happy-path harness (browser-smoke.mjs) drives the app against an
// injected HTTP runtime snapshot — a model that predates the native-engine-default
// architecture and needs a separate rework. This CI smoke instead validates the single
// most important thing a browser check must guarantee: the production Vite build actually
// loads and renders the app shell in a real (headless Chromium) browser, with no uncaught
// runtime exception. It needs no privileged install (Chromium is provided via
// PLAYWRIGHT_CHROME_PATH or a Playwright-managed browser). CI sets
// HARMOLYN_REQUIRE_BROWSER=1, so an unavailable browser is a failed required
// check rather than a misleading green skip.
import path from 'path';
import os from 'os';
import { existsSync, readdirSync } from 'fs';
import { mkdir } from 'fs/promises';
import { preview } from 'vite';
import { chromium } from 'playwright-core';

// Glob a Playwright browsers root for any installed Chromium/headless-shell binary,
// version-independent. Runner images differ (some ship /opt/pw-browsers, some install into
// ~/.cache/ms-playwright), and the installed revision may not match this project's
// playwright-core (so chromium.executablePath() can point at a path that doesn't exist).
// Matching by directory prefix avoids that version drift.
function findInBrowsersRoot(root) {
  if (!root || !existsSync(root)) return undefined;
  let entries;
  try { entries = readdirSync(root); } catch { return undefined; }
  const candidates = [];
  for (const name of entries) {
    // Newer Playwright revisions ship the binary under chrome-linux64/, older under chrome-linux/.
    if (name.startsWith('chromium-')) {
      candidates.push(path.join(root, name, 'chrome-linux', 'chrome'));
      candidates.push(path.join(root, name, 'chrome-linux64', 'chrome'));
    }
    // headless_shell is fully launchable in headless mode, which this smoke uses.
    if (name.startsWith('chromium_headless_shell-')) {
      candidates.push(path.join(root, name, 'chrome-linux', 'headless_shell'));
      candidates.push(path.join(root, name, 'chrome-linux64', 'headless_shell'));
    }
  }
  // Prefer full chromium over the headless shell when both are present.
  candidates.sort((a, b) => (a.includes('headless_shell') ? 1 : 0) - (b.includes('headless_shell') ? 1 : 0));
  return candidates.find(existsSync);
}

function resolveChromeExecutable() {
  const explicit = [
    process.env.PLAYWRIGHT_CHROME_PATH,
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  for (const candidate of explicit) {
    if (existsSync(candidate)) return candidate;
  }
  // Playwright-managed browser matching THIS project's playwright-core (best case).
  try {
    const managed = chromium.executablePath();
    if (managed && existsSync(managed)) return managed;
  } catch { /* no managed browser available */ }
  // Otherwise glob the standard install roots for any installed build.
  const roots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    '/opt/pw-browsers',
    path.join(os.homedir(), '.cache', 'ms-playwright'),
  ].filter(Boolean);
  for (const root of roots) {
    const found = findInBrowsersRoot(root);
    if (found) return found;
  }
  return undefined;
}

const ROOT = process.cwd();
const EVIDENCE_DIR = path.resolve(ROOT, '.generated/browser-evidence');
await mkdir(EVIDENCE_DIR, { recursive: true });

if (!existsSync(path.join(ROOT, 'dist', 'index.html'))) {
  console.error('browser-ci-smoke: dist/index.html not found — run `npm run build` before this smoke.');
  process.exit(1);
}

// Serve the PRODUCTION build (dist/) via Vite preview, not the dev server, so the smoke
// exercises the real Rollup output, build-time defines, base-path handling, and
// service-worker registration — the things a dev-server run would miss.
const viteServer = await preview({
  root: ROOT,
  preview: { host: '127.0.0.1', port: 0, strictPort: false },
  logLevel: 'error',
});
const address = viteServer.httpServer?.address();
const port = typeof address === 'object' && address ? address.port : 0;
const baseUrl = viteServer.resolvedUrls?.local?.[0] ?? `http://127.0.0.1:${port}`;

// A local developer machine may omit Chromium and receive an explicit skip. Required CI
// sets HARMOLYN_REQUIRE_BROWSER=1, making missing binaries, libraries, or sandbox support
// a hard failure. A browser that launches also fails on genuine application errors.
function isEnvironmentLaunchError(message) {
  return (
    /cannot open shared object file/i.test(message) ||   // missing libnspr4.so / libnss3 etc.
    /error while loading shared libraries/i.test(message) ||
    /executable doesn't exist/i.test(message) ||
    /No usable sandbox/i.test(message) ||
    /Failed to launch/i.test(message) ||
    /ENOENT/i.test(message) ||
    /spawn .* EACCES/i.test(message)
  );
}

function unavailableBrowser(reason) {
  if (process.env.HARMOLYN_REQUIRE_BROWSER === '1') {
    console.error(`::error title=Browser smoke unavailable::${reason}`);
    console.error(`browser-ci-smoke: FAIL — ${reason}`);
    return 1;
  }
  console.log(`::notice title=Browser smoke skipped::${reason}`);
  console.log(`browser-ci-smoke: SKIP — ${reason}`);
  return 0;
}

const executablePath = resolveChromeExecutable();
let browser;
if (!executablePath) {
  const unavailableCode = unavailableBrowser('no Chromium executable available on this runner (set PLAYWRIGHT_CHROME_PATH or install one to run the smoke).');
  await viteServer.close();
  process.exitCode = unavailableCode;
} else {
  try {
    browser = await chromium.launch({ headless: true, executablePath });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await viteServer.close();
    if (isEnvironmentLaunchError(message)) {
      process.exitCode = unavailableBrowser(`Chromium could not launch on this runner (${message.split('\n')[0]}).`);
    } else {
      console.error(error instanceof Error ? error.stack || error.message : message);
      process.exitCode = 1;
    }
  }
}

if (browser) {
  const pageErrors = [];
  let exitCode = 0;
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on('pageerror', (err) => pageErrors.push(err.message));
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });

    // The app shell has mounted once the React root has real content. We assert on the
    // rendered text rather than a brittle single string so ordinary copy changes don't
    // break the smoke: the boot shell always surfaces the product and network names.
    await page.waitForFunction(() => {
      const root = document.getElementById('root');
      return !!root && /HARMOLYN/i.test(root.innerText);
    }, { timeout: 45000 });

    const bodyText = (await page.locator('body').innerText()).toUpperCase();
    const markers = ['HARMOLYN', 'XOREIN'];
    const missing = markers.filter((m) => !bodyText.includes(m));

    await page.screenshot({ path: path.join(EVIDENCE_DIR, 'ci-boot-smoke.png'), fullPage: true });

    if (missing.length) {
      console.error(`browser-ci-smoke: app shell rendered but expected markers missing: ${missing.join(', ')}`);
      console.error(bodyText.replace(/\s+/g, ' ').slice(0, 400));
      exitCode = 1;
    } else if (pageErrors.length) {
      console.error(`browser-ci-smoke: app rendered but raised uncaught errors:\n${pageErrors.join('\n')}`);
      exitCode = 1;
    } else {
      console.log('browser-ci-smoke: PASS — production build booted and rendered the app shell in Chromium.');
    }
    await context.close();
  } catch (error) {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    if (pageErrors.length) console.error(`Uncaught page errors:\n${pageErrors.join('\n')}`);
    exitCode = 1;
  } finally {
    await browser.close();
    await viteServer.close();
  }
  process.exitCode = exitCode;
}
