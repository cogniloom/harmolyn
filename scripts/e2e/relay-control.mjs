// Aether relay process control for infrastructure-loss scenarios.
//
// The relay's peer id is stable per data-dir and is BAKED into the app via
// .env.development (VITE_RELAY_PEER_ID / VITE_RELAY_MULTIADDR), so a scenario
// that owns the relay must reuse the ambient stack's data-dir:
//   RELAY_BIN       — path to the aether binary (e.g. ~/src/xorein/bin/aether)
//   RELAY_DATA_DIR  — the data-dir matching the baked peer id
import { spawn } from 'node:child_process';
import net from 'node:net';

export const RELAY_WS_PORT = 9999;
const RELAY_TCP_PORT = 9400;

export function relayEnv() {
  const bin = process.env.RELAY_BIN;
  const dataDir = process.env.RELAY_DATA_DIR;
  if (!bin || !dataDir) {
    throw new Error(
      'RELAY_BIN and RELAY_DATA_DIR must be set — this scenario owns the relay process. ' +
      'Use the same data-dir as the ambient stack so the peer id matches VITE_RELAY_PEER_ID.',
    );
  }
  return { bin, dataDir };
}

export function portOpen(port, timeoutMs = 800) {
  return new Promise(resolve => {
    const sock = net.connect({ host: '127.0.0.1', port });
    const done = (up) => { sock.destroy(); resolve(up); };
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
    sock.setTimeout(timeoutMs, () => done(false));
  });
}

export async function assertRelayPortFree() {
  if (await portOpen(RELAY_WS_PORT)) {
    throw new Error(
      `something already listens on :${RELAY_WS_PORT} — this scenario must own the relay. ` +
      'Stop the ambient aether relay and re-run.',
    );
  }
}

export async function startRelay({ log = () => {} } = {}) {
  const { bin, dataDir } = relayEnv();
  const child = spawn(bin, [
    '--role', 'relay',
    '--data-dir', dataDir,
    '--listen', `127.0.0.1:${RELAY_TCP_PORT}`,
    '--ws-listen', `127.0.0.1:${RELAY_WS_PORT}`,
    '--enable-mdns=false',
    '--enable-nat=false',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', d => log(`[relay] ${d}`.trimEnd()));
  child.stderr.on('data', d => log(`[relay!] ${d}`.trimEnd()));
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await portOpen(RELAY_WS_PORT, 300)) return child;
    if (child.exitCode !== null) throw new Error(`relay exited early with code ${child.exitCode}`);
    await new Promise(r => setTimeout(r, 150));
  }
  child.kill('SIGKILL');
  throw new Error('relay WS port did not open within 15s');
}

export async function stopRelay(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGKILL');
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (!(await portOpen(RELAY_WS_PORT, 300))) return;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('relay WS port still open after SIGKILL');
}
