// Scenario 07: cross-client delivery latency, measured in-page.
//
// The harness's DOM polling bounds how precisely latency can be observed, so
// this scenario timestamps inside the page instead: the sender records
// performance.timeOrigin-based send time, the receiver's MutationObserver
// records the moment the text lands in the DOM. Both clocks are anchored to
// Date.now() so the difference is meaningful across browser contexts.
import { Scenario, until } from './harness.mjs';
import { register, createServer, copyInvite, joinByInvite } from './flows.mjs';

const ROUNDS = Number(process.env.LATENCY_ROUNDS ?? 12);

/** Arm a receiver-side observer that resolves with the wall-clock arrival time. */
async function armArrivalWatcher(client, token) {
  await client.page.evaluate((tok) => {
    window.__arrival = new Promise((resolve) => {
      const seen = () => document.body.innerText.includes(tok);
      if (seen()) { resolve(Date.now()); return; }
      const obs = new MutationObserver(() => {
        if (seen()) { obs.disconnect(); resolve(Date.now()); }
      });
      obs.observe(document.body, { childList: true, subtree: true, characterData: true });
    });
  }, token);
}

async function sendAndMeasure(sender, receiver, token) {
  await armArrivalWatcher(receiver, token);
  const sentAt = await sender.page.evaluate(async (tok) => {
    const box = document.querySelector('[aria-label="Message Input"]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
      ?? Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    setter.call(box, tok);
    box.dispatchEvent(new Event('input', { bubbles: true }));
    const t = Date.now();
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return t;
  }, token);
  const arrivedAt = await receiver.page.evaluate(() => window.__arrival);
  return arrivedAt - sentAt;
}

function stats(samples) {
  const s = [...samples].sort((a, b) => a - b);
  const pct = (p) => s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
  return {
    n: s.length,
    min: s[0],
    p50: pct(50),
    p95: pct(95),
    max: s[s.length - 1],
    mean: Math.round(s.reduce((a, b) => a + b, 0) / s.length),
  };
}

const s = new Scenario('07-latency');
await s.start();
try {
  const alice = await s.client('alice');
  const bob = await s.client('bob');

  await s.step('two clients in one Crowd channel', async () => {
    await register(alice, 'Alice');
    await createServer(alice, 'Speed Lab');
    const invite = await copyInvite(alice);
    await register(bob, 'Bob');
    await joinByInvite(bob, invite, 'Speed Lab');
    await bob.page.getByRole('button', { name: 'general' }).click();
    // Warm the path: first message also establishes the peer connection.
    const warm = `warmup-${Date.now()}`;
    await sendAndMeasure(alice, bob, warm);
  });

  const aToB = [];
  const bToA = [];

  await s.step(`measure ${ROUNDS} round trips in each direction`, async () => {
    for (let i = 0; i < ROUNDS; i++) {
      aToB.push(await sendAndMeasure(alice, bob, `a2b-${i}-${Date.now()}`));
      bToA.push(await sendAndMeasure(bob, alice, `b2a-${i}-${Date.now()}`));
    }
  });

  await s.step('report', async () => {
    const a = stats(aToB);
    const b = stats(bToA);
    console.log(`  A->B  n=${a.n} min=${a.min}ms p50=${a.p50}ms p95=${a.p95}ms max=${a.max}ms mean=${a.mean}ms`);
    console.log(`  B->A  n=${b.n} min=${b.min}ms p50=${b.p50}ms p95=${b.p95}ms max=${b.max}ms mean=${b.mean}ms`);
    const worstP50 = Math.max(a.p50, b.p50);
    // Both peers are on loopback through a local relay circuit; a Discord-class
    // bar for same-region delivery is well under 250ms end to end.
    if (worstP50 > 250) {
      throw new Error(`median cross-client delivery ${worstP50}ms exceeds the 250ms bar`);
    }
  });
} finally {
  await s.finish();
}
