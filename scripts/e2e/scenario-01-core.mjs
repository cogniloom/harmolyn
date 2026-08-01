// Scenario 01: the core two-client path.
// Alice registers, creates a server, posts. Bob registers, joins via invite,
// sees Alice's message (history sync over P2P), replies; Alice sees the reply.
// Measures rough cross-client delivery latency.
import { Scenario, until } from './harness.mjs';
import { register, createServer, copyInvite, joinByInvite, sendMessage, waitForMessage } from './flows.mjs';

const s = await new Scenario('01-core').start();
try {
  const alice = await s.client('alice');
  const bob = await s.client('bob');

  const alicePeer = await s.step('alice registers', () => register(alice, 'Alice'));
  console.log(`  alice peer: ${alicePeer}`);

  await s.step('alice creates server', () => createServer(alice, 'Test Hub'));

  await s.step('alice composer is enabled (native engine active)', async () => {
    await until(async () => {
      const disabled = await alice.page.getByRole('button', { name: 'Send Message' }).isDisabled();
      const box = alice.page.getByRole('textbox', { name: 'Message Input' });
      await box.fill('probe');
      const stillDisabled = await alice.page.getByRole('button', { name: 'Send Message' }).isDisabled();
      await box.fill('');
      return !disabled || !stillDisabled;
    }, { what: 'composer enabled', timeout: 15000 });
  });

  await s.step('alice sends first message', async () => {
    await sendMessage(alice, 'hello from alice');
    await waitForMessage(alice, 'hello from alice', 10000);
  });

  const invite = await s.step('alice copies invite', () => copyInvite(alice));
  console.log(`  invite: ${invite.slice(0, 90)}...`);

  const bobPeer = await s.step('bob registers', () => register(bob, 'Bob'));
  console.log(`  bob peer: ${bobPeer}`);

  await s.step('bob joins via invite', () => joinByInvite(bob, invite, 'Test Hub'));
  await s.shot(bob, 'bob-joined');

  await s.step('bob sees #general and restores owner-authorized history', async () => {
    await bob.page.getByRole('button', { name: 'general' }).click();
    await bob.page.getByText('Welcome to #general').waitFor({ timeout: 20000 });
    await waitForMessage(bob, 'hello from alice', 20000);
  });

  await s.step('alice posts after the join; bob receives (latency A→B)', async () => {
    const t0 = Date.now();
    await sendMessage(alice, 'welcome bob!');
    await waitForMessage(bob, 'welcome bob!', 30000);
    console.log(`  cross-client delivery A->B: ${Date.now() - t0}ms`);
  });

  await s.step('bob replies; alice receives (latency B→A)', async () => {
    const t0 = Date.now();
    await sendMessage(bob, 'hi alice, bob here');
    await waitForMessage(alice, 'hi alice, bob here', 30000);
    console.log(`  cross-client delivery B->A: ${Date.now() - t0}ms`);
  });

  await s.step('alice sees bob in member list', async () => {
    await until(async () => (await alice.page.locator('body').innerText()).includes('Bob'),
      { what: 'Bob in member list', timeout: 20000 });
  });

  await s.shot(alice, 'alice-final');
  await s.shot(bob, 'bob-final');
} finally {
  await s.finish();
}
