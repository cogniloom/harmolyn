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
      { peer_id: 'peer-owner-created', role: 'client', addresses: ['127.0.0.1:4101'], public_key: 'owner-created', source: 'bootstrap', last_seen_at: '2026-04-22T00:00:00Z' },
      { peer_id: 'peer-owner-joined', role: 'archivist', addresses: ['127.0.0.1:4102'], public_key: 'owner-joined', source: 'bootstrap', last_seen_at: '2026-04-22T00:00:00Z' },
    ],
    servers: [],
    dms: [],
    messages: [],
    voice_sessions: [],
    settings: { control_endpoint: 'http://xorein.local' },
    telemetry: [],
  };

  const makeServer = ({ id, name, description, ownerPeerId, invite }) => ({
    id,
    name,
    description,
    owner_peer_id: ownerPeerId,
    created_at: '2026-04-22T00:00:00Z',
    updated_at: '2026-04-22T00:00:00Z',
    members: ['peer-local', ownerPeerId],
    channels: {
      [`${id}-general`]: {
        id: `${id}-general`,
        server_id: id,
        name: 'general',
        voice: false,
        created_at: '2026-04-22T00:00:00Z',
      },
    },
    manifest: {
      server_id: id,
      name,
      description,
      owner_peer_id: ownerPeerId,
      owner_public_key: `${ownerPeerId}-pub`,
      owner_addresses: ['127.0.0.1:4101'],
      capabilities: ['cap.chat', 'cap.manifest'],
      issued_at: '2026-04-22T00:00:00Z',
      updated_at: '2026-04-22T00:00:00Z',
      signature: 'signed-manifest',
      history_coverage: 'local-window',
    },
    invite,
  });

  await page.context().addInitScript((nextRuntime) => {
    const makeServer = ({ id, name, description, ownerPeerId, invite }) => ({
      id,
      name,
      description,
      owner_peer_id: ownerPeerId,
      created_at: '2026-04-22T00:00:00Z',
      updated_at: '2026-04-22T00:00:00Z',
      members: ['peer-local', ownerPeerId],
      channels: {
        [`${id}-general`]: {
          id: `${id}-general`,
          server_id: id,
          name: 'general',
          voice: false,
          created_at: '2026-04-22T00:00:00Z',
        },
      },
      manifest: {
        server_id: id,
        name,
        description,
        owner_peer_id: ownerPeerId,
        owner_public_key: `${ownerPeerId}-pub`,
        owner_addresses: ['127.0.0.1:4101'],
        capabilities: ['cap.chat', 'cap.manifest'],
        issued_at: '2026-04-22T00:00:00Z',
        updated_at: '2026-04-22T00:00:00Z',
        signature: 'signed-manifest',
        history_coverage: 'local-window',
      },
      invite,
    });
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
      const body = typeof init?.body === 'string' && init.body ? JSON.parse(init.body) : null;
      if (method === 'GET' && path === '/v1/state') {
        return new Response(JSON.stringify(nextRuntime), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (method === 'POST' && path === '/v1/servers') {
        nextRuntime.servers = [makeServer({
          id: 'alpha-node',
          name: body.name,
          description: body.description || '',
          ownerPeerId: 'peer-owner-created',
          invite: 'aether://join/alpha-node?invite=signed-alpha',
        })];
        return new Response(JSON.stringify(nextRuntime.servers[0]), { status: 201, headers: { 'Content-Type': 'application/json' } });
      }
      if (method === 'POST' && path === '/v1/servers/preview') {
        if (body.deeplink === 'aether://join/beta-node?invite=signed-beta') {
          return new Response(JSON.stringify({
            invite: { server_id: 'beta-node', expires_at: '2026-04-23T00:00:00Z' },
            manifest: {
              server_id: 'beta-node',
              name: 'Beta Node',
              description: 'Joined through a signed invite.',
              history_coverage: 'local-window',
            },
            owner_role: 'archivist',
            member_count: 2,
            channels: [{ id: 'beta-node-general', server_id: 'beta-node', name: 'general', voice: false, created_at: '2026-04-22T00:00:00Z' }],
            safety_labels: ['owner-archivist'],
          }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        return new Response(JSON.stringify({ code: 'preview_failed', message: 'invite not recognized' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
      if (method === 'POST' && path === '/v1/servers/join') {
        nextRuntime.servers = [
          ...nextRuntime.servers,
          makeServer({
            id: 'beta-node',
            name: 'Beta Node',
            description: 'Joined through a signed invite.',
            ownerPeerId: 'peer-owner-joined',
            invite: body.deeplink,
          }),
        ];
        return new Response(JSON.stringify(nextRuntime.servers[nextRuntime.servers.length - 1]), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ code: 'not_found', message: `${method} ${path}` }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    };
  }, runtime);
  await page.goto('http://127.0.0.1:8090/');
  await page.setViewportSize({ width: 1440, height: 1100 });

  await page.getByTestId('server-rail-create').click();
  await page.getByPlaceholder('THE // HUB').fill('Alpha Node');
  await page.getByRole('button', { name: 'Initiate Matrix' }).click();
  await page.waitForSelector('[aria-label="Server: Alpha Node"]');

  await page.getByTestId('server-rail-explore').click();
  await page.getByRole('button', { name: /open join modal/i }).click();
  await page.getByPlaceholder('aether://join/server-id?invite=...').first().fill('aether://join/beta-node?invite=signed-beta');
  await page.waitForFunction(() => {
    const buttons = [...document.querySelectorAll('button')];
    return buttons.some((button) => button.textContent?.includes('Join Server') && !button.hasAttribute('disabled'));
  });
  await page.getByRole('button', { name: 'Join Server' }).click();
  await page.waitForSelector('[aria-label="Server: Beta Node"]');
  await page.waitForFunction(() => document.body.textContent?.includes('CONNECTED'));
  await page.screenshot({ path: '.sisyphus/evidence/task-4-entry-success.png', fullPage: true });

  return {
    hasJoinedServerButton: await page.locator('[aria-label="Server: Beta Node"]').count(),
    body: await page.locator('body').innerText(),
  };
}
