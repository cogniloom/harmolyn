// Real two-browser WebRTC/TURN smoke test.
//
// Start a relay/archivist Xorein node first, then run:
//   VOICE_NODE_ENDPOINT=http://127.0.0.1:7711 npm run test:voice:e2e
//
// The two peers live in isolated Chromium contexts. Signaling is exchanged by
// this harness, while ICE is forced to `relay`, so a pass requires an actual
// allocation through Xorein's embedded TURN service. Fake audio devices keep
// the test deterministic and suitable for a headless runner.

import path from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';

const ROOT = process.cwd();
const EVIDENCE_DIR = path.resolve(ROOT, '.generated/voice-e2e');
const NODE_ENDPOINT = normalizeEndpoint(process.env.VOICE_NODE_ENDPOINT ?? 'http://127.0.0.1:7711');
const CREDENTIAL_URL = `${NODE_ENDPOINT}/v1/voice/turn-credentials`;
const TURN_TRANSPORT = String(process.env.VOICE_TURN_TRANSPORT ?? 'auto').trim().toLowerCase();
if (!['auto', 'udp', 'tcp', 'tls'].includes(TURN_TRANSPORT)) {
  throw new Error(`Invalid VOICE_TURN_TRANSPORT: ${TURN_TRANSPORT}`);
}

