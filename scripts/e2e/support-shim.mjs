// Support-node (shim) process control for offline-resilience scenarios.
//
// Most scenarios treat the local stack (relay + shim + vite) as ambient
// prerequisites. Scenarios that KILL infrastructure mid-run must own the
// process instead: these helpers spawn scripts/local-support-node.mjs as a
// child on :7711 (the port baked into .env.development's
// VITE_XOREIN_CONTROL_ENDPOINT, so it cannot be moved per-scenario) and
// stop/restart it on demand.
//
// Preflight contract: if something already answers on the port, the scenario
// cannot control it — fail loudly with instructions rather than sharing.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const SHIM_PORT = Number(process.env.SUPPORT_NODE_PORT ?? 7711);
const BASE = `http://127.0.0.1:${SHIM_PORT}`;

export async function shimResponds(timeoutMs = 1500) {
  try {
    const res = await fetch(`${BASE}/v1/state`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function assertPortFree() {
  if (await shimResponds()) {
    throw new Error(
      `something already serves ${BASE} — this scenario must own the support shim. ` +
      'Stop the ambient local-support-node.mjs and re-run.',
    );
  }
}

/**
 * Spawn the shim. Relay proxy args come from the ambient stack's env
 * (RELAY_WS_MULTIADDR / RELAY_DATA_DIR), matching how the shim is normally run.
 * dataDir should live under the scenario's evidence dir so audits/blobs are
 * inspectable per-run and restarts (same dir) preserve blob storage.
 */
export async function startShim({ dataDir, log = () => {} }) {
  const args = [path.join(SCRIPTS_DIR, 'local-support-node.mjs'), '--port', String(SHIM_PORT), '--data-dir', dataDir];
  if (process.env.RELAY_WS_MULTIADDR) args.push('--relay-ws', process.env.RELAY_WS_MULTIADDR);
  if (process.env.RELAY_DATA_DIR) args.push('--relay-data', process.env.RELAY_DATA_DIR);
  const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', d => log(`[shim] ${d}`.trimEnd()));
  child.stderr.on('data', d => log(`[shim!] ${d}`.trimEnd()));
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await shimResponds(500)) return child;
    if (child.exitCode !== null) throw new Error(`shim exited early with code ${child.exitCode}`);
    await new Promise(r => setTimeout(r, 100));
  }
  child.kill('SIGKILL');
  throw new Error('shim did not become healthy within 10s');
}

/** Kill the shim and wait until the port actually stops answering. */
export async function stopShim(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGKILL');
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (!(await shimResponds(400))) return;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('shim port still answering after SIGKILL');
}
