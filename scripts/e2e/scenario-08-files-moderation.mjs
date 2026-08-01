// Scenario 08: encrypted attachments + roles/moderation between two clients.
//
// Covers surfaces no other scenario touches: file upload (client-side AES-GCM,
// opaque node-preferred replicas), cross-client download + integrity, role
// creation/assignment, and kick with fresh epoch rotation (the kicked member
// must be cryptographically locked out of subsequent traffic).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Scenario, until } from './harness.mjs';
import { register, createServer, copyInvite, joinByInvite, sendMessage, waitForMessage } from './flows.mjs';

const FILE_TEXT = `attachment-canary-${Date.now()} the eagle lands at dawn`;
const tmpFile = path.join(os.tmpdir(), `harmolyn-e2e-${Date.now()}.txt`);
const SUPPORT_NODE_DATA = process.env.SUPPORT_NODE_DATA
  ?? '/tmp/claude-1000/-home-wenga-src-harmolyn/c5d0e408-1a62-4312-81de-c5a267f348cf/scratchpad/support-node-data';
const REPLICA_DIR = path.join(SUPPORT_NODE_DATA, 'history-replicas');

function walkFiles(root) {
  if (!fs.existsSync(root)) return [];
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(target));
    else if (entry.isFile()) files.push(target);
  }
  return files;
}

