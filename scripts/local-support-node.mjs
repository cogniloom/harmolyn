// Local xorein support node for development and E2E testing.
//
// Fronts a local `aether --role relay` the way the hosted node.xorein.com deployment
// fronts the production relay: terminates HTTP for the browser client (CORS), serves
// the support-service endpoints that live outside the aether repo (blob uploads,
// offline mailbox, relay address list), and proxies rendezvous to the relay's
// control API (Unix socket + bearer token).
//
// Zero-knowledge by construction: everything stored here is opaque ciphertext the
// browser encrypted client-side. Every request is appended to DATA_DIR/requests.jsonl
// so a security audit can verify no plaintext ever reaches the support node.
//
// Usage:
//   node scripts/local-support-node.mjs \
//     --port 7711 \
//     --relay-ws /ip4/127.0.0.1/tcp/9999/ws/p2p/<relay-peer-id> \
//     --relay-data <aether relay --data-dir> \
//     --data-dir <where to keep blobs/mailboxes/logs>
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const PORT = Number(arg('port', process.env.PORT ?? '7711'));
const RELAY_WS = arg('relay-ws', process.env.RELAY_WS_MULTIADDR ?? '');
const RELAY_DATA = arg('relay-data', process.env.RELAY_DATA_DIR ?? '');
const DATA_DIR = arg('data-dir', process.env.DATA_DIR ?? path.join(os.tmpdir(), 'harmolyn-local-support-node'));

fs.mkdirSync(path.join(DATA_DIR, 'blobs'), { recursive: true });
const requestLog = fs.createWriteStream(path.join(DATA_DIR, 'requests.jsonl'), { flags: 'a' });

// Relay control-API proxy config (rendezvous lives on the aether relay).
let controlSocket = '';
let controlToken = '';
if (RELAY_DATA) {
  try {
    controlToken = fs.readFileSync(path.join(RELAY_DATA, 'control.token'), 'utf8').trim();
  } catch { /* token missing: proxy disabled */ }
  const sockInData = path.join(RELAY_DATA, 'xorein-control.sock');
  if (fs.existsSync(sockInData)) {
    controlSocket = sockInData;
  } else {
    // Long data-dir paths overflow sockaddr_un; aether falls back to /tmp/xrn-*.sock.
    const candidates = fs.readdirSync('/tmp').filter(f => f.startsWith('xrn-') && f.endsWith('.sock'));
    if (candidates.length === 1) controlSocket = path.join('/tmp', candidates[0]);
    else if (process.env.AETHER_CONTROL_SOCKET) controlSocket = process.env.AETHER_CONTROL_SOCKET;
  }
}

// In-memory mailbox: token -> [framed-b64url, ...]. Opaque ciphertext only.
const mailboxes = new Map();

function logRequest(req, bodyText, status) {
  requestLog.write(JSON.stringify({
    t: new Date().toISOString(),
    method: req.method,
    path: req.url,
    origin: req.headers.origin ?? null,
    status,
    body: bodyText ? bodyText.slice(0, 4096) : null,
  }) + '\n');
}

function cors(req, res) {
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
    res.setHeader('Access-Control-Max-Age', '600');
  }
}

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > 64 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function proxyToRelayControl(req, res, bodyBuf) {
  if (!controlSocket || !controlToken) {
    json(res, 502, { code: 'no_relay_control', message: 'relay control proxy not configured' });
    return;
  }
  const preq = http.request({
    socketPath: controlSocket,
    path: req.url,
    method: req.method,
    headers: {
      'Content-Type': req.headers['content-type'] ?? 'application/json',
      Authorization: `Bearer ${controlToken}`,
      Host: 'localhost',
    },
  }, pres => {
    const headers = { ...pres.headers };
    delete headers['access-control-allow-origin'];
    res.writeHead(pres.statusCode ?? 502, headers);
    pres.pipe(res);
  });
  preq.on('error', err => {
    json(res, 502, { code: 'relay_control_error', message: String(err) });
  });
  if (bodyBuf?.length) preq.write(bodyBuf);
  preq.end();
}

