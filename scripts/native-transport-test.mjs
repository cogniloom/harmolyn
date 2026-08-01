// Stage 1 transport proof — two browser tabs exchange an authenticated message
// through the live circuit relay (node.xorein.com:9999/wss).
//
// Tests:
//   T1: both tabs obtain a circuit reservation (proves transport + relay connectivity)
//   T2: browser-to-browser PeerStream echo via circuit relay (proves B2B messaging)
//
// Requires: live internet access to node.xorein.com

import path from 'path';
import { existsSync } from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';

const ROOT = process.cwd();
const EVIDENCE_DIR = path.resolve(ROOT, '.generated/browser-evidence');
const ECHO_PROTO = '/xorein/echo-test/1.0.0';
const RELAY_TIMEOUT_MS = 20_000; // 20s to get a circuit reservation
const POLL_INTERVAL_MS = 500;

await mkdir(EVIDENCE_DIR, { recursive: true });

function resolveChromeExecutable() {
  const candidates = [
    process.env.PLAYWRIGHT_CHROME_PATH,
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  try {
    const managed = chromium.executablePath();
    if (managed && existsSync(managed)) return managed;
  } catch { /* fall through */ }
  return undefined;
}

const viteServer = await createServer({
  root: ROOT,
  server: { host: '127.0.0.1', port: 0, strictPort: false },
  logLevel: 'error',
});
await viteServer.listen();
const address = viteServer.httpServer?.address();
const port = typeof address === 'object' && address ? address.port : 8080;
const baseUrl = `http://127.0.0.1:${port}`;
const testUrl = `${baseUrl}/p0-test.html`;

const browser = await chromium.launch({
  headless: true,
  executablePath: resolveChromeExecutable(),
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

let exitCode = 0;
const lines = [];

try {
  const report = await runTransportTests(browser, testUrl);
  lines.push(...report);
  console.log(report.join('\n'));
} catch (err) {
  const msg = err instanceof Error ? (err.stack || err.message) : String(err);
  console.error('FAIL:', msg);
  lines.push('FAIL: ' + msg);
  exitCode = 1;
} finally {
  await browser.close();
  await viteServer.close();
  await writeFile(path.join(EVIDENCE_DIR, 'native-transport-test.txt'), lines.join('\n'), 'utf8');
}

process.exitCode = exitCode;

// ── Test runner ───────────────────────────────────────────────────────────────

async function runTransportTests(browserInstance, url) {
  const report = ['xorein native transport test — Stage 1', `Relay: node.xorein.com:9999/wss`, ''];

  // ── T1: circuit reservation ─────────────────────────────────────────────────
  const ctxA = await browserInstance.newContext({ viewport: { width: 800, height: 600 } });
  const ctxB = await browserInstance.newContext({ viewport: { width: 800, height: 600 } });
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  await pageA.goto(url);
  await pageB.goto(url);

  // Wait for both pages to load __p0
  await Promise.all([
    pageA.waitForFunction(() => typeof window.__p0?.createNode === 'function', { timeout: 10_000 }),
    pageB.waitForFunction(() => typeof window.__p0?.createNode === 'function', { timeout: 10_000 }),
  ]);

  // Tab A: start node, register PeerStream echo handler, wait for circuit addr.
  const circuitAddrA = await pageA.evaluate(
    async ({ echoProto, timeoutMs, pollMs }) => {
      const { createNode, circuitAddrs, frameMessage, unframeMessage,
              decodePeerStreamRequest, encodePeerStreamResponse } = window.__p0;

      const node = await createNode();
      window.__p0.node = node;
      window.__p0.lastHandlerError = null;

      // PeerStream echo handler: decode request → echo payload back as a proper response.
      // libp2p v3 StreamHandler: (stream, connection) — NOT ({ stream }).
      await node.handle(
        echoProto,
        async (stream) => {
          try {
            // Collect all inbound chunks into a single Uint8Array.
            const chunks = [];
            for await (const chunk of stream) {
              if (chunk instanceof Uint8Array) chunks.push(chunk);
              else chunks.push(chunk.subarray()); // Uint8ArrayList → Uint8Array
            }
            let raw;
            if (chunks.length === 1) {
              raw = chunks[0];
            } else {
              const total = new Uint8Array(chunks.reduce((s, c) => s + c.length, 0));
              let off = 0;
              for (const c of chunks) { total.set(c, off); off += c.length; }
              raw = total;
            }

            // Unframe the 4-byte length prefix, then decode the PeerStreamRequest.
            const msg = unframeMessage(raw);
            const req = msg ? decodePeerStreamRequest(msg) : { operation: '', requestId: undefined };
            const payload = req.payload ?? new TextEncoder().encode('NO_PAYLOAD');

            // Send back a properly-encoded PeerStreamResponse (field 4 = payload).
            const respBytes = encodePeerStreamResponse({ payload, requestId: req.requestId });
            stream.send(frameMessage(respBytes));
            await stream.close();
          } catch (err) {
            window.__p0.lastHandlerError = (err?.message || String(err)) + '\n' + (err?.stack || '');
            stream.abort(err instanceof Error ? err : new Error(String(err)));
          }
        },
        { runOnLimitedConnection: true },
      );

      // Wait for circuit reservation.
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, pollMs));
        const addrs = circuitAddrs(node);
        if (addrs.length > 0) return addrs[0];
      }
      throw new Error(`Tab A: no circuit reservation after ${timeoutMs}ms`);
    },
    { echoProto: ECHO_PROTO, timeoutMs: RELAY_TIMEOUT_MS, pollMs: POLL_INTERVAL_MS },
  );
  report.push(`T1a PASS — Tab A circuit addr: ${circuitAddrA}`);

  // Tab B: start node, wait for own circuit reservation.
  const circuitAddrB = await pageB.evaluate(
    async ({ timeoutMs, pollMs }) => {
      const { createNode, circuitAddrs } = window.__p0;
      const node = await createNode();
      window.__p0.node = node;
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, pollMs));
        const addrs = circuitAddrs(node);
        if (addrs.length > 0) return addrs[0];
      }
      throw new Error(`Tab B: no circuit reservation after ${timeoutMs}ms`);
    },
    { timeoutMs: RELAY_TIMEOUT_MS, pollMs: POLL_INTERVAL_MS },
  );
  report.push(`T1b PASS — Tab B circuit addr: ${circuitAddrB}`);

  // ── T2: ping service (proves B2B connectivity without custom handler) ─────────
  const rttMs = await pageB.evaluate(
    async ({ addrA, timeoutMs }) => {
      const { multiaddr } = window.__p0;
      const node = window.__p0.node;
      if (!node) throw new Error('Tab B: node not started');
      const ma = multiaddr(addrA);
      const rtt = await node.services.ping.ping(ma, { signal: AbortSignal.timeout(timeoutMs) });
      return rtt;
    },
    { addrA: circuitAddrA, timeoutMs: 10_000 },
  );
  report.push(`T2 PASS — ping RTT via circuit relay: ${rttMs}ms`);

  // ── T2a: raw byte echo (transport sanity) ────────────────────────────────────
  // Register a simple raw echo handler on Tab A to isolate transport from PeerStream.
  await pageA.evaluate(async ({ rawProto }) => {
    const node = window.__p0.node;
    window.__p0.lastRawHandlerError = null;
    // libp2p v3 StreamHandler: (stream, connection) — NOT ({ stream }).
    await node.handle(
      rawProto,
      async (stream) => {
        try {
          const chunks = [];
          for await (const chunk of stream) {
            chunks.push(chunk instanceof Uint8Array ? chunk : chunk.subarray());
          }
          for (const c of chunks) stream.send(c);
          await stream.close();
        } catch (err) {
          window.__p0.lastRawHandlerError = err?.message || String(err);
          stream.abort(err instanceof Error ? err : new Error(String(err)));
        }
      },
      { runOnLimitedConnection: true },
    );
  }, { rawProto: '/xorein/raw-echo-test/1.0.0' });

  let rawResult;
  try {
    rawResult = await pageB.evaluate(
      async ({ addrA, rawProto, testMsg }) => {
        const { multiaddr } = window.__p0;
        const node = window.__p0.node;
        if (!node) throw new Error('Tab B: node not started');
        const ma = multiaddr(addrA);
        const stream = await node.dialProtocol(ma, rawProto, { runOnLimitedConnection: true });
        const msg = new TextEncoder().encode(testMsg);
        stream.send(msg);
        await stream.sendCloseWrite();
        const chunks = [];
        for await (const chunk of stream) {
          chunks.push(chunk instanceof Uint8Array ? chunk : chunk.subarray());
        }
        const total = new Uint8Array(chunks.reduce((s, c) => s + c.length, 0));
        let off = 0; for (const c of chunks) { total.set(c, off); off += c.length; }
        return new TextDecoder().decode(total);
      },
      { addrA: circuitAddrA, rawProto: '/xorein/raw-echo-test/1.0.0', testMsg: 'raw-ping' },
    );
  } catch (err) {
    const handlerErr = await pageA.evaluate(() => window.__p0?.lastRawHandlerError ?? 'none captured').catch(() => 'eval failed');
    throw new Error(`T2a FAIL: ${err.message}\nTab A raw handler error: ${handlerErr}`);
  }
  if (rawResult !== 'raw-ping') throw new Error(`T2a FAIL: raw echo got '${rawResult}'`);
  report.push(`T2a PASS — raw byte echo: '${rawResult}'`);

  // ── T2b: browser-to-browser PeerStream echo via circuit relay ─────────────────
  const testPayload = 'stage-1-ping';
  let echoResult;
  try {
    echoResult = await pageB.evaluate(
      async ({ addrA, echoProto, testMsg }) => {
        const { callFamily, multiaddr } = window.__p0;
        const node = window.__p0.node;
        if (!node) throw new Error('Tab B: node not started');

        const ma = multiaddr(addrA);
        const resp = await callFamily(
          node, ma, echoProto, 'echo',
          new TextEncoder().encode(testMsg),
          'echo-req-1',
        );

        if (resp.error) throw new Error(`PeerStream error: ${resp.error.message}`);
        if (!resp.payload) throw new Error('PeerStream: no payload in response');
        return new TextDecoder().decode(resp.payload);
      },
      { addrA: circuitAddrA, echoProto: ECHO_PROTO, testMsg: testPayload },
    );
  } catch (err) {
    // Retrieve handler-side error from Tab A for diagnosis.
    const handlerErr = await pageA.evaluate(() => window.__p0.lastHandlerError ?? 'none');
    throw new Error(`T2b FAIL: ${err.message}\nTab A handler error: ${handlerErr}`);
  }

  if (echoResult !== testPayload) {
    throw new Error(`T2b FAIL: expected '${testPayload}', got '${echoResult}'`);
  }
  report.push(`T2b PASS — B→A PeerStream echo: '${echoResult}'`);

  await ctxA.close();
  await ctxB.close();

  report.push('', 'All transport tests passed.');
  return report;
}
