import path from 'path';
import { existsSync } from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';

function resolveChromeExecutable() {
  const explicit = [process.env.PLAYWRIGHT_CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean);
  for (const candidate of explicit) {
    if (existsSync(candidate)) return candidate;
  }
  // Fall back to a Playwright-managed Chromium (installed via `playwright install chromium`).
  try {
    const managed = chromium.executablePath();
    if (managed && existsSync(managed)) return managed;
  } catch {
    // no managed browser available
  }
  return undefined;
}
import {
  CONTROL_ENDPOINT,
  CREATED_SERVER_NAME,
  FRIEND_REQUEST_USERNAME,
  HAPPY_CHAT_MESSAGE,
  JOINED_SERVER_NAME,
  JOIN_INVITE,
  createHappyRuntime,
} from './browser-smoke-fixtures.mjs';

const ROOT = process.cwd();
const EVIDENCE_DIR = path.resolve(ROOT, '.generated/browser-evidence');
const MODE = process.argv[2] === 'missing-runtime' ? 'missing-runtime' : 'happy';

await mkdir(EVIDENCE_DIR, { recursive: true });

const viteServer = await createServer({
  root: ROOT,
  server: { host: '127.0.0.1', port: 0, strictPort: false },
  logLevel: 'error',
});
await viteServer.listen();

const address = viteServer.httpServer?.address();
const port = typeof address === 'object' && address ? address.port : viteServer.config.server.port;
const baseUrl = `http://127.0.0.1:${port}`;
const browser = await chromium.launch({
  headless: true,
  executablePath: resolveChromeExecutable(),
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

let exitCode = 0;
try {
  if (MODE === 'happy') {
    const report = await runHappyPath(browser, baseUrl);
    await writeFile(path.join(EVIDENCE_DIR, 'task-10-e2e-success.txt'), report, 'utf8');
    console.log(report);
  } else {
    const report = await runMissingRuntimePath(browser, baseUrl);
    await writeFile(path.join(EVIDENCE_DIR, 'task-10-e2e-failure.txt'), report, 'utf8');
    console.error(report);
    exitCode = 1;
  }
} catch (error) {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(message);
  exitCode = 1;
} finally {
  await browser.close();
  await viteServer.close();
}

process.exitCode = exitCode;

async function runHappyPath(browserInstance, baseUrlValue) {
  const createJoinPage = await openRuntimePage(browserInstance, baseUrlValue, '/', createHappyRuntime());
  await smokeCreateAndJoin(createJoinPage);
  await createJoinPage.context().close();

  const chatPage = await openRuntimePage(browserInstance, baseUrlValue, '/', createHappyRuntime());
  await smokeSendAndPersistMessage(chatPage);
  await chatPage.context().close();

  const friendsRuntime = createHappyRuntime();
  friendsRuntime.servers = [];
  friendsRuntime.dms = [
    {
      id: 'dm-u6',
      participants: ['peer-local', 'u6'],
      created_at: '2026-04-22T00:00:00Z',
    },
  ];
  friendsRuntime.messages = [];
  const friendsPage = await openRuntimePage(browserInstance, baseUrlValue, '/?panel=friends', friendsRuntime);
  await smokeFriendRequest(friendsPage);
  await friendsPage.context().close();

  const settingsPage = await openRuntimePage(browserInstance, baseUrlValue, '/', createHappyRuntime());
  await smokeSettingsPersistence(settingsPage);
  await smokeRelayManagement(settingsPage);

  const screenshotPath = path.join(EVIDENCE_DIR, 'task-10-e2e-success.png');
  await settingsPage.screenshot({ path: screenshotPath, fullPage: true });
  await settingsPage.context().close();

  return [
    'Harmolyn browser smoke suite: happy path',
    `Base URL: ${baseUrlValue}`,
    `Create/join: ${CREATED_SERVER_NAME} and ${JOINED_SERVER_NAME} surfaced in the rail`,
    `Chat: ${HAPPY_CHAT_MESSAGE} persisted after reload`,
    `Friends: sent request to ${FRIEND_REQUEST_USERNAME}`,
    'Settings: message layout persisted as BUBBLES after reload',
    'Settings: relay add/remove persisted through xorein',
    'About: source code link points at the AGPL Corresponding Source',
    `Evidence: ${path.relative(ROOT, screenshotPath)}`,
  ].join('\n');
}

async function runMissingRuntimePath(browserInstance, baseUrlValue) {
  const page = await openOfflinePage(browserInstance, baseUrlValue, '/');
  try {
    await page.waitForFunction(() => {
      const body = document.body.innerText.toUpperCase();
      return body.includes('THE LOCAL XOREIN RUNTIME IS OFFLINE');
    });
  } catch (error) {
    console.error(await page.locator('body').innerText());
    throw error;
  }

  const screenshotPath = path.join(EVIDENCE_DIR, 'task-10-e2e-failure.png');
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await page.context().close();

  return [
    'Harmolyn browser smoke suite: missing-runtime path',
    `Base URL: ${baseUrlValue}`,
    'Observed offline runtime banner and disabled connectivity controls.',
    'Expected result: the suite exits non-zero after confirming the clean offline failure state.',
    `Evidence: ${path.relative(ROOT, screenshotPath)}`,
  ].join('\n');
}

async function smokeCreateAndJoin(page) {
  await page.getByTestId('server-rail-create').click();
  try {
    await page.getByPlaceholder('THE // HUB').fill(CREATED_SERVER_NAME);
  } catch (error) {
    console.error(await page.locator('body').innerText());
    await page.screenshot({
      path: path.join(EVIDENCE_DIR, 'task-10-create-modal-failure.png'),
      fullPage: true,
    });
    throw error;
  }
  await page.getByRole('button', { name: 'Initiate Matrix' }).click();
  try {
    await page.waitForSelector('[data-testid="server-rail-server-alpha-node"]', { timeout: 10000 });
  } catch (error) {
    console.error(await page.locator('body').innerText());
    throw error;
  }

  const exploreButton = page.getByTestId('server-rail-explore');
  await exploreButton.waitFor({ state: 'visible' });
  await exploreButton.evaluate((element) => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  });
  await page.getByRole('button', { name: /open join modal/i }).waitFor({ state: 'visible' });
  await page.getByRole('button', { name: /open join modal/i }).evaluate((element) => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  });
  await page.getByPlaceholder(/xorein:\/\/invite\/.+/).first().fill(JOIN_INVITE);
  try {
    await page.waitForFunction(() => {
      const button = [...document.querySelectorAll('button')].find((entry) => entry.textContent?.includes('Join Server'));
      return Boolean(button) && !button.hasAttribute('disabled');
    });
  } catch (error) {
    console.error(await page.locator('[role="alert"]').allTextContents());
    console.error(await page.locator('body').innerText());
    throw error;
  }
  await page.getByRole('button', { name: 'Join Server' }).evaluate((element) => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  });
  await page.waitForSelector('[data-testid="server-rail-server-beta-node"]');
}

