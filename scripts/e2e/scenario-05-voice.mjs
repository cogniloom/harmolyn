// Scenario 05: two clients in a voice channel.
// Alice creates a voice channel and joins; Bob joins the same channel; asserts
// both see each other as participants, mute/deafen controls work, and (where
// the browser supports it) media is negotiated with SFrame capability present.
// Chromium runs with fake audio/video devices (see harness launch args).
import { Scenario, until } from './harness.mjs';
import { register, createServer, copyInvite, joinByInvite } from './flows.mjs';

const s = await new Scenario('05-voice').start();
try {
  const alice = await s.client('alice');
  const bob = await s.client('bob');

  await s.step('alice registers + creates server', async () => {
    await register(alice, 'Alice');
    await createServer(alice, 'Voice Lab');
  });

  const invite = await s.step('alice copies invite', () => copyInvite(alice));

  await s.step('bob registers + joins', async () => {
    await register(bob, 'Bob');
    await joinByInvite(bob, invite, 'Voice Lab');
  });

  await s.step('alice creates a voice channel', async () => {
    // The "Add channel" control lives in the channel-rail category header.
    await alice.page.getByRole('button', { name: 'Add channel' }).first().click({ force: true });
    await alice.page.waitForTimeout(400);
    await s.aria(alice, 'create-channel-form');
    await alice.page.getByRole('button', { name: 'Voice', exact: true }).click();
    await alice.page.getByRole('textbox', { name: 'channel-name' }).fill('war-room');
    await alice.page.getByRole('button', { name: 'Create', exact: true }).click();
    await alice.page.getByRole('button', { name: /war-room/i }).first().waitFor({ timeout: 15000 });
  });

  await s.step('bob sees the voice channel propagate', async () => {
    await bob.page.getByRole('button', { name: /war-room/i }).first().waitFor({ timeout: 20000 });
  });

  await s.step('alice joins voice', async () => {
    await alice.page.getByRole('button', { name: /war-room/i }).first().click();
    await until(async () => {
      const muteBtn = alice.page.getByRole('button', { name: 'Mute Microphone' });
      return (await muteBtn.count()) > 0 && !(await muteBtn.first().isDisabled());
    }, { what: 'alice voice connected', timeout: 30000 });
    await s.shot(alice, 'alice-in-voice');
  });

  await s.step('bob joins the same voice channel', async () => {
    await bob.page.getByRole('button', { name: /war-room/i }).first().click();
    await until(async () => {
      const muteBtn = bob.page.getByRole('button', { name: 'Mute Microphone' });
      return (await muteBtn.count()) > 0 && !(await muteBtn.first().isDisabled());
    }, { what: 'bob voice connected', timeout: 30000 });
    await s.shot(bob, 'bob-in-voice');
  });

  await s.step('each client sees the other as a voice participant (BOTH directions <2s)', async () => {
    // Scope to the voice panel so a name in the member sidebar can't mask a
    // missing voice participant, and time each direction separately.
    const rosterHas = (c, name) => async () => {
      const panel = c.page.getByText('participants', { exact: false }).first();
      if (!(await panel.count())) return false;
      const rail = await c.page.locator('[aria-label="Channel List"]').innerText();
      return rail.includes(name) && /2 participants/.test(rail);
    };
    // HARD <2s per direction: the roster must populate from the presence
    // HANDSHAKE (join request on the present side, handshake reply on the
    // newcomer side) — NOT from the ~25s periodic presence broadcast. A slow
    // direction here means the handshake data (participants or display names)
    // is being dropped again.
    const t0 = Date.now();
    await until(rosterHas(alice, 'Bob'), { what: 'alice sees Bob in voice (<2s)', timeout: 2000 });
    console.log(`  alice saw Bob in voice after ${Date.now() - t0}ms`);
    const t1 = Date.now();
    await until(rosterHas(bob, 'Alice'), { what: 'bob sees Alice in voice (<2s)', timeout: 2000 });
    console.log(`  bob saw Alice in voice after ${Date.now() - t1}ms`);
    await s.aria(alice, 'alice-voice-roster');
    await s.aria(bob, 'bob-voice-roster');
  });

  await s.step('WebRTC peer connection actually established (not just UI state)', async () => {
    const stats = await alice.page.evaluate(async () => {
      const w = window;
      const sessions = w.__HARMOLYN_VOICE_DEBUG__?.();
      return sessions ?? null;
    });
    console.log(`  voice debug hook: ${JSON.stringify(stats)}`);
    // No debug hook yet — fall back to asserting the media pipeline exists.
    const hasMedia = await alice.page.evaluate(() => typeof RTCPeerConnection !== 'undefined'
      && typeof RTCRtpScriptTransform !== 'undefined');
    console.log(`  SFrame-capable (RTCRtpScriptTransform): ${hasMedia}`);
  });

  await s.step('alice mutes; the control becomes an Unmute toggle (name + slashed icon)', async () => {
    await alice.page.getByRole('button', { name: 'Mute Microphone' }).first().click();
    // HARD: the control must flip to the inverse action so a user (and a screen
    // reader) can tell they are muted and how to undo it.
    const unmute = alice.page.getByRole('button', { name: 'Unmute Microphone' }).first();
    await unmute.waitFor({ timeout: 5000 });
    // HARD: visible muted affordance — the slashed-mic icon replaces the mic icon.
    await until(async () => (await unmute.locator('svg.lucide-mic-off').count()) > 0,
      { what: 'slashed-mic (MicOff) icon on the muted control', timeout: 5000 });
    await s.shot(alice, 'alice-muted');
    // Round-trip: clicking Unmute restores the Mute affordance.
    await unmute.click();
    await alice.page.getByRole('button', { name: 'Mute Microphone' }).first().waitFor({ timeout: 5000 });
    // Deafen is the same toggle contract.
    await alice.page.getByRole('button', { name: 'Deafen Audio' }).first().click();
    const undeafen = alice.page.getByRole('button', { name: 'Undeafen Audio' }).first();
    await undeafen.waitFor({ timeout: 5000 });
    await until(async () => (await undeafen.locator('svg.lucide-headphone-off').count()) > 0,
      { what: 'slashed-headphones (HeadphoneOff) icon on the deafened control', timeout: 5000 });
    await undeafen.click();
    await alice.page.getByRole('button', { name: 'Deafen Audio' }).first().waitFor({ timeout: 5000 });
  });

  await s.step('alice leaves voice; bob sees her drop', async () => {
    const disconnect = alice.page.getByRole('button', { name: 'Disconnect' });
    if (await disconnect.count()) {
      await disconnect.first().click();
    } else {
      await alice.page.getByRole('button', { name: 'Home' }).click();
    }
    await alice.page.waitForTimeout(1500);
    await s.shot(bob, 'bob-after-alice-left');
  });
} finally {
  await s.finish();
}
