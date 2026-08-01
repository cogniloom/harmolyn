// Scenario 06: zero-trust / no-leak verification.
//
// Two clients exchange messages containing unique canary strings, then this
// scenario audits every place the data could leak:
//   1. The current Xorein node's persisted replica data — no plaintext or
//      trivially encoded plaintext may exist there.
//   2. The published runtime snapshot — must never carry crowd_root/invite_secret.
//   3. Browser at-rest storage (IndexedDB/localStorage) — no plaintext bodies.
//
// XOREIN_NODE_DATA (or the legacy SUPPORT_NODE_DATA name) must point at the
// exact --data-dir used by the current test node.
import fs from 'node:fs';
import path from 'node:path';
import { Scenario, until } from './harness.mjs';
import { register, createServer, copyInvite, joinByInvite, sendMessage, waitForMessage } from './flows.mjs';

const SUPPORT_DATA = process.env.XOREIN_NODE_DATA?.trim()
  || process.env.SUPPORT_NODE_DATA?.trim()
  || '';
const REQUEST_LOG = SUPPORT_DATA ? path.join(SUPPORT_DATA, 'requests.jsonl') : '';

// Unique per run so a hit can only come from THIS run's traffic.
const stamp = process.env.CANARY_STAMP ?? String(process.hrtime.bigint());
const CANARY_CHANNEL = `canaryChannelPlaintext${stamp}`;

function walkFiles(root) {
  if (!root || !fs.existsSync(root)) return [];
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(target));
    else if (entry.isFile()) files.push(target);
  }
  return files;
}

function decodedJsonLeaks(value, canary) {
  if (typeof value === 'string') {
    if (value.includes(canary)) return true;
    if (value.length >= 8 && value.length <= 16 * 1024 * 1024 && /^[A-Za-z0-9+/_=-]+$/.test(value)) {
      try {
        const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
        if (Buffer.from(normalized, 'base64').includes(Buffer.from(canary))) return true;
      } catch { /* malformed base64 is not a leak */ }
    }
    return false;
  }
  if (Array.isArray(value)) return value.some(item => decodedJsonLeaks(item, canary));
  if (value && typeof value === 'object') return Object.values(value).some(item => decodedJsonLeaks(item, canary));
  return false;
}

function requestLogOffset() {
  if (!REQUEST_LOG) return 0;
  try {
    return fs.statSync(REQUEST_LOG).size;
  } catch {
    return 0;
  }
}