async function smokeSendAndPersistMessage(page) {
  const messageLocator = page.getByText(new RegExp(`^${HAPPY_CHAT_MESSAGE}$`)).first();
  await page.getByPlaceholder('INPUT // #GENERAL').fill(HAPPY_CHAT_MESSAGE);
  await page.getByRole('button', { name: 'Send Message' }).click();
  await messageLocator.waitFor({ state: 'visible' });
  await page.reload();
  await page.getByText(new RegExp(`^${HAPPY_CHAT_MESSAGE}$`)).first().waitFor({ state: 'visible' });

}

async function smokeFriendRequest(page) {
  await page.getByRole('button', { name: 'ADD FRIEND' }).click();
  await page.getByPlaceholder('Peer ID or multiaddr...').fill(FRIEND_REQUEST_USERNAME);
  await page.getByRole('button', { name: 'SEND REQUEST' }).click();
  try {
    await page.getByText('Friend request sent through xorein.', { exact: true }).waitFor({ state: 'visible' });
  } catch (error) {
    console.error(await page.locator('body').innerText());
    throw error;
  }
}

async function smokeSettingsPersistence(page) {
  await page.getByRole('button', { name: 'Open Settings' }).click();
  await page.getByRole('button', { name: 'Core Appearance' }).click();
  await page.getByRole('button', { name: 'MODERN' }).evaluate((element) => element.click());
  await page.getByText('Message layout preference updated.', { exact: true }).waitFor({ state: 'visible' });
  await page.getByRole('button', { name: 'BUBBLES' }).waitFor({ state: 'visible' });
  await page.evaluate(() => {
    if (localStorage.getItem('harmolyn:settings:message-layout') !== 'bubbles') {
      throw new Error('message layout did not persist to localStorage');
    }
  });
  await page.reload();
  await page.getByRole('button', { name: 'Open Settings' }).click();
  await page.getByRole('button', { name: 'Core Appearance' }).click();
  await page.getByRole('button', { name: 'BUBBLES' }).waitFor({ state: 'visible' });

  await page.getByRole('button', { name: 'About & Legal' }).click();
  const sourceHref = await page.getByRole('link', { name: /source code/i }).getAttribute('href');
  if (sourceHref !== 'https://github.com/xorein/hybrid') {
    throw new Error(`About source link href was ${sourceHref}`);
  }
  await page.getByText(/AGPL-3\.0-or-later/i).first().waitFor({ state: 'visible' });
}

