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
const DEFAULT_ORIGINS = 'http://127.0.0.1:8080,http://localhost:8080';
const ALLOWED_ORIGINS = new Set((arg('origins', process.env.HARMOLYN_ALLOWED_ORIGINS ?? DEFAULT_ORIGINS) ?? '')
  .split(',').map(value => value.trim()).filter(Boolean));

const MAX_UPLOAD_DATA_BYTES = 90 * 1024 * 1024;
const MAX_REQUEST_BODY_BYTES = 96 * 1024 * 1024;
const MAX_MAILBOX_BODY_BYTES = 1 * 1024 * 1024;
const MAX_MAILBOX_BODY_B64_BYTES = Math.ceil((MAX_MAILBOX_BODY_BYTES + 5) / 3) * 4 + 4;
const MAX_MAILBOX_TOKENS = 3;
const MAX_MAILBOX_ENTRIES = 100000;
const MAX_MAILBOX_BYTES = 128 * 1024 * 1024;
const MAILBOX_TTL_MS = 24 * 60 * 60 * 1000;

function secureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const info = fs.lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('support data directory must be a private directory');
  fs.chmodSync(directory, 0o700);
}

secureDirectory(DATA_DIR);
secureDirectory(path.join(DATA_DIR, 'blobs'));
const requestLogPath = path.join(DATA_DIR, 'requests.jsonl');
try {
  const requestInfo = fs.lstatSync(requestLogPath);
  if (!requestInfo.isFile() || requestInfo.isSymbolicLink()) throw new Error('request log must be a regular file');
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}
// Open the audit log before creating the stream. Calling chmodSync immediately
// after createWriteStream is racy: on a fresh data directory the file may not
// exist yet and the support node would fail closed during startup. O_NOFOLLOW
// also prevents a local symlink swap from redirecting audit data.
const requestLogFlags = fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT |
  (fs.constants.O_NOFOLLOW ?? 0);
let requestLogFd;
try {
  requestLogFd = fs.openSync(requestLogPath, requestLogFlags, 0o600);
  const requestLogInfo = fs.fstatSync(requestLogFd);
  if (!requestLogInfo.isFile()) throw new Error('request log must be a regular file');
  fs.fchmodSync(requestLogFd, 0o600);
} catch (error) {
  if (requestLogFd !== undefined) fs.closeSync(requestLogFd);
  throw error;
}
const requestLog = fs.createWriteStream(null, { fd: requestLogFd, autoClose: true });

// Relay control-API proxy config (rendezvous lives on the aether relay).
let controlSocket = '';
let controlToken = '';
if (RELAY_DATA) {
  try {
    const tokenPath = path.join(RELAY_DATA, 'control.token');
    const tokenInfo = fs.lstatSync(tokenPath);
    if (!tokenInfo.isFile() || tokenInfo.isSymbolicLink() || tokenInfo.size > 4096) throw new Error('invalid control token file');
    controlToken = fs.readFileSync(tokenPath, 'utf8').trim();
  } catch { /* token missing: proxy disabled */ }
  const sockInData = path.join(RELAY_DATA, 'xorein-control.sock');
  if (fs.existsSync(sockInData)) {
    controlSocket = sockInData;
  } else {
    // Long data-dir paths overflow sockaddr_un; aether falls back to /tmp/xrn-*.sock.
    const candidates = fs.readdirSync('/tmp').filter(f => f.startsWith('xrn-') && f.endsWith('.sock'))
      .map(f => path.join('/tmp', f))
      .filter(candidate => {
        try {
          const info = fs.lstatSync(candidate);
          const ownerOk = typeof process.getuid !== 'function' || info.uid === process.getuid();
          return info.isSocket() && !info.isSymbolicLink() && ownerOk && (info.mode & 0o077) === 0;
        } catch { return false; }
      });
    if (candidates.length === 1) controlSocket = candidates[0];
    else if (process.env.AETHER_CONTROL_SOCKET) controlSocket = process.env.AETHER_CONTROL_SOCKET;
  }
}

// In-memory mailbox: token -> [{body, storedAt}, ...]. Opaque ciphertext only.
const mailboxes = new Map();
let mailboxEntries = 0;
let mailboxBytes = 0;

