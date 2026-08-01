// Scenario 03: messaging depth — edit, delete, reply, reactions, pins, polls,
// mentions, search, markdown — with two clients in one server (#general).
// Assumes a current Xorein node/browser gateway and Vite on :8080 are running.
import { Scenario, until } from './harness.mjs';
import { register, createServer, copyInvite, joinByInvite, sendMessage, waitForMessage } from './flows.mjs';

const s = await new Scenario('03-messaging').start();
const notes = []; // report-only observations (never fail a step)
const note = (msg) => { notes.push(msg); console.log(`  note: ${msg}`); };

/** Hover a message (by its text) and click one of its hover-bar actions. */
async function msgAction(c, text, label) {
  const row = c.page.getByText(text, { exact: false }).first();
  for (let attempt = 0; attempt < 3; attempt++) {
    await row.scrollIntoViewIfNeeded().catch(() => {});
    await row.hover();
    const btn = c.page.getByRole('button', { name: label, exact: true }).first();
    try {
      await btn.waitFor({ timeout: 2500 });
      await c.page.waitForTimeout(200); // let the zoom-in animation settle
      await btn.click();
      return;
    } catch {
      // wiggle the pointer to force a fresh mouseenter on the row
      await c.page.getByRole('textbox', { name: 'Message Input' }).hover().catch(() => {});
      await c.page.waitForTimeout(250);
    }
  }
  throw new Error(`hover action "${label}" not reachable on message "${text}" for ${c.name}`);
}

/** Numeric unread count on the Inbox header button (0 if no badge). */
async function inboxBadge(c) {
  const btn = c.page.getByRole('button', { name: 'Inbox', exact: true });
  if (!(await btn.count())) return 0;
  const t = (await btn.innerText()).trim();
  const m = t.match(/\d+/);
  return m ? parseInt(m[0], 10) : 0;
}

const bodyText = (c) => c.page.locator('body').innerText();

