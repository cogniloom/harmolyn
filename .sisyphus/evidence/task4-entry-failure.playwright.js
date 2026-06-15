async (page) => {
  const runtime = {
    role: 'client',
    peer_id: 'peer-local',
    control_endpoint: 'http://xorein.local',
    identity: {
      id: 'identity-local',
      peer_id: 'peer-local',
      public_key: 'local-pub',
      profile: { display_name: 'Local User', bio: 'Connected test user' },
      created_at: '2026-04-22T00:00:00Z',
    },
    known_peers: [
      { peer_id: 'peer-local', role: 'client', addresses: ['127.0.0.1:4100'], public_key: 'local-pub', source: 'self', last_seen_at: '2026-04-22T00:00:00Z' },
    ],
    servers: [],
    dms: [],
    messages: [],
    voice_sessions: [],
    settings: { control_endpoint: 'http://xorein.local' },
    telemetry: [],
  };

  await page.context().addInitScript((nextRuntime) => {
    const nativeFetch = window.fetch.bind(window);
    localStorage.setItem('harmolyn_onboarding_dismissed', 'true');
    localStorage.setItem('harmolyn:xorein:control-token', 'bridge-token');
    localStorage.setItem('harmolyn:xorein:runtime', JSON.stringify(nextRuntime));
    localStorage.setItem('harmolyn:xorein:session', 'null');
    window.__HARMOLYN_XOREIN_CONTROL_TOKEN__ = 'bridge-token';
    window.__HARMOLYN_XOREIN_RUNTIME__ = nextRuntime;
    window.__HARMOLYN_XOREIN_SESSION__ = null;
    window.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const method = (init?.method || 'GET').toUpperCase();
      if (!url.startsWith('http://xorein.local/')) {
        return nativeFetch(input, init);
      }
      const path = new URL(url).pathname;
      if (method === 'GET' && path === '/v1/state') {
        return new Response(JSON.stringify(nextRuntime), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ code: 'preview_failed', message: 'unexpected network call' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    };
  }, runtime);
  await page.goto('http://127.0.0.1:8090/');
  await page.setViewportSize({ width: 1440, height: 1100 });

  await page.getByTestId('server-rail-explore').click();
  await page.getByRole('button', { name: /open join modal/i }).click();
  await page.getByPlaceholder('aether://join/server-id?invite=...').first().fill('harmolyn.gg/not-supported');
  await page.waitForTimeout(700);
  await page.waitForSelector('[role="alert"]');
  await page.screenshot({ path: '.sisyphus/evidence/task-4-entry-failure.png', fullPage: true });

  return {
    error: await page.locator('[role="alert"]').innerText(),
    serverCount: runtime.servers.length,
  };
}