function requestLogSince(offset) {
  if (!REQUEST_LOG || !fs.existsSync(REQUEST_LOG)) return [];
  const fd = fs.openSync(REQUEST_LOG, 'r');
  const size = fs.statSync(REQUEST_LOG).size;
  const buf = Buffer.alloc(Math.max(0, size - offset));
  if (buf.length) fs.readSync(fd, buf, 0, buf.length, offset);
  fs.closeSync(fd);
  return buf.toString('utf8').split('\n').filter(Boolean).map(l => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

const s = await new Scenario('06-zerotrust').start();
const startOffset = requestLogOffset();
try {
  const alice = await s.client('alice');
  const bob = await s.client('bob');

  await s.step('two clients, a server, and a joined member', async () => {
    await register(alice, 'Alice');
    await createServer(alice, 'Vault');
    const invite = await copyInvite(alice);
    await register(bob, 'Bob');
    await joinByInvite(bob, invite, 'Vault');
    await bob.page.getByRole('button', { name: 'general' }).click();
  });

  if (!SUPPORT_DATA || !fs.existsSync(SUPPORT_DATA)) {
    throw new Error('set XOREIN_NODE_DATA to the current test node data directory for the zero-trust audit');
  }
  const nodeFilesBeforeTraffic = new Set(walkFiles(SUPPORT_DATA));

  await s.step('exchange canary messages in an adaptive E2EE channel', async () => {
    await sendMessage(alice, CANARY_CHANNEL);
    await waitForMessage(bob, CANARY_CHANNEL, 30000);
    await sendMessage(bob, `${CANARY_CHANNEL}-reply`);
    await waitForMessage(alice, `${CANARY_CHANNEL}-reply`, 30000);
  });

  await s.step('LEAK CHECK: Xorein persisted no plaintext or encoded plaintext', async () => {
    const newReplicaFiles = await until(() => {
      const files = walkFiles(path.join(SUPPORT_DATA, 'history-replicas'))
        .filter(file => !nodeFilesBeforeTraffic.has(file));
      return files.length ? files : false;
    }, { what: 'current-run Xorein replica records', timeout: 20000 });

    const leaks = [];
    const allFiles = walkFiles(SUPPORT_DATA);
    for (const file of allFiles) {
      const raw = fs.readFileSync(file);
      if (raw.includes(Buffer.from(CANARY_CHANNEL))) {
        leaks.push(`${file}:raw`);
        continue;
      }
      if (!file.endsWith('.json') && !file.endsWith('.jsonl')) continue;
      for (const line of raw.toString('utf8').split('\n').filter(Boolean)) {
        try {
          if (decodedJsonLeaks(JSON.parse(line), CANARY_CHANNEL)) leaks.push(`${file}:encoded`);
        } catch { /* binary or non-JSON node state is covered by the raw scan */ }
      }
    }
    if (leaks.length) throw new Error(`message plaintext leaked into Xorein storage: ${leaks.join(', ')}`);
    console.log(`  audited ${allFiles.length} node file(s), including ${newReplicaFiles.length} current-run replica(s)`);
  });

  await s.step('LEAK CHECK: legacy HTTP request log contains no plaintext', async () => {
    // Current Xorein does not use the retired request-log shim. If a compatibility
    // gateway is present, audit it as a secondary boundary as well.
    const rows = requestLogSince(startOffset);
    console.log(`  audited ${rows.length} compatibility HTTP request(s) from this run`);
    const leaks = rows.filter(r => {
      const blob = `${r.path} ${r.body ?? ''}`;
      return blob.includes(CANARY_CHANNEL);
    });
    for (const l of leaks) console.log(`  LEAK: ${l.method} ${l.path} :: ${String(l.body).slice(0, 200)}`);
    if (leaks.length) throw new Error(`${leaks.length} request(s) carried message plaintext to the node`);
  });

  await s.step('LEAK CHECK: no capability secrets in compatibility HTTP traffic', async () => {
    const rows = requestLogSince(startOffset);
    const secretish = rows.filter(r => {
      const body = String(r.body ?? '');
      return /"(crowd_root|invite_secret|mailbox_secret|passphrase|private_key|ed_seed)"/.test(body);
    });
    for (const l of secretish) console.log(`  SECRET LEAK: ${l.method} ${l.path} :: ${String(l.body).slice(0, 200)}`);
    if (secretish.length) throw new Error('capability/secret material was sent to the support node');
  });

  await s.step('LEAK CHECK: published snapshot carries no owner-only secrets', async () => {
    const found = await alice.page.evaluate(() => {
      const keys = ['__HARMOLYN_XOREIN_RUNTIME__', '__HARMOLYN_RUNTIME_SNAPSHOT__', '__XOREIN_RUNTIME_SNAPSHOT__'];
      const out = [];
      for (const k of keys) {
        const v = window[k];
        if (!v) continue;
        const json = JSON.stringify(v);
        for (const secret of ['crowd_root', 'invite_secret', 'mailbox_secret', 'ed_seed']) {
          if (json.includes(secret)) out.push(`${k}:${secret}`);
        }
      }
      return out;
    });
    if (found.length) throw new Error(`snapshot exposed secrets: ${found.join(', ')}`);
    console.log('  snapshot clean (no crowd_root / invite_secret / mailbox_secret / ed_seed)');
  });

  await s.step('AT-REST CHECK: browser storage holds no plaintext message bodies', async () => {
    const hits = await alice.page.evaluate(async (canary) => {
      const out = [];
      // localStorage / sessionStorage
      for (const [label, store] of [['localStorage', localStorage], ['sessionStorage', sessionStorage]]) {
        for (let i = 0; i < store.length; i++) {
          const k = store.key(i);
          const v = store.getItem(k) ?? '';
          if (v.includes(canary)) out.push(`${label}:${k}`);
        }
      }
      // Every IndexedDB database, every store, every record.
      const dbs = (await indexedDB.databases?.()) ?? [];
      for (const info of dbs) {
        if (!info.name) continue;
        const db = await new Promise((resolve, reject) => {
          const req = indexedDB.open(info.name);
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        }).catch(() => null);
        if (!db) continue;
        for (const storeName of Array.from(db.objectStoreNames)) {
          const all = await new Promise((resolve) => {
            try {
              const req = db.transaction(storeName, 'readonly').objectStore(storeName).getAll();
              req.onsuccess = () => resolve(req.result);
              req.onerror = () => resolve([]);
            } catch { resolve([]); }
          });
          let json = '';
          try { json = JSON.stringify(all); } catch { json = String(all); }
          if (json.includes(canary)) out.push(`idb:${info.name}/${storeName}`);
        }
        db.close();
      }
      return out;
    }, CANARY_CHANNEL);
    if (hits.length) {
      // Message bodies are expected to be encrypted at rest for registered users.
      throw new Error(`plaintext message body found at rest in: ${hits.join(', ')}`);
    }
    console.log('  at-rest storage clean (no plaintext message bodies)');
  });

  await s.step('SUMMARY: compatibility HTTP paths observed', async () => {
    const rows = requestLogSince(startOffset);
    const byPath = new Map();
    for (const r of rows) {
      const k = `${r.method} ${r.path.split('?')[0].replace(/srv-[0-9a-f-]+/g, 'srv-<id>')}`;
      byPath.set(k, (byPath.get(k) ?? 0) + 1);
    }
    for (const [k, n] of [...byPath.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`   ${String(n).padStart(4)} ${k}`);
    }
  });
} finally {
  await s.finish();
}