function normalizeEndpoint(value) {
  const raw = String(value).trim();
  const parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`);
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) {
    throw new Error(`Invalid VOICE_NODE_ENDPOINT: ${value}`);
  }
  return parsed.origin;
}

function resolveChromeExecutable() {
  const candidates = [
    process.env.PLAYWRIGHT_CHROME_PATH,
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  try {
    const managed = chromium.executablePath();
    if (managed && existsSync(managed)) return managed;
  } catch {
    // The launch below provides the actionable missing-browser error.
  }
  return undefined;
}

async function waitForIceGathering(page) {
  // A multi-homed Chromium instance can keep gathering while unusable DNS/interface
  // paths time out even after TURN has already produced a relay candidate. The smoke
  // is relay-only, so one relay candidate embedded in the current SDP is the useful
  // readiness signal; waiting for every unrelated path to finish makes a healthy
  // public TURN service look broken.
  await page.waitForFunction(() => {
    const pc = window.__voiceE2E?.pc;
    return pc?.iceGatheringState === 'complete'
      || /\styp\srelay(?:\s|$)/m.test(pc?.localDescription?.sdp ?? '');
  }, null, { timeout: 20_000 });
}

async function initialisePeer(page, credentialUrl, initiator) {
  return page.evaluate(async ({ url, isInitiator, requiredTransport }) => {
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) throw new Error(`TURN credentials returned HTTP ${response.status}`);
    const credentials = await response.json();
    if (!Array.isArray(credentials.urls) || !credentials.urls.some(value => /^turns?:/.test(String(value)))) {
      throw new Error('Xorein returned no TURN URL');
    }
    if (!credentials.username || !credentials.credential) {
      throw new Error('Xorein returned incomplete TURN credentials');
    }

    const selectedUrls = credentials.urls.filter(value => {
      const candidate = String(value);
      if (requiredTransport === 'auto') return candidate.startsWith('turn:') || candidate.startsWith('turns:');
      if (requiredTransport === 'udp') return candidate.startsWith('turn:') && candidate.includes('transport=udp');
      if (requiredTransport === 'tcp') return candidate.startsWith('turn:') && candidate.includes('transport=tcp');
      return candidate.startsWith('turns:');
    });
    if (!selectedUrls.length) throw new Error(`Xorein returned no ${requiredTransport} TURN URL`);

    const pc = new RTCPeerConnection({
      iceServers: [{
        urls: selectedUrls,
        username: credentials.username,
        credential: credentials.credential,
      }],
      iceTransportPolicy: 'relay',
    });
    const state = {
      pc,
      localCandidateTypes: [],
      iceErrors: [],
      remoteAudioTracks: 0,
      received: [],
      dataChannel: null,
    };
    window.__voiceE2E = state;
    pc.onicecandidate = event => {
      if (!event.candidate) return;
      const match = event.candidate.candidate.match(/\styp\s(\w+)/);
      state.localCandidateTypes.push(event.candidate.type || match?.[1] || 'unknown');
    };
    pc.onicecandidateerror = event => {
      state.iceErrors.push({
        code: event.errorCode,
        text: event.errorText,
        url: event.url,
      });
    };
    pc.ontrack = event => {
      if (event.track.kind === 'audio') state.remoteAudioTracks += 1;
    };
    pc.ondatachannel = event => {
      state.dataChannel = event.channel;
      event.channel.onmessage = message => state.received.push(String(message.data));
    };

    const media = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    state.media = media;
    for (const track of media.getTracks()) pc.addTrack(track, media);
    if (isInitiator) {
      state.dataChannel = pc.createDataChannel('harmolyn-turn-e2e');
    }
    return { urls: selectedUrls, ttlSeconds: credentials.ttl_seconds };
  }, { url: credentialUrl, isInitiator: initiator, requiredTransport: TURN_TRANSPORT });
}

async function selectedCandidateType(page) {
  return page.evaluate(async () => {
    const stats = await window.__voiceE2E.pc.getStats();
    for (const report of stats.values()) {
      if (report.type !== 'candidate-pair' || report.state !== 'succeeded' || !report.nominated) continue;
      const local = stats.get(report.localCandidateId);
      if (local) return local.candidateType || 'unknown';
    }
    return 'unknown';
  });
}

async function inboundAudioStats(page) {
  return page.evaluate(async () => {
    const stats = await window.__voiceE2E.pc.getStats();
    let packetsReceived = 0;
    let bytesReceived = 0;
    for (const report of stats.values()) {
      if (report.type !== 'inbound-rtp' || (report.kind ?? report.mediaType) !== 'audio') continue;
      packetsReceived += Number(report.packetsReceived ?? 0);
      bytesReceived += Number(report.bytesReceived ?? 0);
    }
    return { packetsReceived, bytesReceived };
  });
}

async function waitForInboundAudio(page) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const stats = await inboundAudioStats(page);
    if (stats.packetsReceived > 0 && stats.bytesReceived > 0) return stats;
    await page.waitForTimeout(100);
  }
  throw new Error('Timed out waiting for inbound audio RTP packets');
}

async function closePeer(page) {
  await page.evaluate(() => {
    const state = window.__voiceE2E;
    state?.dataChannel?.close();
    state?.media?.getTracks().forEach(track => track.stop());
    state?.pc?.close();
  }).catch(() => {});
}

await mkdir(EVIDENCE_DIR, { recursive: true });
const report = [
  'Harmolyn two-browser TURN E2E',
  `Node: ${NODE_ENDPOINT}`,
  `Transport: ${TURN_TRANSPORT}`,
];
let exitCode = 0;
let viteServer;
let browser;
let contextA;
let contextB;
let pageA;
let pageB;

try {
  viteServer = await createServer({
    root: ROOT,
    server: { host: '127.0.0.1', port: 0, strictPort: false },
    logLevel: 'error',
  });
  await viteServer.listen();
  const address = viteServer.httpServer?.address();
  if (!address || typeof address === 'string') throw new Error('Vite did not expose a TCP test address');
  const testUrl = `http://127.0.0.1:${address.port}/p0-test.html`;

  browser = await chromium.launch({
    headless: true,
    executablePath: resolveChromeExecutable(),
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
    ],
  });
  contextA = await browser.newContext({ permissions: ['microphone'] });
  contextB = await browser.newContext({ permissions: ['microphone'] });
  pageA = await contextA.newPage();
  pageB = await contextB.newPage();
  await Promise.all([pageA.goto(testUrl), pageB.goto(testUrl)]);

  const [credentialsA, credentialsB] = await Promise.all([
    initialisePeer(pageA, CREDENTIAL_URL, true),
    initialisePeer(pageB, CREDENTIAL_URL, false),
  ]);
  report.push(`PASS credentials: A=${credentialsA.urls.join(',')} B=${credentialsB.urls.join(',')}`);

  const offer = await pageA.evaluate(async () => {
    const pc = window.__voiceE2E.pc;
    await pc.setLocalDescription(await pc.createOffer());
    return pc.localDescription.toJSON();
  });
  await waitForIceGathering(pageA);
  const gatheredOffer = await pageA.evaluate(() => window.__voiceE2E.pc.localDescription.toJSON());

  await pageB.evaluate(async remoteOffer => {
    const pc = window.__voiceE2E.pc;
    await pc.setRemoteDescription(remoteOffer);
    await pc.setLocalDescription(await pc.createAnswer());
  }, gatheredOffer ?? offer);
  await waitForIceGathering(pageB);
  const answer = await pageB.evaluate(() => window.__voiceE2E.pc.localDescription.toJSON());
  await pageA.evaluate(remoteAnswer => window.__voiceE2E.pc.setRemoteDescription(remoteAnswer), answer);

  await Promise.all([
    pageA.waitForFunction(() => {
      const state = window.__voiceE2E;
      return state.pc.connectionState === 'connected' && state.dataChannel?.readyState === 'open' && state.remoteAudioTracks > 0;
    }, null, { timeout: 30_000 }),
    pageB.waitForFunction(() => {
      const state = window.__voiceE2E;
      return state.pc.connectionState === 'connected' && state.dataChannel?.readyState === 'open' && state.remoteAudioTracks > 0;
    }, null, { timeout: 30_000 }),
  ]);
  const [audioA, audioB] = await Promise.all([waitForInboundAudio(pageA), waitForInboundAudio(pageB)]);

  const marker = `turn-e2e-${Date.now()}`;
  await pageA.evaluate(value => window.__voiceE2E.dataChannel.send(value), marker);
  await pageB.waitForFunction(value => window.__voiceE2E.received.includes(value), marker, { timeout: 10_000 });

  const [stateA, stateB, selectedA, selectedB] = await Promise.all([
    pageA.evaluate(() => ({ candidateTypes: window.__voiceE2E.localCandidateTypes, remoteAudioTracks: window.__voiceE2E.remoteAudioTracks })),
    pageB.evaluate(() => ({ candidateTypes: window.__voiceE2E.localCandidateTypes, remoteAudioTracks: window.__voiceE2E.remoteAudioTracks })),
    selectedCandidateType(pageA),
    selectedCandidateType(pageB),
  ]);
  if (!stateA.candidateTypes.includes('relay') || !stateB.candidateTypes.includes('relay')) {
    throw new Error(`relay-only ICE gathered no relay candidate: A=${stateA.candidateTypes} B=${stateB.candidateTypes}`);
  }
  if (selectedA !== 'relay' || selectedB !== 'relay') {
    throw new Error(`selected ICE pair was not TURN-relayed: A=${selectedA} B=${selectedB}`);
  }
  report.push(`PASS relay ICE: selected A=${selectedA}, B=${selectedB}`);
  report.push(`PASS media: remote audio tracks A=${stateA.remoteAudioTracks}, B=${stateB.remoteAudioTracks}; inbound RTP A=${audioA.packetsReceived} packets/${audioA.bytesReceived} bytes, B=${audioB.packetsReceived} packets/${audioB.bytesReceived} bytes`);
  report.push('PASS data: isolated browser B received browser A marker');
  report.push('RESULT: PASS');
} catch (error) {
  exitCode = 1;
  const detail = error instanceof Error ? (error.stack || error.message) : String(error);
  const iceDebug = await Promise.all([pageA, pageB].map(async page => {
    if (!page) return null;
    return page.evaluate(() => {
      const state = window.__voiceE2E;
      return state ? {
        connectionState: state.pc.connectionState,
        iceConnectionState: state.pc.iceConnectionState,
        iceGatheringState: state.pc.iceGatheringState,
        candidateTypes: state.localCandidateTypes,
        iceErrors: state.iceErrors,
      } : null;
    }).catch(() => null);
  }));
  report.push(`ICE DEBUG: ${JSON.stringify(iceDebug)}`);
  report.push(`RESULT: FAIL\n${detail}`);
} finally {
  if (pageA) await closePeer(pageA);
  if (pageB) await closePeer(pageB);
  await contextA?.close().catch(() => {});
  await contextB?.close().catch(() => {});
  await browser?.close().catch(() => {});
  await viteServer?.close().catch(() => {});
  await writeFile(path.join(EVIDENCE_DIR, 'voice-turn-e2e.txt'), `${report.join('\n')}\n`, 'utf8');
}

console.log(report.join('\n'));
process.exitCode = exitCode;