const server = http.createServer(async (req, res) => {
  cors(req, res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = url.pathname;
  let bodyBuf = Buffer.alloc(0);
  if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
    try {
      bodyBuf = await readBody(req);
    } catch {
      json(res, 413, { code: 'too_large', message: 'body too large' });
      return;
    }
  }
  const bodyText = bodyBuf.length ? bodyBuf.toString('utf8') : '';

  const done = (status, value) => {
    logRequest(req, bodyText, status);
    json(res, status, value);
  };

  try {
    // ── Minimal runtime state: browser treats a 200 structured JSON as "node online".
    if (p === '/v1/state' && req.method === 'GET') {
      return done(200, { status: 'ok', control_endpoint: `http://127.0.0.1:${PORT}` });
    }

    // ── SSE event stream: keepalive only (native engine owns live data).
    if (p === '/v1/events') {
      logRequest(req, '', 200);
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write('retry: 5000\n\n');
      const iv = setInterval(() => res.write(': ping\n\n'), 15000);
      req.on('close', () => clearInterval(iv));
      return;
    }

    // ── Relay discovery: hand browsers the local relay's WS multiaddr.
    if (p === '/v1/relay/addrs' && req.method === 'GET') {
      return done(200, { addrs: RELAY_WS ? [RELAY_WS] : [] });
    }

    // ── Blob storage (opaque ciphertext, content-addressed by upload id).
    if (p === '/v1/uploads' && req.method === 'POST') {
      let parsed;
      try { parsed = JSON.parse(bodyText); } catch { return done(400, { code: 'bad_json' }); }
      if (typeof parsed?.data !== 'string') return done(400, { code: 'missing_data' });
      const id = crypto.randomBytes(16).toString('hex');
      fs.writeFileSync(path.join(DATA_DIR, 'blobs', id), JSON.stringify({
        content_type: parsed.content_type ?? 'application/octet-stream',
        data: parsed.data,
      }));
      return done(200, { id });
    }
    const upload = p.match(/^\/v1\/uploads\/([A-Za-z0-9_-]+)$/);
    if (upload && req.method === 'GET') {
      const file = path.join(DATA_DIR, 'blobs', upload[1]);
      if (!fs.existsSync(file)) return done(404, { code: 'not_found' });
      const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
      return done(200, { data: rec.data });
    }

    // ── Zero-knowledge offline mailbox (blinded tokens, opaque framed ciphertext).
    if (p === '/v1/mailbox/store' && req.method === 'POST') {
      let parsed;
      try { parsed = JSON.parse(bodyText); } catch { return done(400, { code: 'bad_json' }); }
      if (typeof parsed?.token !== 'string' || typeof parsed?.body !== 'string') {
        return done(400, { code: 'bad_request' });
      }
      const queue = mailboxes.get(parsed.token) ?? [];
      queue.push(parsed.body);
      mailboxes.set(parsed.token, queue);
      return done(204, {});
    }
    if (p === '/v1/mailbox/drain' && req.method === 'POST') {
      let parsed;
      try { parsed = JSON.parse(bodyText); } catch { return done(400, { code: 'bad_json' }); }
      const tokens = Array.isArray(parsed?.tokens) ? parsed.tokens : [];
      const bodies = [];
      for (const t of tokens) {
        const queue = mailboxes.get(t);
        if (queue?.length) {
          bodies.push(...queue);
          mailboxes.delete(t);
        }
      }
      return done(200, { bodies });
    }

    // ── Rendezvous: real implementation lives on the aether relay — proxy it.
    if (p.startsWith('/v1/rendezvous/')) {
      logRequest(req, bodyText, 0);
      return proxyToRelayControl(req, res, bodyBuf);
    }

    // ── Notifications: the native engine owns real notification data; the support
    // node serves an empty summary so the HTTP fallback path degrades gracefully.
    if (p === '/v1/notifications/summary' && req.method === 'GET') {
      return done(200, { total_unread: 0, dms_unread: 0, by_server: {} });
    }
    if (p === '/v1/notifications/search' && req.method === 'POST') {
      return done(200, { notifications: [] });
    }
    if (p === '/v1/notifications/read' && req.method === 'POST') {
      let parsed = {};
      try { parsed = JSON.parse(bodyText); } catch { /* tolerated */ }
      return done(200, {
        scope_id: parsed.scope_id ?? parsed.server_id ?? 'unknown',
        scope_type: parsed.scope_type ?? 'channel',
        read_through_message_id: parsed.read_through_message_id ?? '',
        updated_at: new Date().toISOString(),
      });
    }

    // ── TURN: not deployed locally; 404 makes clients fall back to STUN-only.
    if (p === '/v1/voice/turn-credentials') {
      return done(404, { code: 'no_turn' });
    }

    // ── Best-effort directory record after native registration (non-fatal client-side).
    if (p === '/v1/identities' && req.method === 'POST') {
      let parsed = {};
      try { parsed = JSON.parse(bodyText); } catch { /* tolerated */ }
      return done(200, {
        id: crypto.randomBytes(8).toString('hex'),
        display_name: parsed.display_name ?? '',
        bio: parsed.bio ?? '',
      });
    }

    // Unknown /v1 endpoint: log loudly so E2E surfaces every missing contract.
    console.log(`[support-node] UNHANDLED ${req.method} ${p}`);
    return done(404, { code: 'not_implemented', message: `no local handler for ${req.method} ${p}` });
  } catch (err) {
    console.error('[support-node] error', req.method, p, err);
    return done(500, { code: 'internal', message: String(err) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[support-node] listening on http://127.0.0.1:${PORT}`);
  console.log(`[support-node] relay ws multiaddr: ${RELAY_WS || '(none)'}`);
  console.log(`[support-node] relay control proxy: ${controlSocket ? `${controlSocket} (token ${controlToken ? 'loaded' : 'MISSING'})` : 'disabled'}`);
  console.log(`[support-node] data dir: ${DATA_DIR}`);
});
