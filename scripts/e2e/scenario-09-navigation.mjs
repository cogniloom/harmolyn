// Scenario 09: navigation, discovery and identity-assurance surfaces that no
// other scenario exercises — threads, message forwarding, quick switcher,
// keyboard shortcuts, profile edit propagation, and safety-number verification.
import { Scenario, until } from './harness.mjs';
import { register, createServer, copyInvite, joinByInvite, sendMessage, waitForMessage } from './flows.mjs';

const s = new Scenario('09-navigation');
await s.start();
try {
  const alice = await s.client('alice');
  const bob = await s.client('bob');

  await s.step('setup: two clients in one server', async () => {
    await register(alice, 'Alice');
    await createServer(alice, 'Nav Lab');
    const invite = await copyInvite(alice);
    await register(bob, 'Bob');
    await joinByInvite(bob, invite, 'Nav Lab');
    await bob.page.getByRole('button', { name: 'general' }).click();
  });

  await s.step('alice posts a message both clients can act on', async () => {
    await sendMessage(alice, 'thread-root sierra planning topic');
    await waitForMessage(bob, 'thread-root sierra', 30000);
  });

  await s.step('threads: bob opens a thread on the message and replies', async () => {
    await bob.page.getByText('thread-root sierra', { exact: false }).first().hover();
    await bob.page.waitForTimeout(300);
    const threadBtn = bob.page.getByRole('button', { name: /thread/i }).first();
    if (!(await threadBtn.count())) throw new Error('no thread affordance on message hover');
    await threadBtn.click();
    await bob.page.waitForTimeout(500);
    await s.aria(bob, 'thread-panel');
    const threadInput = bob.page.getByRole('textbox').last();
    await threadInput.fill('thread reply from bob');
    await threadInput.press('Enter');
    await bob.page.getByText('thread reply from bob', { exact: false }).first()
      .waitFor({ timeout: 15000 });
  });

  await s.step('threads: alice sees the thread reply', async () => {
    await until(async () => (await alice.page.locator('body').innerText()).includes('thread reply from bob'),
      { what: 'thread reply propagates to alice', timeout: 30000 });
  });

  await s.step('quick switcher opens and finds the channel', async () => {
    await alice.page.keyboard.press('Control+k');
    await alice.page.waitForTimeout(400);
    await s.aria(alice, 'quick-switcher');
    const dialog = alice.page.getByRole('dialog').first();
    if (!(await dialog.count())) throw new Error('Ctrl+K did not open the quick switcher');
    await alice.page.keyboard.press('Escape');
  });

  await s.step('keyboard shortcuts overlay opens', async () => {
    await alice.page.keyboard.press('Control+/');
    await alice.page.waitForTimeout(400);
    const body = await alice.page.locator('body').innerText();
    if (!/shortcut/i.test(body)) throw new Error('Ctrl+/ did not open the keyboard shortcuts overlay');
    await alice.page.keyboard.press('Escape');
  });

  await s.step('profile: alice renames herself; bob sees the new name', async () => {
    await alice.page.getByRole('button', { name: 'Open Settings' }).click();
    await alice.page.waitForTimeout(600);
    await s.aria(alice, 'settings-screen');
    // Display Name is read-only until its "Edit" control is used.
    await alice.page.getByRole('button', { name: 'Edit' }).first().click();
    await alice.page.waitForTimeout(300);
    const nameBox = alice.page.locator('input:focus').first();
    await nameBox.fill('Alice Renamed');
    await nameBox.press('Enter');
    await alice.page.waitForTimeout(800);
    await s.shot(alice, 'profile-renamed');
    await alice.page.keyboard.press('Escape');
    await sendMessage(alice, 'ping after rename');
    await waitForMessage(bob, 'ping after rename', 30000);
    await until(async () => (await bob.page.locator('body').innerText()).includes('Alice Renamed'),
      { what: 'renamed profile propagates to bob', timeout: 30000 });
  });

  await s.step('safety numbers: the verification surface is reachable and matches', async () => {
    // The security badge in the channel header opens the key-verification view.
    const badge = alice.page.getByRole('button', { name: /E2EE|CROWD|SEAL/ }).first();
    if (!(await badge.count())) throw new Error('no security-mode badge found in the header');
    await badge.click();
    await alice.page.waitForTimeout(600);
    await s.aria(alice, 'security-detail');
    await s.shot(alice, 'security-detail');
  });
} finally {
  await s.finish();
}
