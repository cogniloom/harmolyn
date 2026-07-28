// Minimal browser boot smoke for CI.
//
// The full multi-step happy-path harness (browser-smoke.mjs) drives the app against an
// injected HTTP runtime snapshot — a model that predates the native-engine-default
// architecture and needs a separate rework. This CI smoke instead validates the single
// most important thing a browser check must guarantee: the production Vite build actually
// loads and renders the app shell in a real (headless Chromium) browser, with no uncaught
// runtime exception. It needs no privileged install (Chromium is provided via
// PLAYWRIGHT_CHROME_PATH or a Playwright-managed browser) and no network.
import path from 'path';
import { existsSync } from 'fs';
import { mkdir } from 'fs/promises';
import { preview } from 'vite';
import { chromium } from 'playwright-core';

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
  try {
    const managed = chromium.executablePath();
    if (managed && existsSync(managed)) return managed;
  } catch { /* no managed browser available */ }
  return undefined;
}

const ROOT = process.cwd();
const EVIDENCE_DIR = path.resolve(ROOT, '.sisyphus/evidence');
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

const executablePath = resolveChromeExecutable();
if (!executablePath) {
  console.error('browser-ci-smoke: no Chromium executable found (set PLAYWRIGHT_CHROME_PATH or install one).');
  await viteServer.close();
  process.exitCode = 1;
} else {
  const browser = await chromium.launch({ headless: true, executablePath });
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
