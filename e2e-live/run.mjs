// Full E2E runner — two isolated peers, harmolyn end-to-end on PROD.
import { writeFile } from 'fs/promises';
import path from 'path';
import { Peer, onboard, waitConnected, capturePeerId, ensureEvidence, EVIDENCE } from './harness.mjs';

const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null; // optional phase filter
const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} :: ${name}${detail ? ' :: ' + detail : ''}`);
}
async function step(name, fn) {
  if (ONLY && !ONLY.some(p => name.includes(p))) return null;
  try { const d = await fn(); record(name, true, typeof d === 'string' ? d : ''); return d; }
  catch (e) { record(name, false, (e.message || String(e)).split('\n')[0]); return null; }
}
const wait = (p, ms) => p.waitForTimeout(ms);

// ---- UI helpers --------------------------------------------------------------
async function openHomeFriends(peer) {
  const p = peer.page;
  // Click "Home" in server rail, then the Friends entry if present.
  await p.getByRole('button', { name: 'Home' }).first().click().catch(() => {});
  await wait(p, 400);
  const friendsBtn = p.getByRole('button', { name: /^Friends$/ }).first();
  if (await friendsBtn.count()) await friendsBtn.click().catch(() => {});
  await wait(p, 400);
}

async function sendChannelMessage(peer, text) {
  const p = peer.page;
  const box = p.getByRole('textbox', { name: 'Message Input' }).first();
  await box.waitFor({ state: 'visible', timeout: 15000 });
  await box.click();
  await box.fill(text);
  // Prefer Send button; fall back to Enter.
  const send = p.getByRole('button', { name: 'Send Message' }).first();
  if (await send.isEnabled().catch(() => false)) await send.click();
  else await box.press('Enter');
}

async function waitForText(peer, text, timeout = 30000) {
  const p = peer.page;
  const start = Date.now();
  const re = typeof text === 'string' ? null : text;
  const needle = typeof text === 'string' ? text.toLowerCase() : null;
  while (Date.now() - start < timeout) {
    const body = (await p.locator('body').innerText().catch(() => '')).toLowerCase();
    if (re ? re.test(body) : body.includes(needle)) return true;
    await wait(p, 800);
  }
  return false;
}

// Enter a server by clicking its rail icon (aria-label "Server: <name>").
async function enterServer(peer, name) {
  const p = peer.page;
  const btn = p.getByRole('button', { name: new RegExp('^Server: ' + name, 'i') }).first();
  await btn.waitFor({ state: 'visible', timeout: 20000 });
  await btn.click();
  await wait(p, 800);
}

async function selectChannel(peer, name) {
  const p = peer.page;
  const ch = p.getByRole('button', { name }).first();
  await ch.waitFor({ state: 'visible', timeout: 10000 });
  await ch.click();
  await wait(p, 600);
}

// Open the server header dropdown (the 2-click entry for invite/leave/delete).
async function openServerMenu(peer) {
  const p = peer.page;
  const header = p.getByRole('button', { name: 'Server menu' }).first();
  await header.waitFor({ state: 'visible', timeout: 10000 });
  await header.click();
  await wait(p, 500);
}

async function clickMenuItem(peer, name) {
  const p = peer.page;
  const item = p.getByRole('menuitem', { name: new RegExp(name, 'i') }).first();
  await item.waitFor({ state: 'visible', timeout: 8000 });
  await item.click();
  await wait(p, 1000);
}

// Read the local native member count for the (single) server straight from the
// peer's persisted store — robust against display-name/innerText variance.
async function serverMemberCount(peer) {
  return peer.page.evaluate(() => {
    try {
      const s = JSON.parse(localStorage.getItem('harmolyn:native:state') || '{}');
      const srv = Object.values(s.servers || {})[0];
      return srv ? (srv.members || []).length : -1;
    } catch { return -1; }
  });
}

async function dumpUI(peer, tag) {
  const ui = await peer.page.evaluate(() => {
    const acc = (el) => (el.getAttribute('aria-label') || el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    return {
      buttons: Array.from(document.querySelectorAll('button')).map(acc).filter(Boolean),
      headings: Array.from(document.querySelectorAll('h1,h2,h3')).map(acc).filter(Boolean),
    };
  }).catch((e) => ({ error: String(e) }));
  await writeFile(path.join(EVIDENCE, `${peer.label}-ui-${tag}.json`), JSON.stringify(ui, null, 2));
}

// ---- main --------------------------------------------------------------------
await ensureEvidence();
const A = new Peer('A');
const B = new Peer('B');
const stamp = Date.now().toString(36).slice(-5);
const nameA = `Alice${stamp}`;
const nameB = `Bob${stamp}`;
const serverName = `Nexus${stamp}`;
const PW = 'correct-horse-battery';
let inviteLink = null;

try {
  await A.launch();
  await B.launch();
  await step('A:load', async () => { await A.goto(); });
  await step('B:load', async () => { await B.goto(); });

  await step('A:onboard', async () => onboard(A, nameA, PW));
  await step('B:onboard', async () => onboard(B, nameB, PW));
  await step('A:connected', async () => { if (!await waitConnected(A)) throw new Error('not connected'); });
  await step('B:connected', async () => { if (!await waitConnected(B)) throw new Error('not connected'); });
  await step('A:peerid', async () => { const id = await capturePeerId(A); if (!id) throw new Error('no id'); return id; });
  await step('B:peerid', async () => { const id = await capturePeerId(B); if (!id) throw new Error('no id'); return id; });
  await A.shot('01-onboarded'); await B.shot('01-onboarded');

  // ----- 2-CLICK REACHABILITY: Add Friend from a cold start -----
  await step('A:add-friend-in-2-clicks', async () => {
    const p = A.page;
    await p.getByRole('button', { name: 'Home' }).first().click();   // click 1: Home → Friends
    await wait(p, 700);
    const addBtn = p.getByRole('button', { name: /ADD FRIEND/i }).first();
    await addBtn.waitFor({ state: 'visible', timeout: 8000 });
    await addBtn.click();                                            // click 2: reveal add-friend input
    const input = p.getByPlaceholder(/Peer ID or multiaddr/i).first();
    await input.waitFor({ state: 'visible', timeout: 5000 });
    await addBtn.click().catch(() => {});                            // close again so it doesn't linger
    return 'Add Friend reachable in 2 clicks from Home';
  });

  // ----- SERVER CREATION (A) -----
  await step('A:create-server', async () => {
    const p = A.page;
    await p.getByRole('button', { name: 'Create Server' }).first().click();
    await p.getByPlaceholder('THE // HUB').waitFor({ state: 'visible', timeout: 10000 });
    await p.getByPlaceholder('THE // HUB').fill(serverName);
    await p.getByRole('button', { name: 'Initiate Matrix' }).click();
    // wait for server to appear in rail
    const ok = await waitForText(A, serverName, 25000);
    if (!ok) throw new Error('server name never appeared');
  });
  await A.shot('02-server-created');
  await dumpUI(A, 'after-create');

  // ----- INVITE (A) -----
  await step('A:open-settings-invite', async () => {
    const p = A.page;
    await p.getByRole('button', { name: 'Server Settings' }).first().click();
    await wait(p, 800);
    await p.getByRole('button', { name: 'Invites' }).first().click();
    await wait(p, 800);
    // read the deeplink text
    const link = await p.evaluate(() => {
      const els = Array.from(document.querySelectorAll('div,span,code,input'));
      for (const el of els) {
        const t = (el.value || el.textContent || '').trim();
        if (t.startsWith('xorein://')) return t;
      }
      return null;
    });
    if (!link) throw new Error('no invite deeplink found');
    inviteLink = link;
    return link;
  });
  await A.shot('03-invite');
  // close settings
  await A.page.keyboard.press('Escape').catch(() => {});
  await wait(A.page, 500);

  // ----- JOIN (B) -----
  await step('B:join-server', async () => {
    if (!inviteLink) throw new Error('no invite to use');
    const p = B.page;
    // open join modal via home card or create-server->have invite
    const joinCard = p.getByRole('button', { name: /Join with an invite/i }).first();
    if (await joinCard.count()) await joinCard.click();
    else { await p.getByRole('button', { name: 'Explore Servers' }).first().click(); }
    await p.getByPlaceholder(/xorein:\/\/join/i).waitFor({ state: 'visible', timeout: 10000 });
    await p.getByPlaceholder(/xorein:\/\/join/i).fill(inviteLink);
    await wait(p, 600);
    await p.getByRole('button', { name: 'Join Server' }).click();
    // Wait for the join modal to actually close (real success), not the preview card.
    await p.getByRole('heading', { name: 'Join a server' }).waitFor({ state: 'detached', timeout: 45000 }).catch(() => {});
    // Server must appear as a rail icon.
    await enterServer(B, serverName);
  });
  await B.shot('04-joined');
  await dumpUI(B, 'after-join');

  // ----- CHANNEL MESSAGING (A -> B) -----
  const msgAtoB = `hello-from-A-${stamp}`;
  const msgBtoA = `reply-from-B-${stamp}`;
  await step('A:enter-server', async () => { await enterServer(A, serverName); });
  await step('A:select-channel', async () => { await selectChannel(A, 'general'); });
  await step('B:select-channel', async () => { await selectChannel(B, 'general'); });
  await step('A:send-channel-msg', async () => { await sendChannelMessage(A, msgAtoB); });
  await step('B:recv-channel-msg', async () => { if (!await waitForText(B, msgAtoB, 30000)) throw new Error('B did not receive A msg'); });
  await step('B:send-channel-msg', async () => { await sendChannelMessage(B, msgBtoA); });
  await step('A:recv-channel-msg', async () => { if (!await waitForText(A, msgBtoA, 30000)) throw new Error('A did not receive B msg'); });
  await A.shot('05-channel-chat'); await B.shot('05-channel-chat');

  // ----- FRIENDS (A adds B) -----
  await step('A:send-friend-request', async () => {
    const p = A.page;
    await openHomeFriends(A);
    const addBtn = p.getByRole('button', { name: /ADD FRIEND/i }).first();
    await addBtn.waitFor({ state: 'visible', timeout: 10000 });
    await addBtn.click();
    const input = p.getByPlaceholder(/Peer ID or multiaddr/i).first();
    await input.waitFor({ state: 'visible', timeout: 8000 });
    await input.fill(B.peerId);
    await p.getByRole('button', { name: /SEND REQUEST/i }).click();
    await wait(p, 1500);
    const body = await p.locator('body').innerText();
    if (/Unable to send|error/i.test(body) && !/Friend request sent/i.test(body)) throw new Error('send failed: ' + body.slice(0,200));
  });
  await A.shot('06-friend-sent');

  // NOTIFICATION: B must REALIZE the request arrived without opening anything —
  // a pending badge on the Home button (and a toast) surface it. This is the
  // "a friend request is useless if the other party doesn't notice" guarantee.
  await step('B:friend-request-notification', async () => {
    const p = B.page;
    const badge = p.locator('[aria-label*="pending friend request" i]').first();
    const toast = p.getByText(/wants to be friends/i).first();
    for (let i = 0; i < 30; i++) {
      if ((await badge.count()) || (await toast.count())) return 'badge/toast visible to B';
      await wait(p, 1000);
    }
    throw new Error('B got no visible notification of the incoming friend request');
  });
  await B.shot('06b-friend-notification');

  await step('B:receive+accept-friend', async () => {
    const p = B.page;
    await openHomeFriends(B);
    // go to pending tab
    const pending = p.getByRole('button', { name: /PENDING/i }).first();
    let appeared = false;
    for (let i = 0; i < 30; i++) {
      if (await pending.count()) await pending.click().catch(() => {});
      await wait(p, 1000);
      const accept = p.getByRole('button', { name: 'Accept' }).first();
      if (await accept.count()) { await accept.click(); appeared = true; break; }
    }
    if (!appeared) throw new Error('friend request never arrived at B');
  });
  await B.shot('07-friend-accepted');

  // ----- DIRECT MESSAGE -----
  const dmAtoB = `dm-A-to-B-${stamp}`;
  const dmBtoA = `dm-B-to-A-${stamp}`;
  await step('A:open-dm', async () => {
    const p = A.page;
    await openHomeFriends(A);
    // ALL tab then Message action
    await p.getByRole('button', { name: /^ALL/i }).first().click().catch(() => {});
    await wait(p, 800);
    const msgBtn = p.getByRole('button', { name: 'Message' }).first();
    await msgBtn.waitFor({ state: 'visible', timeout: 10000 });
    await msgBtn.click();
    await wait(p, 1000);
  });
  await step('A:send-dm', async () => { await sendChannelMessage(A, dmAtoB); });
  await step('B:recv-dm', async () => {
    // B may need to open the DM conversation
    const p = B.page;
    await openHomeFriends(B);
    await p.getByRole('button', { name: /^ALL/i }).first().click().catch(() => {});
    await wait(p, 800);
    const msgBtn = p.getByRole('button', { name: 'Message' }).first();
    if (await msgBtn.count()) { await msgBtn.click().catch(() => {}); await wait(p, 1000); }
    if (!await waitForText(B, dmAtoB, 30000)) throw new Error('B did not receive DM');
  });
  await step('B:send-dm', async () => { await sendChannelMessage(B, dmBtoA); });
  await step('A:recv-dm', async () => { if (!await waitForText(A, dmBtoA, 30000)) throw new Error('A did not receive DM reply'); });
  await A.shot('08-dm'); await B.shot('08-dm');

  // ----- PRESENCE: A should see B online (not offline) -----
  await step('A:sees-friend-online', async () => {
    const p = A.page;
    await openHomeFriends(A);
    const onlineTab = p.getByRole('button', { name: /^ONLINE/i }).first();
    for (let i = 0; i < 35; i++) {
      await onlineTab.click().catch(() => {});
      await wait(p, 1000);
      const t = await p.locator('body').innerText();
      if (!/No one is online/i.test(t) && /ONLINE — \d/i.test(t)) return;
    }
    throw new Error('friend B never showed as online for A');
  });
  await A.shot('09-presence');

  // ----- NEW CHANNEL: owner A creates a channel, member B must receive it -----
  const newChan = `ops${stamp}`;
  await step('A:create-channel', async () => {
    await enterServer(A, serverName);
    const p = A.page;
    await p.getByRole('button', { name: 'Add channel' }).first().click();
    const input = p.getByPlaceholder('channel-name').first();
    await input.waitFor({ state: 'visible', timeout: 8000 });
    await input.fill(newChan);
    await input.press('Enter');
    if (!await waitForText(A, newChan, 12000)) throw new Error('new channel did not appear for A');
  });
  await step('B:receives-new-channel', async () => {
    await enterServer(B, serverName);
    if (!await waitForText(B, newChan, 30000)) throw new Error('member B never received the new channel');
  });
  await A.shot('10-newchannel'); await B.shot('10-newchannel');

  // ----- NO-FAKES: Server Settings exposes REAL controls, fake Roles gated off ---
  await step('A:server-settings-real-not-fake', async () => {
    await enterServer(A, serverName);
    const p = A.page;
    await p.getByRole('button', { name: 'Server Settings' }).first().click();
    await wait(p, 1000);
    // The fake custom-roles section (local-only / unrouted HTTP) must be gone.
    const rolesCount = await p.getByRole('button', { name: /^Roles$/ }).count();
    // Overview must offer a REAL editable Server Name field (not a fake "Modify").
    const nameField = await p.getByLabel(/server name/i).count();
    // Owner sees a real Delete Server control.
    const del = await p.getByRole('button', { name: /Delete Server/i }).count();
    await dumpUI(A, 'settings-real');
    // ALWAYS close the modal before asserting, so a failure never wedges later steps.
    await p.keyboard.press('Escape').catch(() => {});
    await wait(p, 600);
    if (rolesCount > 0) throw new Error('fake Roles section should be gated off');
    if (nameField === 0) throw new Error('Overview lacks a real editable Server Name field');
    if (del === 0) throw new Error('owner is missing a real Delete Server control');
    return 'real settings (editable name, delete server); no fake roles';
  });

  // ----- PERMISSIONS: member B must NOT see owner-only channel management -----
  await step('B:no-owner-controls', async () => {
    await enterServer(B, serverName);
    const p = B.page;
    await dumpUI(B, 'member-perms');
    // B is a member, not the owner — the "Add channel" control is owner-only.
    const addChannel = await p.getByRole('button', { name: 'Add channel' }).count();
    if (addChannel > 0) throw new Error('non-owner B should NOT see the Add channel control');
    return 'B (member) correctly has no Add-channel control';
  });

  // ----- PERMISSIONS: owner A still has channel management -----
  await step('A:owner-has-controls', async () => {
    await enterServer(A, serverName);
    const p = A.page;
    const addChannel = await p.getByRole('button', { name: 'Add channel' }).count();
    if (addChannel === 0) throw new Error('owner A should still see the Add channel control');
    return 'A (owner) retains channel management';
  });

  // ----- 2-CLICK REACHABILITY: invite via the server header dropdown -----
  await step('A:invite-in-2-clicks', async () => {
    await enterServer(A, serverName);
    await openServerMenu(A);                 // click 1: open header dropdown
    await clickMenuItem(A, 'Copy Invite Link'); // click 2: copy
    if (!await waitForText(A, 'invite link copied', 8000)) {
      throw new Error('Copy Invite Link via header menu (2 clicks) did not confirm');
    }
    return 'invite copied in 2 clicks';
  });

  // ----- LEAVE SERVER (member B, 2 clicks) -----
  await step('B:leave-server', async () => {
    await enterServer(B, serverName);
    const before = await serverMemberCount(B);
    await openServerMenu(B);                  // click 1
    await clickMenuItem(B, 'Leave Server');   // click 2 (confirm auto-accepted)
    const railBtn = B.page.getByRole('button', { name: new RegExp('^Server: ' + serverName, 'i') });
    for (let i = 0; i < 20; i++) {
      if (!(await railBtn.count())) return `left (was ${before} members)`;
      await wait(B.page, 800);
    }
    throw new Error('server still in B rail after Leave Server');
  });
  await B.shot('11-left-server');

  // ----- OWNER A sees the membership drop (P2P sync.leave reached the owner) -----
  await step('A:sees-member-left', async () => {
    await enterServer(A, serverName);
    for (let i = 0; i < 30; i++) {
      if ((await serverMemberCount(A)) === 1) return 'owner roster dropped to 1';
      await wait(A.page, 1000);
    }
    throw new Error('owner A never saw B leave (member count did not drop to 1)');
  });

  // ----- DELETE SERVER (owner A, 2 clicks) -----
  await step('A:delete-server', async () => {
    await enterServer(A, serverName);
    await openServerMenu(A);                  // click 1
    await clickMenuItem(A, 'Delete Server');  // click 2 (confirm auto-accepted)
    const railBtn = A.page.getByRole('button', { name: new RegExp('^Server: ' + serverName, 'i') });
    for (let i = 0; i < 20; i++) {
      if (!(await railBtn.count())) return 'server deleted from A rail';
      await wait(A.page, 800);
    }
    throw new Error('server still in A rail after Delete Server');
  });
  await A.shot('12-deleted-server');

} catch (e) {
  console.error('FATAL', e);
} finally {
  for (const peer of [A, B]) { await peer.dumpLogs(); await peer.shot('99-final'); }
  await writeFile(path.join(EVIDENCE, 'results.json'), JSON.stringify(results, null, 2));
  await writeFile(path.join(EVIDENCE, 'peers.json'), JSON.stringify({ A: A.peerId, B: B.peerId, nameA, nameB, serverName, inviteLink }, null, 2));
  const passed = results.filter(r => r.ok).length;
  console.log(`\n==== ${passed}/${results.length} steps passed ====`);
  console.log('Failures:', results.filter(r => !r.ok).map(r => r.name).join(', ') || 'none');
  await A.close(); await B.close();
}