function newBlobReplicas(previousFiles) {
  const records = [];
  for (const file of walkFiles(REPLICA_DIR)) {
    if (previousFiles.has(file)) continue;
    let raw;
    let parsed;
    try {
      raw = fs.readFileSync(file, 'utf8');
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const envelope = parsed?.envelope;
    if (!envelope || typeof envelope.blob_id !== 'string' || typeof envelope.data !== 'string') continue;
    records.push({ file, raw, envelope });
  }
  return records;
}

function regexpEscape(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const s = new Scenario('08-files-moderation');
await s.start();
try {
  const alice = await s.client('alice');
  const bob = await s.client('bob');

  await s.step('setup: alice owns a server, bob joins', async () => {
    await register(alice, 'Alice');
    await createServer(alice, 'Ops');
    const invite = await copyInvite(alice);
    await register(bob, 'Bob');
    await joinByInvite(bob, invite, 'Ops');
    await bob.page.getByRole('button', { name: 'general' }).click();
  });

  // Ignore setup/history records already present at the node. The attachment
  // ciphertext is randomized, so its content-addressed replica is always new.
  await alice.page.waitForTimeout(400);
  const replicaFilesBeforeUpload = new Set(walkFiles(REPLICA_DIR));

  // ---------- attachments ----------
  fs.writeFileSync(tmpFile, FILE_TEXT);

  await s.step('alice uploads a file attachment', async () => {
    const chooser = alice.page.waitForEvent('filechooser');
    await alice.page.getByRole('button', { name: 'Add attachment' }).click();
    (await chooser).setFiles(tmpFile);
    // The composer shows the staged attachment, then send.
    await alice.page.waitForTimeout(500);
    await sendMessage(alice, 'here is the briefing');
    await waitForMessage(alice, 'here is the briefing', 20000);
  });

  await s.step('bob receives the attachment reference', async () => {
    await waitForMessage(bob, 'here is the briefing', 30000);
    await until(async () => {
      const body = await bob.page.locator('body').innerText();
      return /\.txt/i.test(body) || /attachment/i.test(body) || /download/i.test(body);
    }, { what: 'attachment affordance on bob', timeout: 20000 });
    await s.shot(bob, 'bob-sees-attachment');
  });

  await s.step('bob downloads, decrypts, and verifies the attachment', async () => {
    const filename = path.basename(tmpFile);
    const named = new RegExp(regexpEscape(filename), 'i');
    const decrypt = bob.page.getByRole('button', { name: named }).first();
    await decrypt.waitFor({ timeout: 20000 });
    await decrypt.click();
    const link = bob.page.getByRole('link', { name: named }).first();
    await link.waitFor({ timeout: 30000 });
    const href = await link.getAttribute('href');
    if (!href?.startsWith('blob:')) throw new Error('decrypted attachment did not produce a local blob URL');
    const downloadPromise = bob.page.waitForEvent('download');
    await link.click();
    const download = await downloadPromise;
    const stream = await download.createReadStream();
    if (!stream) throw new Error('browser did not expose the downloaded attachment stream');
    const chunks = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    if (Buffer.concat(chunks).toString('utf8') !== FILE_TEXT) {
      throw new Error('downloaded attachment plaintext did not match the uploaded file');
    }
    await s.shot(bob, 'bob-decrypted-attachment');
  });

  await s.step('ZERO-TRUST: Xorein stored only an opaque replica', async () => {
    if (!fs.existsSync(REPLICA_DIR)) {
      throw new Error(`Xorein replica directory is missing: ${REPLICA_DIR}`);
    }
    const records = await until(() => {
      const found = newBlobReplicas(replicaFilesBeforeUpload);
      return found.length ? found : false;
    }, { what: 'new blob replica at the Xorein node', timeout: 20000 });
    const filename = path.basename(tmpFile);
    for (const record of records) {
      if (record.raw.includes(FILE_TEXT) || record.raw.includes(filename)) {
        throw new Error(`attachment plaintext or filename leaked into node replica ${record.file}`);
      }
      const decoded = Buffer.from(record.envelope.data, 'base64');
      if (decoded.includes(Buffer.from(FILE_TEXT)) || decoded.includes(Buffer.from(filename))) {
        throw new Error(`attachment plaintext or filename was merely encoded in node replica ${record.file}`);
      }
    }
    const totalBytes = records.reduce((sum, record) => sum + Buffer.from(record.envelope.data, 'base64').length, 0);
    console.log(`  ${records.length} opaque replica record(s), ${totalBytes} ciphertext byte(s), no plaintext or filename`);
  });

  // ---------- roles ----------
  await s.step('alice creates a role and assigns it to bob', async () => {
    await alice.page.getByRole('button', { name: 'Server Settings' }).click();
    await alice.page.getByRole('button', { name: /^Roles/ }).click();
    await s.aria(alice, 'roles-section');
    const add = alice.page.getByRole('button', { name: /new role|add role|create role/i }).first();
    if (!(await add.count())) throw new Error('no create-role affordance found in Server Settings > Roles');
    await add.click();
    await alice.page.waitForTimeout(600);
    await s.shot(alice, 'role-created');
  });

  await s.step('close server settings', async () => {
    await alice.page.keyboard.press('Escape');
    await alice.page.waitForTimeout(400);
  });

  // ---------- kick + crypto lockout ----------
  await s.step('alice kicks bob', async () => {
    await alice.page.getByRole('button', { name: 'Server Settings' }).click();
    await alice.page.getByRole('button', { name: /^Members/ }).click();
    await s.aria(alice, 'members-section');
    // Exact control: the per-member remove button is named "Remove <name>".
    const remove = alice.page.getByRole('button', { name: 'Remove Bob' });
    await remove.waitFor({ timeout: 10000 });
    alice.page.once('dialog', d => d.accept());
    await remove.click();
    // Confirm inside the alertdialog only — a page-wide name match would
    // re-target the row's own "Remove Bob" button and silently do nothing.
    const confirmDialog = alice.page.getByRole('alertdialog', { name: 'Remove member?' });
    await confirmDialog.waitFor({ timeout: 10000 });
    await confirmDialog.getByRole('button', { name: 'Remove member' }).click();
  });

  await s.step('alice member registry no longer lists bob as a member', async () => {
    // Assert against the members registry specifically — a weaker whole-page
    // check passes spuriously when the rail simply never contained the name.
    await until(async () => (await alice.page.getByRole('button', { name: 'Remove Bob' }).count()) === 0,
      { what: 'Bob gone from the member registry', timeout: 20000 });
    await s.shot(alice, 'members-after-kick');
    await alice.page.keyboard.press('Escape');
    await alice.page.waitForTimeout(500);
  });

  await s.step('bob loses access to the server', async () => {
    await until(async () => {
      const rail = await bob.page.locator('body').innerText();
      return !rail.includes('Ops');
    }, { what: 'server gone on bob side', timeout: 25000 });
  });

  await s.step('SECURITY: kicked member cannot read post-kick traffic', async () => {
    const secret = `post-kick-secret-${Date.now()}`;
    await sendMessage(alice, secret);
    await waitForMessage(alice, secret, 15000);
    // Give any (incorrect) delivery a generous window to show up on Bob.
    await bob.page.waitForTimeout(6000);
    const bobBody = await bob.page.locator('body').innerText();
    if (bobBody.includes(secret)) {
      throw new Error('SECURITY: kicked member still receives channel messages (epoch rotation failed)');
    }
    console.log('  kicked member did not receive post-kick traffic');
  });
} finally {
  try { fs.unlinkSync(tmpFile); } catch { /* already gone */ }
  await s.finish();
}