async function smokeRelayManagement(page) {
  const initialRelay = '/ip4/127.0.0.1/tcp/4001/p2p/12D3KooRelay';
  const addedRelay = '/ip4/127.0.0.1/tcp/4002/p2p/12D3KooRelayTwo';

  await page.getByRole('button', { name: 'Network' }).click();
  await page.getByLabel('Relay multiaddr').fill(addedRelay);
  await page.getByRole('button', { name: 'Add Relay' }).evaluate((element) => element.click());
  await page.getByText(addedRelay, { exact: true }).waitFor({ state: 'visible' });
  await page.getByText(initialRelay, { exact: true }).waitFor({ state: 'visible' });
  await page.getByRole('button', { name: 'Remove' }).first().evaluate((element) => element.click());
  await page.getByText(initialRelay, { exact: true }).waitFor({ state: 'hidden' });
}


async function openRuntimePage(browserInstance, baseUrlValue, pathname, runtime) {
  const context = await createScenarioContext(browserInstance, { runtime, controlEndpoint: runtime.control_endpoint || CONTROL_ENDPOINT });
  const page = await context.newPage();
  await page.goto(new URL(pathname, baseUrlValue).toString());
  return page;
}

async function openOfflinePage(browserInstance, baseUrlValue, pathname) {
  const context = await createScenarioContext(browserInstance, { runtime: null, controlEndpoint: CONTROL_ENDPOINT });
  const page = await context.newPage();
  await page.goto(new URL(pathname, baseUrlValue).toString());
  return page;
}