try {
  const alice = await s.client('alice');
  const bob = await s.client('bob');

  // ---------- setup (same shape as scenario-01) ----------
  await s.step('setup: alice registers', () => register(alice, 'Alice'));
  await s.step('setup: alice creates server', () => createServer(alice, 'Msg Lab'));
  await s.step('setup: alice composer enabled', async () => {
    await until(async () => {
      const box = alice.page.getByRole('textbox', { name: 'Message Input' });
      await box.fill('probe');
      const disabled = await alice.page.getByRole('button', { name: 'Send Message' }).isDisabled();
      await box.fill('');
      return !disabled;
    }, { what: 'alice composer enabled', timeout: 15000 });
  });
  const invite = await s.step('setup: alice copies invite', () => copyInvite(alice));
  await s.step('setup: bob registers', () => register(bob, 'Bob'));
  await s.step('setup: bob joins via invite', () => joinByInvite(bob, invite, 'Msg Lab'));
  await s.step('setup: bob opens #general', async () => {
    await bob.page.getByRole('button', { name: 'general' }).click();
    await bob.page.getByText('Welcome to #general').waitFor({ timeout: 20000 });
  });

  // ---------- 1. plain send A -> B ----------
  await s.step('1. alice sends; bob receives', async () => {
    const t0 = Date.now();
    await sendMessage(alice, 'checkpoint alpha message');
    await waitForMessage(bob, 'checkpoint alpha message', 30000);
    console.log(`  delivery A->B: ${Date.now() - t0}ms`);
  });

  // ---------- 2. edit ----------
  await s.step('2. alice edits her message; bob sees the new text', async () => {
    await msgAction(alice, 'checkpoint alpha message', 'Edit Message');
    const editBox = alice.page.locator('input:focus');
    await editBox.waitFor({ timeout: 5000 });
    await editBox.fill('checkpoint alpha message v2 revised');
    await editBox.press('Enter');
    await waitForMessage(alice, 'v2 revised', 10000);
    if ((await bodyText(alice)).includes('(edited)')) note('edited marker "(edited)" shown on sender (alice)');
    else note('NO edited marker on sender (alice) after edit');
    const t0 = Date.now();
    await waitForMessage(bob, 'v2 revised', 30000);
    console.log(`  edit propagation A->B: ${Date.now() - t0}ms`);
    if ((await bodyText(bob)).includes('(edited)')) note('edited marker "(edited)" shown on receiver (bob)');
    else note('NO edited marker on receiver (bob) — edit renders as plain new text');
    await s.shot(bob, 'bob-sees-edit');
  });

  // ---------- 3. delete (with confirm modal) ----------
  await s.step('3. alice deletes a message via confirm modal; it tombstones for bob', async () => {
    await sendMessage(alice, 'ephemeral zulu message');
    await waitForMessage(bob, 'ephemeral zulu message', 30000);
    const deletedOnAlice = async () => {
      const t = await bodyText(alice);
      return !t.includes('ephemeral zulu message') || t.includes('Message deleted');
    };
    // Confirm-modal click can race its zoom-in animation (a missed click lands on the
    // backdrop and cancels) — retry the whole sequence once if the message survives.
    for (let attempt = 0; attempt < 2 && !(await deletedOnAlice()); attempt++) {
      await msgAction(alice, 'ephemeral zulu message', 'Delete Message');
      const dialog = alice.page.getByRole('alertdialog', { name: 'Delete message' });
      await dialog.waitFor({ timeout: 5000 });
      await alice.page.waitForTimeout(300); // let the modal animation settle
      await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
      await until(deletedOnAlice, { what: 'alice sees delete/tombstone', timeout: 8000 }).catch(() => {});
    }
    if (!(await deletedOnAlice())) throw new Error('delete did not take effect on alice after 2 attempts');
    if ((await bodyText(alice)).includes('Message deleted')) note('delete renders a "Message deleted" tombstone on alice');
    const t0 = Date.now();
    await until(async () => {
      const t = await bodyText(bob);
      return !t.includes('ephemeral zulu message') || t.includes('Message deleted');
    }, { what: 'bob sees delete/tombstone', timeout: 30000 });
    console.log(`  delete propagation A->B: ${Date.now() - t0}ms`);
    if ((await bodyText(bob)).includes('Message deleted')) note('bob sees "Message deleted" tombstone (content stripped)');
    else note('deleted message fully disappears on bob (no tombstone)');
    await s.shot(bob, 'bob-after-delete');
  });

  // ---------- 4. reply ----------
  await s.step('4. bob replies to alice; reference renders on both clients', async () => {
    await sendMessage(alice, 'reply-target quebec what is the plan');
    await waitForMessage(bob, 'reply-target quebec', 30000);
    await msgAction(bob, 'reply-target quebec', 'Reply');
    await bob.page.getByRole('button', { name: 'Cancel reply' }).waitFor({ timeout: 5000 });
    await sendMessage(bob, 'replying tango plan confirmed');
    await waitForMessage(alice, 'replying tango plan confirmed', 30000);
    // HARD: a reply row renders a quoted snippet of the target above the reply,
    // duplicating the target text — on BOTH clients. (handleSendMessage's online
    // path now carries { replyTo } on the wire; fixed after the round-10 E2E.)
    await until(async () =>
      (await alice.page.getByText('reply-target quebec', { exact: false }).count()) >= 2 &&
      (await bob.page.getByText('reply-target quebec', { exact: false }).count()) >= 2,
    { what: 'reply reference (quoted snippet) on both clients', timeout: 15000 });
    await s.shot(alice, 'alice-sees-reply');
    await s.shot(bob, 'bob-sent-reply');
  });

  // ---------- 5. reactions ----------
  await s.step('5a. bob reacts 👍; alice sees the reaction', async () => {
    await msgAction(bob, 'reply-target quebec', 'Add Reaction');
    await bob.page.getByRole('button', { name: '👍', exact: true }).first().click();
    await bob.page.getByRole('button', { name: /👍\s*1/ }).waitFor({ timeout: 10000 });
    const t0 = Date.now();
    await alice.page.getByRole('button', { name: /👍\s*1/ }).waitFor({ timeout: 30000 });
    console.log(`  reaction propagation B->A: ${Date.now() - t0}ms`);
  });
  await s.step('5b. alice adds the same reaction; count reaches 2 on BOTH clients', async () => {
    await alice.page.getByRole('button', { name: /👍\s*1/ }).click();
    await alice.page.getByRole('button', { name: /👍\s*2/ }).waitFor({ timeout: 10000 });
    // HARD: bob must also reach 👍 2. (mergePersistedMessages now lets the LIVE
    // runtime copy win over a stale persisted copy — remote reaction/edit/pin
    // updates land even after a client has persisted the scope; fixed after the
    // round-10 E2E.)
    await bob.page.getByRole('button', { name: /👍\s*2/ }).waitFor({ timeout: 15000 });
    await s.shot(alice, 'reaction-count-alice');
    await s.shot(bob, 'reaction-count-bob');
  });

  // ---------- 6. pins ----------
  await s.step('6. alice pins a message and sees it in the pinned panel', async () => {
    await msgAction(alice, 'reply-target quebec', 'Pin');
    await alice.page.getByRole('button', { name: 'Pinned Messages', exact: true }).click();
    const drawer = alice.page.locator('div.slide-in-from-right');
    await drawer.getByText('PINNED // MESSAGES').waitFor({ timeout: 8000 });
    await drawer.getByText('reply-target quebec').waitFor({ timeout: 8000 });
    await s.shot(alice, 'alice-pinned-panel');
    // close via backdrop
    await alice.page.locator('div.bg-black\\/40').click({ position: { x: 200, y: 300 } });
    // report-only: does bob's pinned panel show it?
    try {
      await bob.page.getByRole('button', { name: 'Pinned Messages', exact: true }).click();
      const bobDrawer = bob.page.locator('div.slide-in-from-right');
      await bobDrawer.getByText('reply-target quebec').waitFor({ timeout: 12000 });
      note('PIN SYNC: bob\'s pinned panel ALSO shows the pinned message');
    } catch {
      note('PIN SYNC: bob\'s pinned panel does NOT show alice\'s pin (pin appears local/not synced to bob)');
      await s.shot(bob, 'bob-pinned-panel-empty');
    }
    await bob.page.locator('div.bg-black\\/40').click({ position: { x: 200, y: 300 } }).catch(() => {});
  });

  // ---------- 7. poll ----------
  await s.step('7a. alice creates a 2-option poll; bob sees it', async () => {
    await alice.page.getByRole('button', { name: 'Create Poll', exact: true }).click();
    const creator = alice.page.getByRole('dialog', { name: 'Create poll' });
    await creator.waitFor({ timeout: 5000 });
    await creator.getByPlaceholder('Ask something...').fill('Tabs or spaces?');
    await creator.getByRole('textbox', { name: 'Option 1' }).fill('Tabs');
    await creator.getByRole('textbox', { name: 'Option 2' }).fill('Spaces');
    await creator.getByRole('button', { name: 'Create Poll', exact: true }).click();
    await waitForMessage(alice, 'Tabs or spaces?', 10000);
    if ((await bodyText(alice)).includes('🗳️ POLL:')) note('PAPERCUT: raw "🗳️ POLL:{json}" payload text renders alongside the poll card');
    await waitForMessage(bob, 'Tabs or spaces?', 30000);
    await s.shot(bob, 'bob-sees-poll');
  });
  await s.step('7b. bob votes; alice sees the vote count live', async () => {
    await bob.page.getByRole('button', { name: 'Tabs', exact: true }).first().click();
    await until(async () => /1 VOTE(?!S)/.test(await bodyText(bob)), { what: 'bob sees own vote count', timeout: 10000 });
    // HARD: a vote must reach the other client's rendered poll without any
    // remount. Regression guard for two defects that both hid it: data.ts
    // dropping poll_votes on every merge tick, and PollMessage freezing its
    // vote state at mount.
    await until(async () => /1 VOTE(?!S)/.test(await bodyText(alice)),
      { what: 'alice sees the vote count live (no remount)', timeout: 15000 });
    await s.shot(alice, 'alice-poll-votes');
    await s.shot(bob, 'bob-poll-votes');
  });

  // ---------- 8. mention ----------
  await s.step('8. bob @mentions alice; alice gets an inbox/mention indicator', async () => {
    const before = await inboxBadge(alice);
    console.log(`  alice inbox badge before mention: ${before}`);
    const box = bob.page.getByRole('textbox', { name: 'Message Input' });
    await box.click();
    await box.pressSequentially('@Al', { delay: 80 });
    await bob.page.getByRole('listbox', { name: 'Member mentions' }).waitFor({ timeout: 8000 });
    await bob.page.getByRole('option', { name: /Alice/ }).click();
    const val = await box.inputValue();
    if (!val.includes('@Alice')) throw new Error(`autocomplete did not insert @Alice (composer="${val}")`);
    await box.fill(`${val.trimEnd()} ping whiskey from bob`);
    await bob.page.getByRole('button', { name: 'Send Message' }).click();
    await waitForMessage(alice, 'ping whiskey from bob', 30000);
    await until(async () => (await inboxBadge(alice)) > before,
      { what: `alice inbox badge > ${before} after mention`, timeout: 15000 });
    console.log(`  alice inbox badge after mention: ${await inboxBadge(alice)}`);
    await alice.page.getByRole('button', { name: 'Inbox', exact: true }).click();
    await alice.page.getByText('INBOX', { exact: true }).waitFor({ timeout: 5000 });
    await s.shot(alice, 'alice-inbox-panel');
    if (/mention/i.test(await bodyText(alice))) note('inbox panel lists a mention entry');
    // panel sits below the header, the Inbox button stays clickable — toggle closed
    await alice.page.getByRole('button', { name: 'Inbox', exact: true }).click();
  });

  // ---------- 9. search ----------
  await s.step('9. alice searches a sent word; list filters to the match', async () => {
    // The header "Search..." control is an inline filter textbox (aria "Search messages").
    const box = alice.page.getByRole('textbox', { name: 'Search messages', exact: true });
    await box.fill('quebec');
    await until(async () => {
      const t = await bodyText(alice);
      return t.includes('reply-target quebec') && !t.includes('checkpoint alpha message');
    }, { what: 'inline search filters the message list to the match', timeout: 10000 });
    await s.shot(alice, 'alice-search-results');
    await box.fill('');
    await until(async () => (await bodyText(alice)).includes('checkpoint alpha message'),
      { what: 'search cleared restores the list', timeout: 10000 });
    // The full SearchPanel is reachable via the header "Advanced search" button
    // (and Ctrl+F) — open it, confirm the dialog renders, and close it again.
    await alice.page.getByRole('button', { name: 'Advanced search', exact: true }).click();
    const dialog = alice.page.getByRole('dialog', { name: 'Search messages' });
    await dialog.waitFor({ timeout: 8000 });
    await s.shot(alice, 'alice-advanced-search');
    await dialog.getByRole('button', { name: 'Close search' }).click();
    await until(async () => (await dialog.count()) === 0, { what: 'advanced search closed', timeout: 8000 });
  });

  // ---------- 10. markdown bold ----------
  await s.step('10. **bold** markdown renders bold for the receiver', async () => {
    await sendMessage(alice, 'Status update: the **midnight protocol** is now live. Rollout continues tomorrow at dawn.');
    await waitForMessage(bob, 'midnight protocol', 30000);
    await bob.page.locator('strong', { hasText: 'midnight protocol' }).first().waitFor({ timeout: 10000 });
    const raw = (await bodyText(bob)).includes('**midnight protocol**');
    if (raw) note('receiver ALSO shows raw ** asterisks (markdown not stripped)');
    await s.shot(bob, 'bob-bold-render');
  });

  // soft cross-checks on identity resolution
  if (!(await bodyText(bob)).includes('Alice')) {
    note('DEFECT: bob never sees the username "Alice" anywhere — member list shows a raw peer id (12D3Ko…) for the server owner');
  }
  await s.shot(alice, 'alice-final');
  await s.shot(bob, 'bob-final');
} finally {
  if (notes.length) {
    console.log('\nObservations:');
    for (const n of notes) console.log(`  - ${n}`);
  }
  await s.finish();
}
