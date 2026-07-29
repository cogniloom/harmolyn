// Scenario 06: zero-trust / no-leak verification.
//
// Two clients exchange messages containing unique canary strings, then this
// scenario audits every place the data could leak:
//   1. The support node's request log — the node must never see plaintext.
//   2. The published runtime snapshot — must never carry crowd_root/invite_secret.
//   3. Browser at-rest storage (IndexedDB/localStorage) — no plaintext bodies.
//
// Requires the local support node to be running with --data-dir pointing at
// SUPPORT_NODE_DATA (default matches scripts/local-support-node.mjs usage).
import fs from 'node:fs';
import path from 'node:path';
import { Scenario, until } from './harness.mjs';
import { register, createServer, copyInvite, joinByInvite, sendMessage, waitForMessage } from './flows.mjs';

const SUPPORT_DATA = process.env.SUPPORT_NODE_DATA
  ?? '/tmp/claude-1000/-home-wenga-src-harmolyn/c5d0e408-1a62-4312-81de-c5a267f348cf/scratchpad/support-node-data';
const REQUEST_LOG = path.join(SUPPORT_DATA, 'requests.jsonl');

// Unique per run so a hit can only come from THIS run's traffic.
const stamp = process.env.CANARY_STAMP ?? String(process.hrtime.bigint());
const CANARY_CHANNEL = `canaryChannelPlaintext${stamp}`;
const CANARY_DM = `canaryDirectPlaintext${stamp}`;

function requestLogOffset() {
  try {
    return fs.statSync(REQUEST_LOG).size;
  } catch {
    return 0;
  }
}

function requestLogSince(offset) {
  if (!fs.existsSync(REQUEST_LOG)) return [];
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

  await s.step('exchange canary messages in a Crowd channel', async () => {
    await sendMessage(alice, CANARY_CHANNEL);
    await waitForMessage(bob, CANARY_CHANNEL, 30000);
    await sendMessage(bob, `${CANARY_CHANNEL}-reply`);
    await waitForMessage(alice, `${CANARY_CHANNEL}-reply`, 30000);
  });

  await s.step('LEAK CHECK: support node never saw message plaintext', async () => {
    // Give any deferred/best-effort HTTP call time to fire before auditing.
    await alice.page.waitForTimeout(3000);
    const rows = requestLogSince(startOffset);
    console.log(`  audited ${rows.length} support-node requests from this run`);
    const leaks = rows.filter(r => {
      const blob = `${r.path} ${r.body ?? ''}`;
      return blob.includes(CANARY_CHANNEL) || blob.includes(CANARY_DM);
    });
    for (const l of leaks) console.log(`  LEAK: ${l.method} ${l.path} :: ${String(l.body).slice(0, 200)}`);
    if (leaks.length) throw new Error(`${leaks.length} request(s) carried message plaintext to the support node`);
  });

  await s.step('LEAK CHECK: no capability secrets in support-node traffic', async () => {
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

  await s.step('SUMMARY: what the support node DID see', async () => {
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