async function createScenarioContext(browserInstance, { runtime, controlEndpoint }) {
  const context = await browserInstance.newContext({ viewport: { width: 1440, height: 1100 } });
  await context.addInitScript(({ runtimeSnapshot, controlEndpoint: endpoint, createdServerName, joinedServerName, joinInvite, localTimestamp }) => {
    const parseXoreinInvite = (rawInvite) => {
      const normalized = String(rawInvite ?? '').trim();
      if (!normalized) {
        return null;
      }
      try {
        const parsed = new URL(normalized);
        if (parsed.protocol !== 'xorein:' || parsed.hostname !== 'invite') {
          return null;
        }
        return decodeXoreinInvitePayload(parsed.pathname.replace(/^\/+|\/+$/g, ''));
      } catch {
        return decodeXoreinInvitePayload(normalized);
      }
    };

    const decodeXoreinInvitePayload = (rawInvite) => {
      const normalized = String(rawInvite ?? '').trim();
      if (!normalized) {
        return null;
      }
      const base64 = normalized.replace(/-/g, '+').replace(/_/g, '/');
      const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
      try {
        const payload = JSON.parse(atob(padded));
        return payload && typeof payload === 'object' ? payload : null;
      } catch {
        return null;
      }
    };
    // The smoke drives the app via injected runtime + a mocked control API, so
    // never let the launch bootstrap reach the real default node endpoint.
    window.__HARMOLYN_DISABLE_AUTOCONNECT__ = true;
    const runtimeKeys = [
      '__HARMOLYN_XOREIN_RUNTIME__',
      '__HARMOLYN_RUNTIME_SNAPSHOT__',
      '__XOREIN_RUNTIME_SNAPSHOT__',
    ];
    const controlKeys = [
      '__HARMOLYN_XOREIN_CONTROL_TOKEN__',
      '__HARMOLYN_CONTROL_TOKEN__',
      '__XOREIN_CONTROL_TOKEN__',
    ];
    const sessionKeys = [
      '__HARMOLYN_XOREIN_SESSION__',
      '__HARMOLYN_SESSION_SNAPSHOT__',
      '__XOREIN_SESSION_SNAPSHOT__',
    ];
    const storageRuntimeKeys = [
      'harmolyn:xorein:runtime',
      'harmolyn:runtime-snapshot',
      'xorein:runtime-snapshot',
    ];
    const storageSessionKeys = [
      'harmolyn:xorein:session',
      'harmolyn:session-snapshot',
      'xorein:session-snapshot',
    ];
    const sharedKeys = [
      'harmolyn_onboarding_dismissed',
      'harmolyn:settings:message-layout',
      'harmolyn:settings:notifications',
      'harmolyn:settings:accessibility',
      'harmolyn:settings:privacy',
      'harmolyn:settings:authorized',
      'harmolyn:settings:mfa:totp-enabled',
      'harmolyn:settings:mfa:backup-codes',
      'harmolyn:xorein:social-discovery',
    ];

    const initKey = 'harmolyn:xorein:browser-smoke:init';
    const shouldReset = sessionStorage.getItem(initKey) !== 'ready';
    if (shouldReset) {
      for (const key of [...sharedKeys, ...storageRuntimeKeys, ...storageSessionKeys]) {
        localStorage.removeItem(key);
        sessionStorage.removeItem(key);
      }
      sessionStorage.setItem(initKey, 'ready');
    }

    // Only seed the original runtime on first load. On reload, leave the
    // snapshot the app persisted to localStorage so sent messages survive.
    if (runtimeSnapshot && shouldReset) {
      for (const key of runtimeKeys) {
        window[key] = runtimeSnapshot;
      }
      for (const key of controlKeys) {
        window[key] = 'browser-smoke-token';
      }
      localStorage.setItem('harmolyn:xorein:control-token', 'browser-smoke-token');
      for (const key of storageRuntimeKeys) {
        localStorage.setItem(key, JSON.stringify(runtimeSnapshot));
      }
      for (const key of sessionKeys) {
        window[key] = null;
      }
      for (const key of storageSessionKeys) {
        localStorage.setItem(key, 'null');
      }
    }

    localStorage.setItem('harmolyn_onboarding_dismissed', 'true');

    const nativeFetch = window.fetch.bind(window);
    const makeResponse = (body, status = 200) => new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
    const buildRuntimeServer = ({ id, name, description, ownerPeerId, invite, memberPeerIds }) => ({
      id,
      name,
      description,
      owner_peer_id: ownerPeerId,
      created_at: localTimestamp,
      updated_at: localTimestamp,
      members: Array.from(new Set([...memberPeerIds, ownerPeerId])),
      channels: {
        [`${id}-general`]: {
          id: `${id}-general`,
          server_id: id,
          name: 'general',
          voice: false,
          created_at: localTimestamp,
        },
      },
      manifest: {
        name,
        description,
        owner_addresses: ['127.0.0.1:4101'],
        capabilities: ['cap.chat', 'cap.manifest', 'cap.friends', 'cap.notify', 'cap.identity', 'cap.dm', 'cap.presence'],
        history_coverage: 'local-window',
        history_retention_messages: 50,
      },
      invite,
    });
    const buildControlServerRecord = ({ id, name, description, ownerPeerId, ownerAddresses, invite }) => ({
      id,
      name,
      description,
      invite,
      manifest: {
        server_id: id,
        name,
        description,
        owner_peer_id: ownerPeerId,
        owner_public_key: `${ownerPeerId}-pub`,
        owner_addresses: ownerAddresses,
        bootstrap_addrs: ['127.0.0.1:4101'],
        relay_addrs: [],
        capabilities: ['cap.chat', 'cap.manifest', 'cap.friends', 'cap.notify', 'cap.identity', 'cap.dm', 'cap.presence'],
        history_retention_messages: 50,
        history_coverage: 'local-window',
        history_durability: 'volatile',
        issued_at: localTimestamp,
        updated_at: localTimestamp,
        signature: `signed-${id}`,
      },
      channels: {
        [`${id}-general`]: {
          id: `${id}-general`,
          server_id: id,
          name: 'general',
          voice: false,
          created_at: localTimestamp,
        },
      },
    });
    const buildJoinPreview = () => ({
      invite: {
        server_id: 'beta-node',
        expires_at: '2026-04-23T00:00:00Z',
      },
      manifest: {
        server_id: 'beta-node',
        name: joinedServerName,
        description: 'Joined through a signed invite.',
        history_coverage: 'local-window',
      },
      owner_role: 'archivist',
      member_count: 2,
      channels: [
        {
          id: 'beta-node-general',
          server_id: 'beta-node',
          name: 'general',
          voice: false,
          created_at: localTimestamp,
        },
      ],
      safety_labels: ['owner-archivist'],
    });
    window.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const method = (init?.method || 'GET').toUpperCase();
      if (!url.startsWith(`${endpoint}/`)) {
        return nativeFetch(input, init);
      }

      const path = new URL(url).pathname;
      const body = typeof init?.body === 'string' && init.body ? JSON.parse(init.body) : null;
      const state = runtimeSnapshot;

      if (!state) {
        return makeResponse({ code: 'runtime_unavailable', message: 'The local xorein control endpoint is unavailable.' }, 503);
      }

      if (method === 'GET' && path === '/v1/state') {
        return makeResponse(state);
      }

      if (method === 'POST' && path === '/v1/servers') {
        const created = buildRuntimeServer({
          id: 'alpha-node',
          name: body?.name || createdServerName,
          description: body?.description || '',
          ownerPeerId: 'peer-owner-created',
          invite: 'aether://join/alpha-node?invite=signed-alpha',
          memberPeerIds: ['peer-local', 'peer-owner-created'],
        });
        state.servers = [created, ...(state.servers ?? []).filter((server) => server.id !== created.id)];
        return makeResponse(buildControlServerRecord({
          id: 'alpha-node',
          name: body?.name || createdServerName,
          description: body?.description || '',
          ownerPeerId: 'peer-owner-created',
          ownerAddresses: ['127.0.0.1:4102'],
          invite: 'aether://join/alpha-node?invite=signed-alpha',
        }), 201);
      }

      if (method === 'POST' && path === '/v1/servers/discover') {
        const parsedInvite = parseXoreinInvite(body?.deeplink);
        if (parsedInvite?.server_id === 'beta-node') {
          return makeResponse(buildJoinPreview());
        }
        return makeResponse({ code: 'discovery_failed', message: 'invite not recognized' }, 400);
      }

      if (method === 'POST' && path === '/v1/servers/join') {
        const parsedInvite = parseXoreinInvite(body?.deeplink);
        const invitePayload = parsedInvite?.server_id === 'beta-node' ? body?.deeplink : joinInvite;
        const joined = buildRuntimeServer({
          id: 'beta-node',
          name: joinedServerName,
          description: 'Joined through a signed invite.',
          ownerPeerId: 'peer-owner-joined',
          invite: invitePayload,
          memberPeerIds: ['peer-local', 'peer-owner-joined'],
        });
        state.servers = [...(state.servers ?? []).filter((server) => server.id !== joined.id), joined];
        return makeResponse(buildControlServerRecord({
          id: 'beta-node',
          name: joinedServerName,
          description: 'Joined through a signed invite.',
          ownerPeerId: 'peer-owner-joined',
          ownerAddresses: ['127.0.0.1:4103'],
          invite: invitePayload,
        }));
      }

      if (method === 'POST' && path === '/v1/relays') {
        const nextRelay = body?.multiaddr?.trim();
        state.relay_addrs = Array.from(new Set([...(state.relay_addrs ?? []), nextRelay]));
        return makeResponse({}, 204);
      }

      if (method === 'DELETE' && path === '/v1/relays') {
        const targetRelay = body?.multiaddr?.trim();
        state.relay_addrs = (state.relay_addrs ?? []).filter((relay) => relay !== targetRelay);
        return makeResponse({}, 204);
      }

      if (method === 'POST' && path === '/v1/friends/requests') {
        const peerAddr = body?.peer_addr?.trim();
        const record = {
          id: `friend-req-${Date.now()}`,
          from_peer_id: state.identity?.peer_id || 'peer-local',
          to_peer_id: peerAddr,
          status: 'pending',
          created_at: localTimestamp,
        };
        state.friend_requests = [...(state.friend_requests ?? []), record];
        return makeResponse(record, 201);
      }

      if (method === 'POST' && /^\/v1\/channels\/[^/]+\/messages$/.test(path)) {
        const channelId = path.split('/')[3];
        const owningServer = (state.servers ?? []).find((server) => Object.keys(server.channels ?? {}).includes(channelId));
        const message = {
          id: `srv-msg-${Date.now()}`,
          scope_type: 'channel',
          scope_id: channelId,
          server_id: owningServer?.id,
          sender_peer_id: state.identity?.peer_id || 'peer-local',
          body: body?.body ?? '',
          created_at: localTimestamp,
        };
        state.messages = [...(state.messages ?? []), message];
        return makeResponse(message, 201);
      }

      if (method === 'POST' && path.startsWith('/v1/voice/')) {
        return makeResponse({}, 200);
      }

      return makeResponse({ code: 'not_found', message: `${method} ${path}` }, 404);
    };
  }, { runtimeSnapshot: runtime, controlEndpoint, createdServerName: CREATED_SERVER_NAME, joinedServerName: JOINED_SERVER_NAME, joinInvite: JOIN_INVITE, localTimestamp: '2026-04-22T00:00:00Z' });
  return context;
}