function logRequest(req, pathname, bodyBytes, status) {
  requestLog.write(JSON.stringify({
    t: new Date().toISOString(),
    method: req.method,
    path: pathname,
    status,
    body_bytes: bodyBytes,
  }) + '\n');
}

function cors(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
    res.setHeader('Access-Control-Max-Age', '600');
  }
}

function json(res, status, value) {
  const body = JSON.stringify(value);
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  };
  if (status === 204) {
    res.writeHead(status, headers);
    res.end();
    return;
  }
  res.writeHead(status, headers);
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const declared = Number(req.headers['content-length'] ?? 0);
    if (Number.isFinite(declared) && declared > MAX_REQUEST_BODY_BYTES) {
      reject(new Error('body too large'));
      req.destroy();
      return;
    }
    req.on('data', c => {
      size += c.length;
      if (size > MAX_REQUEST_BODY_BYTES) { reject(new Error('body too large')); req.destroy(); return; }
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
    json(res, 502, { code: 'relay_control_error', message: 'relay control unavailable' });
  });
  if (bodyBuf?.length) preq.write(bodyBuf);
  preq.end();
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    json(res, 403, { code: 'origin_not_allowed' });
    return;
  }
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
    logRequest(req, p, bodyBuf.length, status);
    json(res, status, value);
  };

  try {
    // ── Minimal runtime state: browser treats a 200 structured JSON as "node online".
    if (p === '/v1/state' && req.method === 'GET') {
      return done(200, { status: 'ok', control_endpoint: `http://127.0.0.1:${PORT}` });
    }

    // ── SSE event stream: keepalive only (native engine owns live data).
    if (p === '/v1/events') {
      logRequest(req, p, 0, 200);
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
        'X-Accel-Buffering': 'no',
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
      if (parsed?.filename !== 'blob' || parsed?.content_type !== 'application/octet-stream' ||
        typeof parsed?.data !== 'string' || parsed.data.length > MAX_UPLOAD_DATA_BYTES ||
        !/^data:application\/octet-stream;base64,[A-Za-z0-9+/]+={0,2}$/.test(parsed.data)) {
        return done(400, { code: 'invalid_opaque_blob' });
      }
      const encoded = parsed.data.slice(parsed.data.indexOf(',') + 1);
      if (encoded.length % 4 === 1) return done(400, { code: 'invalid_opaque_blob' });
      const decodedLength = Math.floor(encoded.length * 3 / 4);
      if (decodedLength < 16 || decodedLength > 64 * 1024 * 1024 + 16) {
        return done(400, { code: 'invalid_opaque_blob' });
      }
      const id = crypto.randomBytes(16).toString('hex');
      const file = path.join(DATA_DIR, 'blobs', id);
      const fd = fs.openSync(file, 'wx', 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify({ data: parsed.data }), 'utf8');
      } finally {
        fs.closeSync(fd);
      }
      fs.chmodSync(file, 0o600);
      return done(200, {
        id,
        url: `/v1/uploads/${id}`,
        filename: 'blob',
        content_type: 'application/octet-stream',
        size: decodedLength - 16,
      });
    }
    const upload = p.match(/^\/v1\/uploads\/([a-f0-9]{32})$/);
    if (upload && req.method === 'GET') {
      const file = path.join(DATA_DIR, 'blobs', upload[1]);
      let info;
      try { info = fs.lstatSync(file); } catch { return done(404, { code: 'not_found' }); }
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_UPLOAD_DATA_BYTES + 1024) return done(404, { code: 'not_found' });
      let rec;
      try { rec = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return done(404, { code: 'not_found' }); }
      if (typeof rec?.data !== 'string' || rec.data.length > MAX_UPLOAD_DATA_BYTES) return done(404, { code: 'not_found' });
      return done(200, { data: rec.data });
    }

    // ── Zero-knowledge offline mailbox (blinded tokens, opaque framed ciphertext).
    if (p === '/v1/mailbox/store' && req.method === 'POST') {
      let parsed;
      try { parsed = JSON.parse(bodyText); } catch { return done(400, { code: 'bad_json' }); }
      if (typeof parsed?.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(parsed.token) ||
        typeof parsed?.body !== 'string' || parsed.body.length > MAX_MAILBOX_BODY_B64_BYTES ||
        !/^[A-Za-z0-9_-]+$/.test(parsed.body) || parsed.body.length % 4 === 1) {
        return done(400, { code: 'bad_request' });
      }
      const decoded = Buffer.from(parsed.body, 'base64url');
      if (decoded.length < 21 || decoded.length > MAX_MAILBOX_BODY_BYTES + 5 ||
        decoded.subarray(0, 5).toString('latin1') !== 'xrn1\x01') {
        return done(400, { code: 'bad_opaque_body' });
      }
      pruneMailboxes();
      if (mailboxEntries >= MAX_MAILBOX_ENTRIES || mailboxBytes + decoded.length > MAX_MAILBOX_BYTES) {
        return done(429, { code: 'mailbox_capacity' });
      }
      const queue = mailboxes.get(parsed.token) ?? [];
      queue.push({ body: parsed.body, storedAt: Date.now() });
      mailboxes.set(parsed.token, queue);
      mailboxEntries++;
      mailboxBytes += decoded.length;
      return done(204, {});
    }
    if (p === '/v1/mailbox/drain' && req.method === 'POST') {
      let parsed;
      try { parsed = JSON.parse(bodyText); } catch { return done(400, { code: 'bad_json' }); }
      const tokens = Array.isArray(parsed?.tokens) ? parsed.tokens : [];
      if (tokens.length === 0 || tokens.length > MAX_MAILBOX_TOKENS || tokens.some(t => typeof t !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(t))) {
        return done(400, { code: 'bad_tokens' });
      }
      pruneMailboxes();
      const bodies = [];
      for (const t of tokens) {
        const queue = mailboxes.get(t);
        if (queue?.length) {
          for (const entry of queue) {
            bodies.push(entry.body);
            mailboxEntries--;
            mailboxBytes -= Buffer.from(entry.body, 'base64url').length;
          }
          mailboxes.delete(t);
        }
      }
      return done(200, { bodies });
    }

    // ── Rendezvous: real implementation lives on the aether relay — proxy it.
    if (p.startsWith('/v1/rendezvous/')) {
      logRequest(req, p, bodyBuf.length, 0);
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
      // Identity metadata belongs to the encrypted client/native runtime, not
      // to this opaque relay bridge. Keep the endpoint explicit and fail closed
      // instead of accepting display names or bios in plaintext.
      return done(501, { code: 'identity_metadata_requires_local_runtime' });
    }

    // Unknown /v1 endpoint: log the route only so E2E surfaces every missing contract.
    console.log(`[support-node] UNHANDLED ${req.method} ${p}`);
    return done(404, { code: 'not_implemented' });
  } catch {
    console.error('[support-node] request failed', req.method, p);
    return done(500, { code: 'internal' });
  }
});

function pruneMailboxes() {
  const cutoff = Date.now() - MAILBOX_TTL_MS;
  for (const [token, queue] of mailboxes) {
    const fresh = [];
    for (const entry of queue) {
      if (entry.storedAt > cutoff) {
        fresh.push(entry);
      } else {
        mailboxEntries--;
        mailboxBytes -= Buffer.from(entry.body, 'base64url').length;
      }
    }
    if (fresh.length) mailboxes.set(token, fresh);
    else mailboxes.delete(token);
  }
  mailboxEntries = Math.max(0, mailboxEntries);
  mailboxBytes = Math.max(0, mailboxBytes);
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[support-node] listening on http://127.0.0.1:${PORT}`);
  console.log(`[support-node] relay ws multiaddr: ${RELAY_WS || '(none)'}`);
  console.log(`[support-node] relay control proxy: ${controlSocket ? `${controlSocket} (token ${controlToken ? 'loaded' : 'MISSING'})` : 'disabled'}`);
  console.log(`[support-node] allowed origins: ${[...ALLOWED_ORIGINS].join(', ') || '(none)'}`);
  console.log(`[support-node] data dir: ${DATA_DIR}`);
});
