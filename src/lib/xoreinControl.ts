import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { DeeplinkValidationError, parseJoinDeepLink } from '@/protocol/deeplink';
import { parseAbsoluteUrl } from '@/protocol/url';
import { safeStorageGet, safeStorageRemove, safeStorageSet } from '@/lib/browserStorage';
import { normalizeRuntimeEndpoint, normalizeRuntimeSettings as normalizeAuthRuntimeSettings } from '@/lib/authPreview';
import type {
  XoreinRuntimeChannel,
  XoreinRuntimeDM,
  XoreinRuntimeMessage,
  XoreinFriendRecord,
  XoreinPresenceEntry,
  XoreinFriendStatus,
  XoreinRuntimePeer,
  XoreinRuntimeServer,
  XoreinRuntimeSnapshot,
  XoreinRuntimeVoiceParticipant,
  XoreinRuntimeVoiceSession,
  XoreinSessionSnapshot,
} from '@/types';

const CONTROL_GLOBAL_KEYS = [
  '__HARMOLYN_XOREIN_CONTROL_TOKEN__',
  '__HARMOLYN_CONTROL_TOKEN__',
  '__XOREIN_CONTROL_TOKEN__',
] as const;

const CONTROL_STORAGE_KEYS = [
  'harmolyn:xorein:control-token',
  'harmolyn:control-token',
  'xorein:control-token',
] as const;

const CONTROL_ENDPOINT_STORAGE_KEY = 'harmolyn:xorein:selected-control-endpoint';

const CONTROL_ENDPOINT_GLOBAL_KEYS = [
  '__HARMOLYN_XOREIN_CONTROL_ENDPOINT__',
  '__HARMOLYN_CONTROL_ENDPOINT__',
  '__XOREIN_CONTROL_ENDPOINT__',
] as const;

const CONTROL_READY_GLOBAL_KEYS = [
  '__HARMOLYN_XOREIN_CONTROL_READY__',
  '__HARMOLYN_CONTROL_READY__',
] as const;

const RUNTIME_GLOBAL_KEYS = [
  '__HARMOLYN_XOREIN_RUNTIME__',
  '__HARMOLYN_RUNTIME_SNAPSHOT__',
  '__XOREIN_RUNTIME_SNAPSHOT__',
] as const;

const SESSION_GLOBAL_KEYS = [
  '__HARMOLYN_XOREIN_SESSION__',
  '__HARMOLYN_SESSION_SNAPSHOT__',
  '__XOREIN_SESSION_SNAPSHOT__',
] as const;

const RUNTIME_STORAGE_KEYS = [
  'harmolyn:xorein:runtime',
  'harmolyn:runtime-snapshot',
  'xorein:runtime-snapshot',
] as const;

const SESSION_STORAGE_KEYS = [
  'harmolyn:xorein:session',
  'harmolyn:session-snapshot',
  'xorein:session-snapshot',
] as const;

/**
 * Control endpoint the app connects to by default on launch. Overridable at
 * build time via VITE_XOREIN_CONTROL_ENDPOINT so the hosted node's subdomain
 * can change without code edits. Falls back to the public default node.
 */
export const DEFAULT_CONTROL_ENDPOINT = (
  import.meta.env?.VITE_XOREIN_CONTROL_ENDPOINT?.trim()
  || 'https://node.xorein.com'
);

function coerceControlEndpointInput(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) {
    return trimmed;
  }
  return `http://${trimmed}`;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 6000;
const DEFAULT_REQUEST_TIMEOUT_MS = 6000;
const NATIVE_RUNTIME_READY_TIMEOUT_MS = 8000;
const NATIVE_RUNTIME_READY_POLL_MS = 250;

// How often to re-fetch /v1/state when the live event stream is unavailable
// (the token-less hosted path), so remote peer changes still surface.
const RUNTIME_REMOTE_REFRESH_MS = 5000;
const NATIVE_RUNTIME_EVENT_NAMES = [
  'xorein://runtime-ready',
  'xorein://runtime-updated',
] as const;

/**
 * The default hosted node authorizes the web app by origin, not a bearer token.
 * A stored control token belongs to a (different) local node, so sending it to
 * the public endpoint would leak it across trust boundaries. Compare by origin
 * so a trailing path or slash doesn't matter.
 */
function parseControlEndpoint(endpoint: string): URL | null {
  const parsed = parseAbsoluteUrl(endpoint);
  if (!parsed) {
    return null;
  }
  const protocol = parsed.protocol.toLowerCase();
  if (protocol !== 'http:' && protocol !== 'https:') {
    return null;
  }
  return parsed;
}

function parseTrustedControlEndpoint(endpoint: string): URL | null {
  return parseControlEndpoint(endpoint);
}

function isLocalControlOrigin(endpointUrl: URL): boolean {
  const host = endpointUrl.hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  return host === 'localhost'
    || host === 'tauri.localhost'
    || host === '::1'
    || host === '0:0:0:0:0:0:0:1'
    || /^127(?:\.\d{1,3}){3}$/.test(host);
}

function isDefaultPublicEndpointUrl(endpointUrl: URL): boolean {
  if (!DEFAULT_CONTROL_ENDPOINT) {
    return false;
  }
  const resolvedDefault = parseControlEndpoint(DEFAULT_CONTROL_ENDPOINT);
  return !!resolvedDefault && endpointUrl.origin === resolvedDefault.origin;
}

function isDefaultPublicEndpoint(endpoint: string): boolean {
  const resolvedEndpoint = parseControlEndpoint(endpoint);
  return !!resolvedEndpoint && isDefaultPublicEndpointUrl(resolvedEndpoint);
}

export function normalizeLaunchControlEndpoint(value: string): string | null {
  const parsed = parseTrustedControlEndpoint(coerceControlEndpointInput(value));
  return parsed ? parsed.origin : null;
}

export function readPreferredControlEndpoint(): string {
  if (typeof window === 'undefined') {
    return '';
  }
  const raw = safeStorageGet(() => window.localStorage, CONTROL_ENDPOINT_STORAGE_KEY);
  return raw ? normalizeLaunchControlEndpoint(raw) ?? '' : '';
}

export function storePreferredControlEndpoint(value: string): string | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const normalized = normalizeLaunchControlEndpoint(value);
  if (!normalized) {
    clearPreferredControlEndpoint();
    return null;
  }
  safeStorageSet(() => window.localStorage, CONTROL_ENDPOINT_STORAGE_KEY, normalized);
  return normalized;
}

export function clearPreferredControlEndpoint(): void {
  if (typeof window === 'undefined') {
    return;
  }
  safeStorageRemove(() => window.localStorage, CONTROL_ENDPOINT_STORAGE_KEY);
}

interface ControlApiErrorShape {
  code?: string;
  message?: string;
}

interface ControlChannelRecord {
  id: string;
  server_id: string;
  name: string;
  voice: boolean;
  created_at?: string;
}

interface ControlServerRecord {
  id: string;
  name: string;
  description?: string;
  owner_peer_id: string;
  security_mode: string;
  created_at: string;
}

type ControlStateServer = Partial<XoreinRuntimeServer> & {
  id: string;
  name: string;
};

type ControlStateDM = Partial<XoreinRuntimeDM> & {
  id: string;
  peer_id?: string;
};

type ControlStateVoiceSession = Partial<Omit<XoreinRuntimeVoiceSession, 'participants'>> & {
  id?: string;
  channel_id?: string;
  participants?: string[] | Record<string, XoreinRuntimeVoiceParticipant>;
};

type ControlStateSnapshot = Omit<XoreinRuntimeSnapshot, 'servers' | 'dms' | 'voice_sessions'> & {
  display_name?: string;
  channels?: XoreinRuntimeChannel[];
  servers?: ControlStateServer[];
  dms?: ControlStateDM[];
  voice_sessions?: ControlStateVoiceSession[];
  friends?: XoreinFriendRecord[];
  friend_requests?: XoreinFriendRecord[];
};

export interface XoreinServerPreview {
  invite: {
    server_id: string;
    expires_at?: string;
    has_signature?: boolean;
    owner_peer_id?: string;
  };
  manifest: {
    server_id: string;
    name: string;
    description?: string;
    history_coverage?: string;
    security_mode?: string;
  };
  owner_role?: string;
  member_count?: number;
  channels?: ControlChannelRecord[];
  safety_labels?: string[];
}

interface NativeRuntimeConfig {
  control_endpoint?: string;
  control_ready?: boolean;
  data_dir?: string;
  settings?: Record<string, string>;
  sidecar?: {
    managed?: boolean;
    running?: boolean;
    pid?: number | null;
    data_dir?: string | null;
    control_endpoint?: string;
    last_error?: string | null;
  };
}

export interface NativeRuntimeBootstrapStatus {
  phase: 'idle' | 'connecting' | 'waiting' | 'ready' | 'failed';
  message: string;
  detail?: string;
}

interface NativeControlApiResponse {
  status?: number;
  body?: unknown;
}

export class XoreinControlError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = 'XoreinControlError';
    this.code = code;
    this.status = status;
  }
}

function ensureStructuredJsonResponse<T>(value: unknown, message: string): T {
  if (!isRecord(value)) {
    throw new XoreinControlError('invalid_response', message, 502);
  }
  return value as T;
}

export function normalizeJoinInput(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new DeeplinkValidationError('empty deeplink');
  }

  const parsed = parseJoinDeepLink(trimmed);
  if (!parsed.invite) {
    throw new DeeplinkValidationError('signed invite is required for join discovery and remote joins');
  }

  return trimmed;
}

export async function discoverServerByInvite(runtimeSnapshot: XoreinRuntimeSnapshot | null, raw: string): Promise<XoreinServerPreview> {
  const deeplink = normalizeJoinInput(raw);
  const preview = await requestControlApi<unknown>(runtimeSnapshot, 'POST', '/v1/servers/preview', { deeplink });
  return normalizeServerPreview(preview);
}

export async function createServer(runtimeSnapshot: XoreinRuntimeSnapshot | null, input: { name: string; description?: string }): Promise<XoreinRuntimeSnapshot> {
  const name = input.name.trim();
  if (!name) {
    throw new XoreinControlError('invalid_request', 'Server name is required.');
  }

  const server = await requestControlApi<ControlServerRecord>(runtimeSnapshot, 'POST', '/v1/servers', {
    name,
    description: input.description?.trim() ?? '',
  });
  normalizeControlServerRecord(server);

  return refreshRuntimeSnapshot(runtimeSnapshot, {
    serverId: null,
    manifest: { name, description: input.description?.trim() ?? '' },
  });
}

export async function joinServerByInvite(runtimeSnapshot: XoreinRuntimeSnapshot | null, raw: string): Promise<XoreinRuntimeSnapshot> {
  const deeplink = normalizeJoinInput(raw);
  const server = await requestControlApi<ControlServerRecord>(runtimeSnapshot, 'POST', '/v1/servers/join', { deeplink });
  const normalizedServer = normalizeControlServerRecord(server);
  return refreshRuntimeSnapshot(runtimeSnapshot, {
    serverId: normalizedServer.id,
    manifest: {
      name: normalizedServer.name,
      description: normalizedServer.description || '',
    },
  });
}

export async function refreshRuntimeSnapshot(
  runtimeSnapshot: XoreinRuntimeSnapshot | null,
  session: {
    serverId: string | null;
    manifest?: { name?: string; description?: string };
  } | null | undefined = undefined,
): Promise<XoreinRuntimeSnapshot> {
  const rawSnapshot = await requestControlApi<ControlStateSnapshot>(runtimeSnapshot, 'GET', '/v1/state');
  const fetched = normalizeRuntimeSnapshot(rawSnapshot);
  // Preserve the control_endpoint from the current snapshot when the fresh API
  // response omits it (the public hosted node doesn't echo it back).
  const endpoint = normalizeRuntimeEndpoint(fetched.control_endpoint)
    || normalizeRuntimeEndpoint(runtimeSnapshot?.control_endpoint);
  const snapshot: XoreinRuntimeSnapshot = {
    ...fetched,
    ...(endpoint ? { control_endpoint: endpoint } : {}),
  };
  publishSnapshot(snapshot, session);
  return snapshot;
}

/**
 * Explicit launch-connect path: connect to the user-selected node endpoint
 * without depending on the startup bootstrap state.
 */
export async function connectToControlEndpoint(endpoint: string): Promise<XoreinRuntimeSnapshot | null> {
  const endpointUrl = parseTrustedControlEndpoint(endpoint);
  if (!endpointUrl) {
    return null;
  }

  const normalizedEndpoint = endpointUrl.origin;
  try {
    const rawState = isLocalControlOrigin(endpointUrl)
      ? await requestNativeControlApi<ControlStateSnapshot>(normalizedEndpoint, 'GET', '/v1/state')
      : await fetchControlState(endpointUrl);
    const fetched = normalizeRuntimeSnapshot(rawState);
    const snapshot: XoreinRuntimeSnapshot = {
      ...fetched,
      control_endpoint: normalizeRuntimeEndpoint(fetched.control_endpoint) || normalizedEndpoint,
    };
    publishSnapshot(snapshot, undefined);
    return snapshot;
  } catch {
    clearPublishedRuntimeStateForEndpoint(normalizedEndpoint);
    return null;
  }
}

/**
 * Launch bootstrap: with no injected runtime, ask the native shell for the local
 * xorein endpoint/token. Web/dev builds can opt into an explicit
 * VITE_XOREIN_CONTROL_ENDPOINT, but there is no silent hosted fallback.
 */
export async function connectToDefaultRuntime(): Promise<XoreinRuntimeSnapshot | null> {
  if (typeof window === 'undefined') {
    return null;
  }
  if ((window as unknown as Record<string, unknown>).__HARMOLYN_DISABLE_AUTOCONNECT__) {
    clearPublishedRuntimeState();
    return null;
  }
  const preferredEndpoint = readPreferredControlEndpoint();
  // Sidecar removed: no longer probe a native Tauri sidecar for a local endpoint.
  const endpoint = preferredEndpoint || DEFAULT_CONTROL_ENDPOINT;
  clearNativeRuntimeGlobals();
  if (!endpoint) {
    clearPublishedRuntimeState();
    return null;
  }
  const endpointUrl = parseTrustedControlEndpoint(endpoint);
  if (!endpointUrl) {
    clearPublishedRuntimeStateForEndpoint(endpoint);
    return null;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_CONNECT_TIMEOUT_MS);
  try {
    const response = await fetch(new URL('/v1/state', endpointUrl), {
      signal: controller.signal,
      headers: {},
    });
    if (!response.ok) {
      clearNativeRuntimeGlobals();
      clearPublishedRuntimeStateForEndpoint(endpoint);
      return null;
    }
    let rawState: ControlStateSnapshot;
    try {
      rawState = ensureStructuredJsonResponse<ControlStateSnapshot>(
        await response.json(),
        'xorein control response was not a structured JSON value.',
      );
    } catch {
      clearNativeRuntimeGlobals();
      clearPublishedRuntimeStateForEndpoint(endpoint);
      return null;
    }
    const fetched = normalizeRuntimeSnapshot(rawState);
    const snapshot: XoreinRuntimeSnapshot = {
      ...fetched,
      control_endpoint: normalizeRuntimeEndpoint(fetched.control_endpoint) || endpoint,
    };
    publishSnapshot(snapshot, undefined);
    return snapshot;
  } catch {
    clearNativeRuntimeGlobals();
    clearPublishedRuntimeStateForEndpoint(endpoint);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function joinVoiceChannel(
  runtimeSnapshot: XoreinRuntimeSnapshot | null,
  channelID: string,
  muted = false,
): Promise<XoreinRuntimeSnapshot> {
  await requestControlApi<void>(runtimeSnapshot, 'POST', `/v1/voice/${controlPathSegment(channelID, 'Voice channel ID')}/join`, { muted });
  return refreshRuntimeSnapshot(runtimeSnapshot, undefined);
}

export async function leaveVoiceChannel(
  runtimeSnapshot: XoreinRuntimeSnapshot | null,
  channelID: string,
): Promise<XoreinRuntimeSnapshot> {
  await requestControlApi<void>(runtimeSnapshot, 'POST', `/v1/voice/${controlPathSegment(channelID, 'Voice channel ID')}/leave`);
  return refreshRuntimeSnapshot(runtimeSnapshot, undefined);
}

export async function setVoiceMuted(
  runtimeSnapshot: XoreinRuntimeSnapshot | null,
  channelID: string,
  muted: boolean,
): Promise<XoreinRuntimeSnapshot> {
  await requestControlApi<void>(runtimeSnapshot, 'POST', `/v1/voice/${controlPathSegment(channelID, 'Voice channel ID')}/mute`, { muted });
  return refreshRuntimeSnapshot(runtimeSnapshot, undefined);
}

export async function sendVoiceFrame(
  runtimeSnapshot: XoreinRuntimeSnapshot | null,
  channelID: string,
  payload: unknown,
): Promise<XoreinRuntimeSnapshot> {
  await requestControlApi<void>(runtimeSnapshot, 'POST', `/v1/voice/${controlPathSegment(channelID, 'Voice channel ID')}/frames`, { data: encodeVoiceFrameData(payload) });
  return refreshRuntimeSnapshot(runtimeSnapshot, undefined);
}

export interface XoreinIdentityRecord {
  id?: string;
  peer_id: string;
  active_peer_id?: string;
  restart_required?: boolean;
  public_key?: string;
  created_at?: string;
  display_name?: string;
  bio?: string;
  profile?: { display_name?: string; bio?: string };
}

export interface XoreinIdentityBackupDocument {
  version: number;
  alg: string;
  peer_id: string;
  salt: string;
  nonce: string;
  ciphertext: string;
}

export interface XoreinMessageRecord {
  id: string;
  scope_type: string;
  scope_id: string;
  server_id?: string;
  sender_peer_id: string;
  body: string;
  reply_to?: string;
  forwarded_from?: string;
  created_at?: string;
  updated_at?: string;
}

export interface XoreinDmRecord {
  id: string;
  participants: string[];
  created_at?: string;
}

export interface XoreinChannelRecord {
  id: string;
  server_id: string;
  name: string;
  voice: boolean;
  created_at?: string;
}

export async function sendChannelMessage(
  runtimeSnapshot: XoreinRuntimeSnapshot | null,
  channelId: string,
  content: string,
  input: { reply_to?: string; forwarded_from?: string } = {},
): Promise<XoreinMessageRecord> {
  const body = normalizeMessageBody(content, 'Channel message');
  const channelSegment = controlPathSegment(channelId, 'Channel ID');
  const record = await requestControlApi<unknown>(
    runtimeSnapshot, 'POST', `/v1/channels/${channelSegment}/messages`, { body, ...input },
  );
  await refreshRuntimeSnapshot(runtimeSnapshot, undefined);
  return normalizeMessageRecord(record);
}

export async function sendDmMessage(
  runtimeSnapshot: XoreinRuntimeSnapshot | null,
  dmId: string,
  content: string,
  input: { reply_to?: string; forwarded_from?: string } = {},
): Promise<XoreinMessageRecord> {
  const body = normalizeMessageBody(content, 'DM message');
  const dmSegment = controlPathSegment(dmId, 'DM ID');
  const record = await requestControlApi<unknown>(
    runtimeSnapshot, 'POST', `/v1/dms/${dmSegment}/messages`, { body, ...input },
  );
  await refreshRuntimeSnapshot(runtimeSnapshot, undefined);
  return normalizeMessageRecord(record);
}

export async function editMessage(
  runtimeSnapshot: XoreinRuntimeSnapshot | null,
  messageId: string,
  content: string,
): Promise<XoreinMessageRecord> {
  const messageSegment = controlPathSegment(messageId, 'Message ID');
  const record = await requestControlApi<unknown>(
    runtimeSnapshot, 'PATCH', `/v1/messages/${messageSegment}`, { body: content },
  );
  await refreshRuntimeSnapshot(runtimeSnapshot, undefined);
  return normalizeMessageRecord(record);
}

export async function deleteMessage(
  runtimeSnapshot: XoreinRuntimeSnapshot | null,
  messageId: string,
): Promise<void> {
  await requestControlApi<void>(runtimeSnapshot, 'DELETE', `/v1/messages/${controlPathSegment(messageId, 'Message ID')}`);
  await refreshRuntimeSnapshot(runtimeSnapshot, undefined);
}

export async function createChannel(
  runtimeSnapshot: XoreinRuntimeSnapshot | null,
  serverId: string,
  name: string,
  voice = false,
): Promise<XoreinChannelRecord> {
  const normalizedName = normalizeRequiredText(name, 'Channel name');
  const serverSegment = controlPathSegment(serverId, 'Server ID');
  const record = await requestControlApi<unknown>(
    runtimeSnapshot, 'POST', `/v1/servers/${serverSegment}/channels`, { name: normalizedName, voice },
  );
  await refreshRuntimeSnapshot(runtimeSnapshot, undefined);
  return normalizeControlChannelRecordForServer(record, serverId);
}

export async function createIdentity(
  runtimeSnapshot: XoreinRuntimeSnapshot | null,
  displayName: string,
  bio?: string,
): Promise<XoreinIdentityRecord> {
  const trimmedDisplayName = displayName.trim();
  if (!trimmedDisplayName) {
    throw new XoreinControlError('invalid_request', 'Display name is required.');
  }

  const record = await requestControlApi<unknown>(
    runtimeSnapshot, 'POST', '/v1/identities',
    { display_name: trimmedDisplayName, bio: bio?.trim() ?? '' },
  );
  await refreshRuntimeSnapshot(runtimeSnapshot, undefined);
  return normalizeIdentityRecord(record);
}

export async function getIdentityBackup(
  runtimeSnapshot: XoreinRuntimeSnapshot | null,
  passphrase: string,
): Promise<string> {
  const trimmedPassphrase = passphrase.trim();
  if (!trimmedPassphrase) {
    throw new XoreinControlError('invalid_request', 'A backup passphrase is required.');
  }

  const result = await requestControlApi<unknown>(
    runtimeSnapshot, 'POST', '/v1/identities/backup', { passphrase: trimmedPassphrase },
  );
  return JSON.stringify(normalizeIdentityBackupDocument(result), null, 2);
}

export async function restoreIdentity(
  runtimeSnapshot: XoreinRuntimeSnapshot | null,
  backup: string,
  passphrase: string,
): Promise<XoreinIdentityRecord> {
  const trimmedPassphrase = passphrase.trim();
  if (!trimmedPassphrase) {
    throw new XoreinControlError('invalid_request', 'A backup passphrase is required.');
  }

  const backupDocument = parseIdentityBackupDocument(backup);
  const record = await requestControlApi<unknown>(
    runtimeSnapshot, 'POST', '/v1/identities/restore', { passphrase: trimmedPassphrase, backup: backupDocument },
  );
  await refreshRuntimeSnapshot(runtimeSnapshot, undefined);
  return normalizeIdentityRecord(record);
}

export async function listDms(
  runtimeSnapshot: XoreinRuntimeSnapshot | null,
): Promise<XoreinDmRecord[]> {
  const result = await requestControlApi<unknown>(
    runtimeSnapshot, 'GET', '/v1/dms',
  );
  return normalizeDmRecords(result);
}

export async function createDm(
  runtimeSnapshot: XoreinRuntimeSnapshot | null,
  peerId: string,
): Promise<XoreinDmRecord> {
  const normalizedPeerId = normalizeRequiredText(peerId, 'Peer ID');
  const record = await requestControlApi<unknown>(
    runtimeSnapshot, 'POST', '/v1/dms', { peer_id: normalizedPeerId },
  );
  await refreshRuntimeSnapshot(runtimeSnapshot, undefined);
  return normalizeDmRecord(record);
}

const PRESENCE_STATUSES = new Set(['online', 'idle', 'dnd', 'offline', 'away', 'invisible']);

function normalizeMessageBody(input: string, label: string): string {
  if (!input.trim()) {
    throw new XoreinControlError('invalid_request', `${label} must not be empty.`);
  }
  return input;
}

function normalizeRequiredText(input: string, label: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new XoreinControlError('invalid_request', `${label} is required.`);
  }
  return trimmed;
}

function controlPathSegment(input: string, label: string): string {
  const normalized = normalizeRequiredText(input, label);
  if (normalized === '.' || normalized === '..') {
    throw new XoreinControlError('invalid_request', `${label} is invalid.`);
  }
  return encodeURIComponent(normalized);
}

function normalizeControlPath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed.startsWith('/v1/') || trimmed.includes('#') || Array.from(trimmed).some(isUnsafeControlPathChar)) {
    throw new XoreinControlError('invalid_request', 'unsupported xorein control path');
  }
  const pathOnly = trimmed.split('?', 1)[0];
  const segments = pathOnly.split('/');
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    throw new XoreinControlError('invalid_request', 'unsupported xorein control path');
  }
  return trimmed;
}

function isUnsafeControlPathChar(char: string): boolean {
  const code = char.charCodeAt(0);
  return code <= 0x1f || code === 0x7f || char === '\\';
}

function normalizeDialablePeerAddr(input: string, label: string): string {
  const trimmed = normalizeRequiredText(input, label);
  if (!trimmed.includes('/p2p/')) {
    throw new XoreinControlError('invalid_request', `${label} must be a dialable /p2p multiaddr.`);
  }
  return trimmed;
}

function normalizeGroupMemberIdentity(input: string): string {
  return normalizeRequiredText(input, 'Group DM member');
}

function normalizePresenceInput(input: { status: string; status_text?: string; typing_in_scope?: string }): { status: string; status_text?: string; typing_in_scope?: string } {
  const status = (input.status ?? '').trim() || 'online';
  if (!PRESENCE_STATUSES.has(status)) {
    throw new XoreinControlError('invalid_request', 'invalid presence status');
  }
  const statusText = input.status_text?.trim() ?? '';
  if (statusText.length > 128) {
    throw new XoreinControlError('invalid_request', 'status text too long');
  }
  const typingInScope = input.typing_in_scope?.trim() ?? '';
  return {
    status,
    status_text: statusText,
    typing_in_scope: typingInScope,
  };
}

export async function addPeer(
  runtimeSnapshot: XoreinRuntimeSnapshot | null,
  address: string,
): Promise<void> {
  const normalized = normalizeDialablePeerAddr(address, 'Manual peer address');
  await requestControlApi<void>(runtimeSnapshot, 'POST', '/v1/peers/manual', { address: normalized });
  await refreshRuntimeSnapshot(runtimeSnapshot, undefined);
}

export async function removePeer(
  runtimeSnapshot: XoreinRuntimeSnapshot | null,
  address: string,
): Promise<void> {
  const normalized = normalizeRequiredText(address, 'Manual peer address');
  await requestControlApi<void>(runtimeSnapshot, 'DELETE', '/v1/peers/manual', { address: normalized });
  await refreshRuntimeSnapshot(runtimeSnapshot, undefined);
}

// ---------------------------------------------------------------------------
// Friends, presence, notifications, mentions, message search, relays.
// Shapes mirror the xorein control API (docs/spec/v0.1/60-local-control-api.md
// + pkg/v0_1/control). All paths are rooted at /v1.
// ---------------------------------------------------------------------------

export interface XoreinNotificationRecord {
  id: string;
  type: string;
  scope_id?: string;
  scope_type?: string;
  server_id?: string;
  message_id?: string;
  read: boolean;
  created_at?: string;
}

export interface XoreinNotificationSummary {
  total_unread: number;
  by_server: Record<string, { unread: number; mentions: number }>;
  dms_unread: number;
}

export interface XoreinReadThrough {
  scope_id: string;
  scope_type: string;
  read_through_message_id: string;
  updated_at?: string;
}

export interface XoreinMessageSearchResult {
  messages: string[];
  results: XoreinMessageRecord[];
}

export async function listFriends(
  runtimeSnapshot: XoreinRuntimeSnapshot | null,
): Promise<XoreinFriendRecord[]> {
  const result = await requestControlApi<{ friends: XoreinFriendRecord[] }>(
    runtimeSnapshot, 'GET', '/v1/friends',
  );
  return normalizeFriendRecords(result.friends);
}

export async function sendFriendRequest(
  runtimeSnapshot: XoreinRuntimeSnapshot | null,
  peerAddr: string,
): Promise<XoreinFriendRecord> {
  const normalizedPeerAddr = normalizeRequiredText(peerAddr, 'Friend peer address');
  const record = await requestControlApi<XoreinFriendRecord>(
    runtimeSnapshot, 'POST', '/v1/friends/requests', { peer_addr: normalizedPeerAddr },
  );
  await refreshRuntimeSnapshot(runtimeSnapshot, undefined);
  return record;
}

export async function actOnFriendRequest(
  runtimeSnapshot: XoreinRuntimeSnapshot | null,
  requestId: string,
  action: 'accept' | 'decline' | 'cancel' | 'block',
): Promise<XoreinFriendRecord> {
  const normalizedRequestId = normalizeRequiredText(requestId, 'Friend request ID');
  const record = await requestControlApi<XoreinFriendRecord>(
    runtimeSnapshot, 'PUT', `/v1/friends/requests/${encodeURIComponent(normalizedRequestId)}`, { action },
  );
  await refreshRuntimeSnapshot(runtimeSnapshot, undefined);
  return record;
}

export async function removeFriend(
  runtimeSnapshot: XoreinRuntimeSnapshot | null,
  friendId: string,
): Promise<void> {
  const normalizedFriendId = normalizeRequiredText(friendId, 'Friend ID');
  await requestControlApi<void>(
    runtimeSnapshot, 'DELETE', `/v1/friends/${encodeURIComponent(normalizedFriendId)}`,
  );
  await refreshRuntimeSnapshot(runtimeSnapshot, undefined);
}

export async function getPresence(
  runtimeSnapshot: XoreinRuntimeSnapshot | null,
): Promise<Record<string, XoreinPresenceEntry>> {
  const result = await requestControlApi<{ peers: Record<string, XoreinPresenceEntry> }>(
    runtimeSnapshot, 'GET', '/v1/presence',
  );
  return normalizePresenceMap(result.peers) ?? {};
}

export interface XoreinNotificationFilter {
  server_id?: string;
  scope_type?: 'channel' | 'dm';
  scope_id?: string;
  unread_only?: boolean;
  limit?: number;
}

export async function searchNotifications(
  runtimeSnapshot: XoreinRuntimeSnapshot | null,
  filter: XoreinNotificationFilter = {},
): Promise<XoreinNotificationRecord[]> {
  const result = await requestControlApi<{ notifications: XoreinNotificationRecord[] }>(
    runtimeSnapshot, 'POST', '/v1/notifications/search', filter,
  );
  return normalizeNotificationRecords(result.notifications);
}

export async function getNotificationSummary(
  runtimeSnapshot: XoreinRuntimeSnapshot | null,
): Promise<XoreinNotificationSummary> {
  const summary = await requestControlApi<XoreinNotificationSummary>(
    runtimeSnapshot, 'GET', '/v1/notifications/summary',
  );
  return normalizeNotificationSummary(summary);
}

export async function markNotificationsRead(
  runtimeSnapshot: XoreinRuntimeSnapshot | null,
  input: {
    read_through_message_id: string;
    server_id?: string;
    scope_type?: 'channel' | 'dm';
    scope_id?: string;
  },
): Promise<XoreinReadThrough> {
  const record = await requestControlApi<XoreinReadThrough>(
    runtimeSnapshot, 'POST', '/v1/notifications/read', input,
  );
  await refreshRuntimeSnapshot(runtimeSnapshot, undefined);
  return normalizeReadThrough(record);
}

export async function searchMentions(
  runtimeSnapshot: XoreinRuntimeSnapshot | null,
  filter: { server_id?: string; scope_id?: string; limit?: number } = {},
): Promise<XoreinNotificationRecord[]> {
  const result = await requestControlApi<{ mentions: XoreinNotificationRecord[] }>(
    runtimeSnapshot, 'POST', '/v1/mentions/search', filter,
  );
  return normalizeNotificationRecords(result.mentions);
}

// ─── Attachments / uploads ─────────────────────────────────
export interface XoreinUploadResult {
  id: string;
  filename: string;
  content_type: string;
  size: number;
  url: string;
}

export async function uploadAttachment(
  runtimeSnapshot: XoreinRuntimeSnapshot | null,
  input: { filename: string; contentType: string; data: string },
): Promise<XoreinUploadResult> {
  const result = await requestControlApi<unknown>(
    runtimeSnapshot, 'POST', '/v1/uploads',
    { filename: input.filename, content_type: input.contentType, data: input.data },
  );
  if (!isRecord(result) || typeof result.id !== 'string' || typeof result.url !== 'string') {
    throw new XoreinControlError('invalid_response', 'xorein upload response was malformed.', 502);
  }
  return {
    id: result.id,
    filename: typeof result.filename === 'string' ? result.filename : input.filename,
    content_type: typeof result.content_type === 'string' ? result.content_type : input.contentType,
    size: typeof result.size === 'number' ? result.size : 0,
    url: result.url,
  };
}

// ─── Reactions ─────────────────────────────────────────────
export async function addReaction(
  runtimeSnapshot: XoreinRuntimeSnapshot | null,
  messageId: string,
  emoji: string,
): Promise<void> {
  await requestControlApi<void>(runtimeSnapshot, 'POST', `/v1/messages/${controlPathSegment(messageId, 'Message ID')}/reactions`, { emoji });
  await refreshRuntimeSnapshot(runtimeSnapshot, undefined);
}

export async function removeReaction(
  runtimeSnapshot: XoreinRuntimeSnapshot | null,
  messageId: string,
  emoji: string,
): Promise<void> {
  await requestControlApi<void>(runtimeSnapshot, 'DELETE', `/v1/messages/${controlPathSegment(messageId, 'Message ID')}/reactions`, { emoji });
  await refreshRuntimeSnapshot(runtimeSnapshot, undefined);
}

// ─── Pins ──────────────────────────────────────────────────
export async function listPins(
  runtimeSnapshot: XoreinRuntimeSnapshot | null,
  channelId: string,
): Promise<string[]> {
  const result = await requestControlApi<unknown>(runtimeSnapshot, 'GET', `/v1/channels/${controlPathSegment(channelId, 'Channel ID')}/pins`);
  return normalizePinnedMessageIds(result, channelId);
}

export async function pinMessage(
  runtimeSnapshot: XoreinRuntimeSnapshot | null,
  channelId: string,
  messageId: string,
): Promise<void> {
  await requestControlApi<void>(runtimeSnapshot, 'POST', `/v1/channels/${controlPathSegment(channelId, 'Channel ID')}/pins`, { message_id: messageId });
  await refreshRuntimeSnapshot(runtimeSnapshot, undefined);
}

export async function unpinMessage(
  runtimeSnapshot: XoreinRuntimeSnapshot | null,
  channelId: string,
  messageId: string,
): Promise<void> {
  await requestControlApi<void>(runtimeSnapshot, 'DELETE', `/v1/channels/${controlPathSegment(channelId, 'Channel ID')}/pins`, { message_id: messageId });
  await refreshRuntimeSnapshot(runtimeSnapshot, undefined);
}

// ─── Presence / status / typing ────────────────────────────
export async function updatePresence(
  runtimeSnapshot: XoreinRuntimeSnapshot | null,
  input: { status: string; status_text?: string; typing_in_scope?: string },
): Promise<void> {
  const normalized = normalizePresenceInput(input);
  await requestControlApi<void>(runtimeSnapshot, 'POST', '/v1/presence', normalized);
  await refreshRuntimeSnapshot(runtimeSnapshot, undefined);
}

// ─── Moderation ────────────────────────────────────────────
export async function moderationAction(
  runtimeSnapshot: XoreinRuntimeSnapshot | null,
  serverId: string,
  action: 'kick' | 'ban' | 'unban' | 'mute' | 'slowmode',
  input: { target_peer_id?: string; reason?: string; duration_ms?: number; channel_id?: string; min_delay_ms?: number },
): Promise<void> {
  await requestControlApi<void>(runtimeSnapshot, 'POST', `/v1/moderation/${controlPathSegment(serverId, 'Server ID')}/${action}`, input);
  await refreshRuntimeSnapshot(runtimeSnapshot, undefined);
}

// ─── Governance / roles ────────────────────────────────────
export interface XoreinRoleEntry {
  peer_id: string;
  role: string;
  version: number;
}

export async function listRoles(
  runtimeSnapshot: XoreinRuntimeSnapshot | null,
  serverId: string,
): Promise<XoreinRoleEntry[]> {
  const result = await requestControlApi<unknown>(runtimeSnapshot, 'GET', `/v1/servers/${controlPathSegment(serverId, 'Server ID')}/roles`);
  return normalizeRoleRecords(result);
}

export async function createRole(
  runtimeSnapshot: XoreinRuntimeSnapshot | null,
  serverId: string,
  input: { role_name: string; permissions_bitfield?: number },
): Promise<void> {
  const roleName = normalizeRequiredText(input.role_name, 'Role name');
  await requestControlApi<void>(runtimeSnapshot, 'POST', `/v1/servers/${controlPathSegment(serverId, 'Server ID')}/roles`, {
    ...input,
    role_name: roleName,
  });
  await refreshRuntimeSnapshot(runtimeSnapshot, undefined);
}

export async function assignRole(
  runtimeSnapshot: XoreinRuntimeSnapshot | null,
  serverId: string,
  peerId: string,
  role: string,
): Promise<void> {
  const normalizedRole = normalizeRequiredText(role, 'Role');
  await requestControlApi<void>(runtimeSnapshot, 'PUT', `/v1/servers/${controlPathSegment(serverId, 'Server ID')}/members/${controlPathSegment(peerId, 'Peer ID')}/roles`, { role: normalizedRole });
  await refreshRuntimeSnapshot(runtimeSnapshot, undefined);
}

// ─── Voice signaling ───────────────────────────────────────
export async function sendVoiceSignal(
  runtimeSnapshot: XoreinRuntimeSnapshot | null,
  channelId: string,
  kind: 'offer' | 'answer' | 'ice' | 'terminate',
  input: { session_id?: string; target_peer?: string; sdp?: string; candidate?: string; sequence?: number },
): Promise<void> {
  await requestControlApi<void>(runtimeSnapshot, 'POST', `/v1/voice/${controlPathSegment(channelId, 'Voice channel ID')}/${kind}`, input);
  await refreshRuntimeSnapshot(runtimeSnapshot, undefined);
}

// ─── Group DMs (Tree mode) ─────────────────────────────────
export interface XoreinGroupDmRecord {
  id: string;
  name?: string;
  members: string[];
  created_at: string;
}

export async function listGroupDms(
  runtimeSnapshot: XoreinRuntimeSnapshot | null,
): Promise<XoreinGroupDmRecord[]> {
  // Backend registers group operations under /v1/groups (not /v1/groupdms).
  const result = await requestControlApi<unknown>(runtimeSnapshot, 'GET', '/v1/groups');
  return normalizeGroupDmRecords(result);
}

export async function createGroupDm(
  runtimeSnapshot: XoreinRuntimeSnapshot | null,
  input: { name?: string; members: string[] },
): Promise<XoreinGroupDmRecord> {
  const name = input.name?.trim();
  const members = input.members.map((member) => normalizeGroupMemberIdentity(member));
  const record = await requestControlApi<unknown>(runtimeSnapshot, 'POST', '/v1/groups', {
    ...(name ? { name } : {}),
    members,
  });
  await refreshRuntimeSnapshot(runtimeSnapshot, undefined);
  return normalizeGroupDmRecord(record);
}

export async function addGroupDmMember(
  runtimeSnapshot: XoreinRuntimeSnapshot | null,
  groupId: string,
  peerAddr: string,
): Promise<void> {
  const normalized = normalizeGroupMemberIdentity(peerAddr);
  await requestControlApi<void>(runtimeSnapshot, 'POST', `/v1/groups/${controlPathSegment(groupId, 'Group ID')}/members`, { peer_addr: normalized });
  await refreshRuntimeSnapshot(runtimeSnapshot, undefined);
}

export async function sendGroupDmMessage(
  runtimeSnapshot: XoreinRuntimeSnapshot | null,
  groupId: string,
  body: string,
): Promise<XoreinMessageRecord> {
  const normalizedBody = normalizeMessageBody(body, 'Group DM message');
  const record = await requestControlApi<unknown>(runtimeSnapshot, 'POST', `/v1/groups/${controlPathSegment(groupId, 'Group ID')}/messages`, { body: normalizedBody });
  await refreshRuntimeSnapshot(runtimeSnapshot, undefined);
  return normalizeMessageRecord(record);
}

export interface XoreinMessageSearchQuery {
  query?: string;
  scope_type?: 'channel' | 'dm';
  scope_id?: string;
  server_id?: string;
  sender_peer_id?: string;
  before?: string;
  after?: string;
  limit?: number;
}

export async function searchMessages(
  runtimeSnapshot: XoreinRuntimeSnapshot | null,
  query: XoreinMessageSearchQuery = {},
): Promise<XoreinMessageSearchResult> {
  const result = await requestControlApi<unknown>(
    runtimeSnapshot, 'POST', '/v1/messages/search', query,
  );
  return normalizeMessageSearchResult(result);
}

export async function registerRelay(
  runtimeSnapshot: XoreinRuntimeSnapshot | null,
  multiaddr: string,
): Promise<void> {
  const normalized = normalizeDialablePeerAddr(multiaddr, 'Relay multiaddr');
  await requestControlApi<void>(runtimeSnapshot, 'POST', '/v1/relays', { multiaddr: normalized });
  await refreshRuntimeSnapshot(runtimeSnapshot, undefined);
}

export async function removeRelay(
  runtimeSnapshot: XoreinRuntimeSnapshot | null,
  multiaddr: string,
): Promise<void> {
  const normalized = normalizeDialablePeerAddr(multiaddr, 'Relay multiaddr');
  await requestControlApi<void>(runtimeSnapshot, 'DELETE', '/v1/relays', { multiaddr: normalized });
  await refreshRuntimeSnapshot(runtimeSnapshot, undefined);
}

export async function ensureRelays(
  runtimeSnapshot: XoreinRuntimeSnapshot | null,
  multiaddrs: string[],
): Promise<void> {
  const existing = new Set(runtimeSnapshot?.relay_addrs ?? []);
  for (const addr of multiaddrs) {
    if (addr.trim() && !existing.has(addr.trim())) {
      await registerRelay(runtimeSnapshot, addr);
    }
  }
}

export function subscribeRuntimeEvents(
  runtimeSnapshot: XoreinRuntimeSnapshot | null,
  onStateChange: () => void,
  _onError?: (error: Error) => void,
): () => void {
  const endpoint = normalizeRuntimeEndpoint(runtimeSnapshot?.control_endpoint) || normalizeAuthRuntimeSettings(runtimeSnapshot?.settings)?.control_endpoint || '';
  if (!endpoint) {
    return () => undefined;
  }

  let stopped = false;
  const pollId = window.setInterval(onStateChange, RUNTIME_REMOTE_REFRESH_MS);
  const unlistenHandlers: UnlistenFn[] = [];
  let nativeBridgeReady = false;

  for (const eventName of NATIVE_RUNTIME_EVENT_NAMES) {
    void listen(eventName, () => {
      if (!stopped) {
        onStateChange();
      }
    }).then((unlisten) => {
      if (stopped) {
        unlisten();
        return;
      }
      unlistenHandlers.push(unlisten);
      if (!nativeBridgeReady) {
        nativeBridgeReady = true;
        window.clearInterval(pollId);
      }
    }).catch(() => undefined);
  }

  return () => {
    stopped = true;
    window.clearInterval(pollId);
    for (const unlisten of unlistenHandlers) {
      try {
        unlisten();
      } catch {
        // Ignore cleanup errors; a stopped listener should not block teardown.
      }
    }
  };
}

function clearPublishedRuntimeState(): void {
  if (typeof window === 'undefined') {
    return;
  }

  for (const key of RUNTIME_GLOBAL_KEYS) {
    delete (window as unknown as Window & Record<string, unknown>)[key];
  }
  for (const key of SESSION_GLOBAL_KEYS) {
    delete (window as unknown as Window & Record<string, unknown>)[key];
  }
  for (const key of RUNTIME_STORAGE_KEYS) {
    safeStorageRemove(() => window.localStorage, key);
    safeStorageRemove(() => window.sessionStorage, key);
  }
  for (const key of SESSION_STORAGE_KEYS) {
    safeStorageRemove(() => window.localStorage, key);
    safeStorageRemove(() => window.sessionStorage, key);
  }

  window.dispatchEvent(new Event('focus'));
  document.dispatchEvent(new Event('visibilitychange'));
}

function clearPublishedRuntimeStateForEndpoint(endpoint: string): void {
  const preferredEndpoint = readPreferredControlEndpoint();
  if (preferredEndpoint && preferredEndpoint !== endpoint) {
    return;
  }
  clearPublishedRuntimeState();
}

function publishSnapshot(
  runtimeSnapshot: XoreinRuntimeSnapshot,
  session: {
    serverId: string | null;
    manifest?: { name?: string; description?: string };
  } | null | undefined,
): void {
  if (typeof window === 'undefined') {
    return;
  }
  // Once the native engine starts it is the SOLE owner of the shared snapshot
  // keys for this tab. Any stray HTTP support call (pins, roles, moderation,
  // notifications, voice, refresh) would otherwise overwrite the native
  // servers/identity/peers with the support node's global, relay-owned view —
  // making the user's servers vanish and the UI flip to guest/peer-unreachable.
  // Keying on a per-tab runtime flag (set by the engine, not on storage or the
  // feature flag) keeps the HTTP control path fully testable in isolation, works
  // for both guest (sessionStorage) and registered (localStorage) modes, and is
  // multi-tab safe. The native engine republishes the authoritative snapshot on
  // every mutation.
  if ((window as unknown as Record<string, unknown>).__HARMOLYN_NATIVE_ACTIVE__) {
    return;
  }

  for (const key of RUNTIME_GLOBAL_KEYS) {
    (window as unknown as Window & Record<string, unknown>)[key] = runtimeSnapshot;
  }
  const serializedRuntime = JSON.stringify(runtimeSnapshot);
  for (const key of RUNTIME_STORAGE_KEYS) {
    safeStorageSet(() => window.localStorage, key, serializedRuntime);
  }

  if (session === undefined) {
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
    return;
  }

  const sessionSnapshot = session?.serverId
    ? createSessionSnapshot(session.serverId, session.manifest)
    : null;
  for (const key of SESSION_GLOBAL_KEYS) {
    (window as unknown as Window & Record<string, unknown>)[key] = sessionSnapshot;
  }
  const serializedSession = JSON.stringify(sessionSnapshot);
  for (const key of SESSION_STORAGE_KEYS) {
    safeStorageSet(() => window.localStorage, key, serializedSession);
  }

  window.dispatchEvent(new Event('focus'));
  document.dispatchEvent(new Event('visibilitychange'));
}

function encodeVoiceFrameData(payload: unknown): string {
  const raw = payload instanceof Uint8Array
    ? payload
    : payload instanceof ArrayBuffer
      ? new Uint8Array(payload)
      : new TextEncoder().encode(typeof payload === 'string' ? payload : JSON.stringify(payload));

  if (typeof btoa === 'function') {
    let binary = '';
    for (const byte of raw) {
      binary += String.fromCharCode(byte);
    }
    return btoa(binary);
  }

  return Buffer.from(raw).toString('base64');
}

function createSessionSnapshot(
  serverId: string,
  manifest?: { name?: string; description?: string },
): XoreinSessionSnapshot {
  return {
    serverId,
    securityMode: 'unspecified',
    connectedAtMs: Date.now(),
    reconnectAttempts: 0,
    manifest: {
      name: manifest?.name?.trim() || serverId,
      description: manifest?.description?.trim() || '',
    },
    acceptedProtocol: null,
  };
}

function normalizeRuntimeSnapshot(raw: ControlStateSnapshot): XoreinRuntimeSnapshot {
  const identity = normalizeRuntimeIdentity(raw.identity, raw.peer_id, raw.display_name);
  const peerId = identity?.peer_id?.trim() || optionalString(raw.peer_id) || '';
  const controlEndpoint = normalizeRuntimeEndpoint(raw.control_endpoint);

  const channelsByServer = new Map<string, XoreinRuntimeChannel[]>();
  for (const channel of raw.channels ?? []) {
    const normalizedChannel = normalizeRuntimeChannelRecord(channel);
    const serverId = normalizedChannel.server_id;
    const existing = channelsByServer.get(serverId) ?? [];
    if (existing.some((entry) => entry.id === normalizedChannel.id)) {
      continue;
    }
    channelsByServer.set(serverId, [...existing, normalizedChannel]);
  }

  const knownPeers = normalizeKnownPeers(raw.known_peers);
  const relayAddrs = normalizeRelayAddrs(raw.relay_addrs);
  const presence = normalizePresenceMap(raw.presence);
  const messages = normalizeRuntimeMessages(raw.messages);
  const friends = normalizeFriendRecords(raw.friends);
  const friendRequests = normalizeFriendRecords(raw.friend_requests);
  const telemetry = normalizeRuntimeStringList(raw.telemetry);
  const settings = normalizeRuntimeSettings(raw.settings);
  const dms = normalizeRuntimeDms(raw.dms, peerId);
  const voiceSessions = normalizeRuntimeVoiceSessions(raw.voice_sessions);
  return {
    ...(optionalString(raw.role) ? { role: optionalString(raw.role) } : {}),
    ...(peerId ? { peer_id: peerId } : {}),
    ...(controlEndpoint ? { control_endpoint: controlEndpoint } : {}),
    ...(identity ? { identity } : {}),
    known_peers: knownPeers ?? [],
    servers: normalizeRuntimeServers(raw.servers, peerId, channelsByServer),
    dms,
    messages: messages ?? [],
    friends,
    friend_requests: friendRequests,
    voice_sessions: voiceSessions ?? [],
    relay_addrs: relayAddrs ?? [],
    ...(settings ? { settings } : {}),
    telemetry,
    ...(presence !== undefined ? { presence } : {}),
  };
}

function normalizeRuntimeServers(
  value: unknown,
  localPeerId: string,
  channelsByServer: Map<string, XoreinRuntimeChannel[]>,
): XoreinRuntimeServer[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new XoreinControlError('invalid_response', 'xorein runtime state was incomplete.', 502);
  }
  const normalized: XoreinRuntimeServer[] = [];
  const seenIds = new Set<string>();
  for (const server of value) {
    const normalizedServerId = optionalString((server as { id?: unknown } | null)?.id);
    const normalizedServer = normalizeServer(server, localPeerId, normalizedServerId ? (channelsByServer.get(normalizedServerId) ?? []) : []);
    if (seenIds.has(normalizedServer.id)) {
      continue;
    }
    seenIds.add(normalizedServer.id);
    normalized.push(normalizedServer);
  }
  return normalized;
}

function normalizeRuntimeDms(value: unknown, localPeerId: string): XoreinRuntimeDM[] {
  if (value == null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new XoreinControlError('invalid_response', 'xorein runtime state was incomplete.', 502);
  }
  const normalized: XoreinRuntimeDM[] = [];
  const seenIds = new Set<string>();
  for (const entry of value) {
    const dm = normalizeDM(entry as ControlStateDM, localPeerId);
    if (seenIds.has(dm.id)) {
      continue;
    }
    seenIds.add(dm.id);
    normalized.push(dm);
  }
  return normalized;
}

function normalizeRuntimeIdentity(
  value: unknown,
  fallbackPeerId?: string,
  fallbackDisplayName?: string,
): XoreinRuntimeSnapshot['identity'] | undefined {
  if (!isRecord(value) && !fallbackPeerId && !fallbackDisplayName) {
    return undefined;
  }

  const peerId = typeof (value as { peer_id?: unknown } | null)?.peer_id === 'string'
    ? ((value as { peer_id?: string }).peer_id?.trim() || '')
    : '';
  const displayName = normalizeRuntimeIdentityProfileName((value as { profile?: unknown } | null)?.profile)
    || (typeof fallbackDisplayName === 'string' ? fallbackDisplayName.trim() : '');
  const bio = normalizeRuntimeIdentityProfileBio((value as { profile?: unknown } | null)?.profile);
  const id = typeof (value as { id?: unknown } | null)?.id === 'string'
    ? ((value as { id?: string }).id?.trim() || '')
    : '';
  const publicKey = typeof (value as { public_key?: unknown } | null)?.public_key === 'string'
    ? ((value as { public_key?: string }).public_key?.trim() || '')
    : '';
  const createdAt = typeof (value as { created_at?: unknown } | null)?.created_at === 'string'
    ? ((value as { created_at?: string }).created_at?.trim() || '')
    : '';
  const resolvedPeerId = peerId || (typeof fallbackPeerId === 'string' ? fallbackPeerId.trim() : '');

  if (!resolvedPeerId) {
    return undefined;
  }

  return {
    ...(id || resolvedPeerId ? { id: id || resolvedPeerId } : {}),
    peer_id: resolvedPeerId,
    ...(publicKey ? { public_key: publicKey } : {}),
    ...(createdAt ? { created_at: createdAt } : {}),
    ...(displayName || bio ? {
      profile: {
        ...(displayName ? { display_name: displayName } : {}),
        ...(bio ? { bio } : {}),
      },
    } : {}),
  };
}

function normalizeRuntimeIdentityProfileName(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return typeof value.display_name === 'string' && value.display_name.trim()
    ? value.display_name.trim()
    : undefined;
}

function normalizeRuntimeIdentityProfileBio(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return typeof value.bio === 'string' && value.bio.trim()
    ? value.bio.trim()
    : undefined;
}

function normalizeServer(
  server: ControlStateServer,
  localPeerId: string,
  topLevelChannels: XoreinRuntimeChannel[],
): XoreinRuntimeServer {
  const id = server.id?.trim();
  const name = server.name?.trim();
  if (!id || !name) {
    throw new XoreinControlError('invalid_response', 'xorein runtime state was incomplete.', 502);
  }
  const embeddedChannels = normalizeServerChannels(server.id, server.channels);
  const channels: Record<string, XoreinRuntimeChannel> = {};
  for (const channel of topLevelChannels) {
    if (Object.prototype.hasOwnProperty.call(channels, channel.id)) {
      if (!areRuntimeChannelsEquivalent(channels[channel.id], channel)) {
        throw new XoreinControlError('invalid_response', 'xorein runtime state server channels were inconsistent.', 502);
      }
      continue;
    }
    channels[channel.id] = channel;
  }
  for (const [channelId, channel] of Object.entries(embeddedChannels)) {
    if (Object.prototype.hasOwnProperty.call(channels, channelId)) {
      if (!areRuntimeChannelsEquivalent(channels[channelId], channel)) {
        throw new XoreinControlError('invalid_response', 'xorein runtime state server channels were inconsistent.', 502);
      }
      continue;
    }
    channels[channelId] = channel;
  }
  const ownerPeerId = server.owner_peer_id?.trim() || localPeerId;
  const members = uniqueStrings([
    ...(server.members ?? []),
    ownerPeerId,
    localPeerId,
  ]);
  const manifest = normalizeRuntimeManifest(server.manifest, name, server.description ?? '');
  const description = optionalString(server.description)?.trim();
  const createdAt = optionalString(server.created_at);
  const updatedAt = optionalString(server.updated_at);
  const invite = optionalString(server.invite);

  return {
    id,
    name,
    owner_peer_id: ownerPeerId,
    ...(description ? { description } : {}),
    ...(createdAt ? { created_at: createdAt } : {}),
    ...(updatedAt ? { updated_at: updatedAt } : {}),
    members,
    channels,
    ...(manifest ? { manifest } : {}),
    ...(invite ? { invite } : {}),
  };
}

function normalizeRuntimeChannelRecord(value: unknown): XoreinRuntimeChannel {
  if (!isRecord(value)) {
    throw new XoreinControlError('invalid_response', 'xorein runtime state was incomplete.', 502);
  }
  const id = optionalString(value.id);
  const serverId = optionalString(value.server_id);
  const name = optionalString(value.name);
  const createdAt = optionalString(value.created_at);
  if (!id || !serverId || !name || typeof value.voice !== 'boolean') {
    throw new XoreinControlError('invalid_response', 'xorein runtime state was incomplete.', 502);
  }
  return {
    id,
    server_id: serverId,
    name,
    voice: value.voice,
    ...(createdAt ? { created_at: createdAt } : {}),
  };
}

function areRuntimeChannelsEquivalent(left: XoreinRuntimeChannel, right: XoreinRuntimeChannel): boolean {
  return left.id === right.id
    && left.server_id === right.server_id
    && left.name === right.name
    && left.voice === right.voice
    && (left.created_at ?? undefined) === (right.created_at ?? undefined);
}

function normalizeServerChannels(
  serverId: string,
  channels: ControlStateServer['channels'] | undefined,
): Record<string, XoreinRuntimeChannel> {
  if (!channels) {
    return {};
  }
  if (!isRecord(channels)) {
    throw new XoreinControlError('invalid_response', 'xorein runtime state was incomplete.', 502);
  }
  const normalizedEntries = Object.entries(channels).map(([channelId, value]) => {
    const channel = normalizeRuntimeChannelRecord(value);
    if (channel.id !== channelId || channel.server_id !== serverId) {
      throw new XoreinControlError('invalid_response', 'xorein runtime state server channels were inconsistent.', 502);
    }
    return [channelId, channel] as const;
  });
  if (normalizedEntries.length === 0) {
    return {};
  }
  const normalized: Record<string, XoreinRuntimeChannel> = {};
  for (const [channelId, channel] of normalizedEntries) {
    if (Object.prototype.hasOwnProperty.call(normalized, channelId)) {
      continue;
    }
    normalized[channelId] = channel;
  }
  return normalized;
}

function normalizeRuntimeManifest(
  manifest: ControlStateServer['manifest'] | undefined,
  fallbackName: string,
  fallbackDescription: string,
): XoreinRuntimeServer['manifest'] {
  if (!isRecord(manifest)) {
    return {
      name: fallbackName,
      description: fallbackDescription,
    };
  }

  const name = optionalString(manifest.name)?.trim() || fallbackName;
  const description = optionalString(manifest.description)?.trim() || fallbackDescription;
  const ownerAddresses = normalizeRuntimeStringList(manifest.owner_addresses);
  const bootstrapAddrs = normalizeRuntimeStringList(manifest.bootstrap_addrs);
  const relayAddrs = normalizeRuntimeStringList(manifest.relay_addrs);
  const capabilities = normalizeRuntimeStringList(manifest.capabilities);

  return {
    name,
    description,
    ...(ownerAddresses.length > 0 ? { owner_addresses: ownerAddresses } : {}),
    ...(bootstrapAddrs.length > 0 ? { bootstrap_addrs: bootstrapAddrs } : {}),
    ...(relayAddrs.length > 0 ? { relay_addrs: relayAddrs } : {}),
    ...(capabilities.length > 0 ? { capabilities } : {}),
    ...(typeof manifest.history_coverage === 'string' && manifest.history_coverage.trim() ? { history_coverage: manifest.history_coverage.trim() } : {}),
    ...(typeof manifest.history_retention_messages === 'number' && Number.isFinite(manifest.history_retention_messages) ? { history_retention_messages: manifest.history_retention_messages } : {}),
  };
}

function normalizeDM(dm: ControlStateDM, localPeerId: string): XoreinRuntimeDM {
  const id = dm.id?.trim();
  const remotePeerId = dm.peer_id?.trim() ?? '';
  const explicitParticipants = dm.participants ?? [];
  const participants = explicitParticipants.length > 0
    ? normalizePeerIdList(explicitParticipants)
    : uniqueStrings([localPeerId, remotePeerId]);
  if (!id) {
    throw new XoreinControlError('invalid_response', 'xorein runtime state was incomplete.', 502);
  }
  const createdAt = optionalString(dm.created_at);

  return {
    id,
    participants,
    ...(createdAt ? { created_at: createdAt } : {}),
  };
}

function normalizeRuntimeVoiceSessions(value: unknown): XoreinRuntimeVoiceSession[] | undefined {
  if (value == null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new XoreinControlError('invalid_response', 'xorein runtime state was incomplete.', 502);
  }
  const normalized: XoreinRuntimeVoiceSession[] = [];
  const seenChannelIds = new Set<string>();
  for (const entry of value) {
    const session = normalizeVoiceSession(entry as ControlStateVoiceSession);
    if (seenChannelIds.has(session.channel_id)) {
      continue;
    }
    seenChannelIds.add(session.channel_id);
    normalized.push(session);
  }
  return normalized;
}

function normalizeVoiceSession(session: ControlStateVoiceSession): XoreinRuntimeVoiceSession {
  const channelId = session.channel_id?.trim() || session.id?.trim() || '';
  const participants = normalizeVoiceParticipants(session.participants);
  if (!channelId) {
    throw new XoreinControlError('invalid_response', 'xorein runtime state was incomplete.', 502);
  }

  return {
    channel_id: channelId,
    participants,
  };
}

function normalizePeerIdList(values: unknown[]): string[] {
  const peerIds = values.map((value) => optionalString(value));
  if (peerIds.some((peerId) => !peerId)) {
    throw new XoreinControlError('invalid_response', 'xorein runtime state was incomplete.', 502);
  }
  return uniqueStrings(peerIds as string[]);
}

function normalizeVoiceParticipants(
  participants: ControlStateVoiceSession['participants'],
): Record<string, XoreinRuntimeVoiceParticipant> {
  if (Array.isArray(participants)) {
    const peerIds = normalizePeerIdList(participants);
    const normalized: Record<string, XoreinRuntimeVoiceParticipant> = {};
    for (const peerId of peerIds) {
      if (Object.prototype.hasOwnProperty.call(normalized, peerId)) {
        continue;
      }
      normalized[peerId] = { peer_id: peerId };
    }
    return normalized;
  }
  if (participants === undefined) {
    return {};
  }
  if (!isRecord(participants)) {
    throw new XoreinControlError('invalid_response', 'xorein runtime state was incomplete.', 502);
  }

  const normalizedEntries = Object.entries(participants).map(([peerId, value]) => {
    const normalizedPeerId = optionalString(peerId);
    if (!normalizedPeerId || !isRecord(value)) {
      throw new XoreinControlError('invalid_response', 'xorein runtime state was incomplete.', 502);
    }
    const participantPeerId = optionalString(value.peer_id);
    const muted = value.muted;
    const joinedAt = optionalString(value.joined_at);
    const lastFrameAt = optionalString(value.last_frame_at);
    if (participantPeerId !== normalizedPeerId) {
      throw new XoreinControlError('invalid_response', 'xorein runtime state voice participants were inconsistent.', 502);
    }
    if (muted !== undefined && typeof muted !== 'boolean') {
      throw new XoreinControlError('invalid_response', 'xorein runtime state was incomplete.', 502);
    }
    return [
      normalizedPeerId,
      {
        peer_id: normalizedPeerId,
        ...(muted !== undefined ? { muted } : {}),
        ...(joinedAt ? { joined_at: joinedAt } : {}),
        ...(lastFrameAt ? { last_frame_at: lastFrameAt } : {}),
      },
    ] as const;
  });
  if (normalizedEntries.length === 0) {
    return {};
  }
  const normalized: Record<string, XoreinRuntimeVoiceParticipant> = {};
  for (const [peerId, participant] of normalizedEntries) {
    if (Object.prototype.hasOwnProperty.call(normalized, peerId)) {
      continue;
    }
    normalized[peerId] = participant;
  }
  return normalized;
}

function normalizeKnownPeers(value: unknown): XoreinRuntimePeer[] | undefined {
  if (value == null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new XoreinControlError('invalid_response', 'xorein runtime state was incomplete.', 502);
  }
  const peers: XoreinRuntimePeer[] = [];
  const seenPeerIds = new Set<string>();
  for (const entry of value) {
    const peer = normalizeRuntimePeerRecord(entry);
    if (seenPeerIds.has(peer.peer_id)) {
      continue;
    }
    seenPeerIds.add(peer.peer_id);
    peers.push(peer);
  }
  return peers;
}

function normalizeRuntimePeerRecord(value: unknown): XoreinRuntimePeer {
  if (!isRecord(value)) {
    throw new XoreinControlError('invalid_response', 'xorein runtime state was incomplete.', 502);
  }
  const peerId = optionalString(value.peer_id);
  if (!peerId) {
    throw new XoreinControlError('invalid_response', 'xorein runtime state was incomplete.', 502);
  }
  const role = optionalString(value.role);
  const publicKey = optionalString(value.public_key);
  const source = optionalString(value.source);
  const lastSeenAt = optionalString(value.last_seen_at);
  const addresses = value.addresses === undefined
    ? undefined
    : normalizeStringList(value.addresses);
  return {
    peer_id: peerId,
    ...(role ? { role } : {}),
    ...(addresses !== undefined ? { addresses } : {}),
    ...(publicKey ? { public_key: publicKey } : {}),
    ...(source ? { source } : {}),
    ...(lastSeenAt ? { last_seen_at: lastSeenAt } : {}),
  };
}

function normalizeRelayAddrs(value: unknown): string[] | undefined {
  if (value == null) {
    return undefined;
  }
  return normalizeStringList(value);
}

function normalizeRuntimeSettings(value: unknown): Record<string, string> | undefined {
  if (value == null) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new XoreinControlError('invalid_response', 'xorein runtime state was incomplete.', 502);
  }

  const entries = Object.entries(value).flatMap(([key, entry]) => {
    const normalizedKey = optionalString(key);
    const normalizedValue = optionalString(entry);
    if (!normalizedKey || !normalizedValue) {
      return [];
    }
    return [[normalizedKey, normalizedValue] as const];
  });
  if (entries.length === 0) {
    return undefined;
  }
  const normalized: Record<string, string> = {};
  for (const [key, entry] of entries) {
    if (Object.prototype.hasOwnProperty.call(normalized, key)) {
      continue;
    }
    normalized[key] = entry;
  }
  return normalized;
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new XoreinControlError('invalid_response', 'xorein runtime state was incomplete.', 502);
  }
  const entries = value.map((entry) => optionalString(entry));
  if (entries.some((entry) => !entry)) {
    throw new XoreinControlError('invalid_response', 'xorein runtime state was incomplete.', 502);
  }
  return uniqueStrings(entries as string[]);
}

function normalizeRuntimeStringList(value: unknown): string[] {
  if (value == null) {
    return [];
  }
  if (!Array.isArray(value)) {
    return [];
  }
  return uniqueStrings(
    value
      .map((entry) => optionalString(entry))
      .filter((entry): entry is string => Boolean(entry)),
  );
}

function normalizePresenceMap(value: unknown): Record<string, XoreinPresenceEntry> | undefined {
  if (value == null) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new XoreinControlError('invalid_response', 'xorein runtime state was incomplete.', 502);
  }
  const normalizedEntries = Object.entries(value).map(([peerId, entry]) => {
    const normalizedPeerId = optionalString(peerId);
    if (!normalizedPeerId || !isRecord(entry)) {
      throw new XoreinControlError('invalid_response', 'xorein runtime state was incomplete.', 502);
    }
    const status = optionalString(entry.status);
    const statusText = optionalString(entry.status_text);
    const typingInScope = optionalString(entry.typing_in_scope);
    const updatedAt = optionalString(entry.updated_at);
    if (!status || !updatedAt) {
      throw new XoreinControlError('invalid_response', 'xorein runtime state was incomplete.', 502);
    }
    return [
      normalizedPeerId,
      {
        status,
        updated_at: updatedAt,
        ...(statusText ? { status_text: statusText } : {}),
        ...(typingInScope ? { typing_in_scope: typingInScope } : {}),
      },
    ] as const;
  });
  if (normalizedEntries.length === 0) {
    return undefined;
  }
  const normalized: Record<string, XoreinPresenceEntry> = {};
  for (const [peerId, entry] of normalizedEntries) {
    if (Object.prototype.hasOwnProperty.call(normalized, peerId)) {
      continue;
    }
    normalized[peerId] = entry;
  }
  return normalized;
}

function normalizeFriendRecords(value: unknown): XoreinFriendRecord[] {
  if (value == null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new XoreinControlError('invalid_response', 'xorein control response was incomplete.', 502);
  }
  const normalized: XoreinFriendRecord[] = [];
  const seenIds = new Set<string>();
  for (const entry of value) {
    const record = normalizeFriendRecord(entry);
    if (seenIds.has(record.id)) {
      continue;
    }
    seenIds.add(record.id);
    normalized.push(record);
  }
  return normalized;
}

function normalizeFriendRecord(value: unknown): XoreinFriendRecord {
  if (!isRecord(value)) {
    throw new XoreinControlError('invalid_response', 'xorein control response was incomplete.', 502);
  }
  const id = optionalString(value.id);
  const fromPeerId = optionalString(value.from_peer_id);
  const toPeerId = optionalString(value.to_peer_id);
  const toPeerAddr = optionalString(value.to_peer_addr);
  const status = optionalString(value.status);
  const createdAt = optionalString(value.created_at);
  if (!id || !fromPeerId || !status) {
    throw new XoreinControlError('invalid_response', 'xorein control response was incomplete.', 502);
  }
  if (!isFriendStatus(status)) {
    throw new XoreinControlError('invalid_response', 'xorein control response was incomplete.', 502);
  }
  return {
    id,
    from_peer_id: fromPeerId,
    status,
    ...(toPeerId ? { to_peer_id: toPeerId } : {}),
    ...(toPeerAddr ? { to_peer_addr: toPeerAddr } : {}),
    ...(createdAt ? { created_at: createdAt } : {}),
  };
}

function isFriendStatus(status: string): status is XoreinFriendRecord['status'] {
  return ['pending', 'accepted', 'declined', 'cancelled', 'blocked'].includes(status);
}

function normalizeNotificationRecords(value: unknown): XoreinNotificationRecord[] {
  if (value == null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new XoreinControlError('invalid_response', 'xorein control response was incomplete.', 502);
  }
  const normalized: XoreinNotificationRecord[] = [];
  const seenIds = new Set<string>();
  for (const entry of value) {
    const record = normalizeNotificationRecord(entry);
    if (seenIds.has(record.id)) {
      continue;
    }
    seenIds.add(record.id);
    normalized.push(record);
  }
  return normalized;
}

function normalizeNotificationRecord(value: unknown): XoreinNotificationRecord {
  if (!isRecord(value)) {
    throw new XoreinControlError('invalid_response', 'xorein control response was incomplete.', 502);
  }
  const id = optionalString(value.id);
  const type = optionalString(value.type);
  const scopeId = optionalString(value.scope_id);
  const scopeType = optionalString(value.scope_type);
  const serverId = optionalString(value.server_id);
  const messageId = optionalString(value.message_id);
  const createdAt = optionalString(value.created_at);
  const read = value.read;
  if (!id || !type || typeof read !== 'boolean') {
    throw new XoreinControlError('invalid_response', 'xorein control response was incomplete.', 502);
  }
  if (scopeType && !['channel', 'dm'].includes(scopeType)) {
    throw new XoreinControlError('invalid_response', 'xorein control response was incomplete.', 502);
  }
  return {
    id,
    type,
    read,
    ...(scopeId ? { scope_id: scopeId } : {}),
    ...(scopeType ? { scope_type: scopeType } : {}),
    ...(serverId ? { server_id: serverId } : {}),
    ...(messageId ? { message_id: messageId } : {}),
    ...(createdAt ? { created_at: createdAt } : {}),
  };
}

function normalizeNotificationSummary(value: unknown): XoreinNotificationSummary {
  if (!isRecord(value)) {
    throw new XoreinControlError('invalid_response', 'xorein control response was incomplete.', 502);
  }
  const totalUnread = value.total_unread;
  const byServer = value.by_server;
  const dmsUnread = value.dms_unread;
  if (typeof totalUnread !== 'number' || !Number.isFinite(totalUnread) || totalUnread < 0
    || typeof dmsUnread !== 'number' || !Number.isFinite(dmsUnread) || dmsUnread < 0
    || !isRecord(byServer)) {
    throw new XoreinControlError('invalid_response', 'xorein control response was incomplete.', 502);
  }
  const normalizedByServer: Record<string, { unread: number; mentions: number }> = {};
  for (const [serverId, entry] of Object.entries(byServer)) {
    const normalizedServerId = optionalString(serverId);
    if (!normalizedServerId || !isRecord(entry)) {
      throw new XoreinControlError('invalid_response', 'xorein control response was incomplete.', 502);
    }
    const unread = entry.unread;
    const mentions = entry.mentions;
    if (typeof unread !== 'number' || !Number.isFinite(unread) || unread < 0
      || typeof mentions !== 'number' || !Number.isFinite(mentions) || mentions < 0) {
      throw new XoreinControlError('invalid_response', 'xorein control response was incomplete.', 502);
    }
    if (!Object.prototype.hasOwnProperty.call(normalizedByServer, normalizedServerId)) {
      normalizedByServer[normalizedServerId] = { unread, mentions };
    }
  }
  return { total_unread: totalUnread, by_server: normalizedByServer, dms_unread: dmsUnread };
}

function normalizeReadThrough(value: unknown): XoreinReadThrough {
  if (!isRecord(value)) {
    throw new XoreinControlError('invalid_response', 'xorein control response was incomplete.', 502);
  }
  const scopeId = optionalString(value.scope_id);
  const scopeType = optionalString(value.scope_type);
  const readThroughMessageId = optionalString(value.read_through_message_id);
  const updatedAt = optionalString(value.updated_at);
  if (!scopeId || !scopeType || !readThroughMessageId || !['channel', 'dm'].includes(scopeType)) {
    throw new XoreinControlError('invalid_response', 'xorein control response was incomplete.', 502);
  }
  return {
    scope_id: scopeId,
    scope_type: scopeType as 'channel' | 'dm',
    read_through_message_id: readThroughMessageId,
    ...(updatedAt ? { updated_at: updatedAt } : {}),
  };
}

function normalizeIdentityBackupDocument(value: unknown): XoreinIdentityBackupDocument {
  if (!isRecord(value)) {
    throw new XoreinControlError('invalid_response', 'xorein control response was incomplete.', 502);
  }
  const version = value.version;
  const alg = optionalString(value.alg);
  const peerId = optionalString(value.peer_id);
  const salt = optionalString(value.salt);
  const nonce = optionalString(value.nonce);
  const ciphertext = optionalString(value.ciphertext);
  if (version !== 2 || !alg || !peerId || !salt || !nonce || !ciphertext) {
    throw new XoreinControlError('invalid_response', 'xorein control response was incomplete.', 502);
  }
  return {
    version,
    alg,
    peer_id: peerId,
    salt,
    nonce,
    ciphertext,
  };
}

function normalizeControlServerRecord(value: unknown): ControlServerRecord {
  if (!isRecord(value)) {
    throw new XoreinControlError('invalid_response', 'xorein control response was incomplete.', 502);
  }
  const id = optionalString(value.id);
  const name = optionalString(value.name);
  const description = optionalString(value.description);
  const ownerPeerId = optionalString(value.owner_peer_id);
  const securityMode = optionalString(value.security_mode);
  const createdAt = optionalString(value.created_at);
  if (!id || !name || !ownerPeerId || !securityMode || !createdAt) {
    throw new XoreinControlError('invalid_response', 'xorein control response was incomplete.', 502);
  }
  return {
    id,
    name,
    ...(description ? { description } : {}),
    owner_peer_id: ownerPeerId,
    security_mode: securityMode,
    created_at: createdAt,
  };
}

function normalizeMessageRecord(value: unknown): XoreinMessageRecord {
  return normalizeRuntimeMessageRecord(value);
}

function normalizeMessageSearchResult(value: unknown): XoreinMessageSearchResult {
  if (!isRecord(value)) {
    throw new XoreinControlError('invalid_response', 'xorein control response was incomplete.', 502);
  }
  return {
    messages: normalizeStringListFromResponse(value.messages, 'messages'),
    results: normalizeMessageRecords(value.results),
  };
}

function normalizeMessageRecords(value: unknown): XoreinMessageRecord[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new XoreinControlError('invalid_response', 'xorein control response was incomplete.', 502);
  }
  const normalized: XoreinMessageRecord[] = [];
  const seenIds = new Set<string>();
  for (const entry of value) {
    const record = normalizeMessageRecord(entry);
    if (seenIds.has(record.id)) {
      continue;
    }
    seenIds.add(record.id);
    normalized.push(record);
  }
  return normalized;
}

function normalizeStringListFromResponse(value: unknown, fieldName: string): string[] {
  if (value === undefined) {
    return [];
  }
  try {
    return normalizeStringList(value);
  } catch {
    throw new XoreinControlError('invalid_response', `xorein control response field ${fieldName} was incomplete.`, 502);
  }
}

function normalizePinnedMessageIds(value: unknown, expectedChannelId: string): string[] {
  if (!isRecord(value)) {
    throw new XoreinControlError('invalid_response', 'xorein control response was incomplete.', 502);
  }
  const channelId = optionalString(value.channel_id);
  if (channelId !== expectedChannelId) {
    throw new XoreinControlError('invalid_response', 'xorein control response was incomplete.', 502);
  }
  return normalizeStringListFromResponse(value.pinned, 'pinned');
}

function normalizeIdentityRecord(value: unknown): XoreinIdentityRecord {
  if (!isRecord(value)) {
    throw new XoreinControlError('invalid_response', 'xorein control response was incomplete.', 502);
  }
  const id = optionalString(value.id);
  const peerId = optionalString(value.peer_id);
  const activePeerId = optionalString(value.active_peer_id);
  const publicKey = optionalString(value.public_key);
  const createdAt = optionalString(value.created_at);
  const displayName = optionalString(value.display_name);
  const bio = optionalString(value.bio);
  const restartRequired = value.restart_required;
  const profile = value.profile;
  if (!peerId) {
    throw new XoreinControlError('invalid_response', 'xorein control response was incomplete.', 502);
  }
  if (restartRequired !== undefined && typeof restartRequired !== 'boolean') {
    throw new XoreinControlError('invalid_response', 'xorein control response was incomplete.', 502);
  }
  let normalizedProfile: XoreinIdentityRecord['profile'] | undefined;
  if (profile !== undefined) {
    if (!isRecord(profile)) {
      throw new XoreinControlError('invalid_response', 'xorein control response was incomplete.', 502);
    }
    const profileDisplayName = optionalString(profile.display_name);
    const profileBio = optionalString(profile.bio);
    normalizedProfile = {
      ...(profileDisplayName ? { display_name: profileDisplayName } : {}),
      ...(profileBio ? { bio: profileBio } : {}),
    };
  }
  return {
    ...(id ? { id } : {}),
    peer_id: peerId,
    ...(activePeerId ? { active_peer_id: activePeerId } : {}),
    ...(restartRequired !== undefined ? { restart_required: restartRequired as boolean } : {}),
    ...(publicKey ? { public_key: publicKey } : {}),
    ...(createdAt ? { created_at: createdAt } : {}),
    ...(displayName ? { display_name: displayName } : {}),
    ...(bio ? { bio } : {}),
    ...(normalizedProfile ? { profile: normalizedProfile } : {}),
  };
}

function normalizeDmRecords(value: unknown): XoreinDmRecord[] {
  if (value === undefined) {
    return [];
  }
  if (!isRecord(value)) {
    throw new XoreinControlError('invalid_response', 'xorein control response was incomplete.', 502);
  }
  return normalizeDmArray(value.dms);
}

function normalizeDmArray(value: unknown): XoreinDmRecord[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new XoreinControlError('invalid_response', 'xorein control response was incomplete.', 502);
  }
  const normalized: XoreinDmRecord[] = [];
  const seenIds = new Set<string>();
  for (const entry of value) {
    const record = normalizeDmRecord(entry);
    if (seenIds.has(record.id)) {
      continue;
    }
    seenIds.add(record.id);
    normalized.push(record);
  }
  return normalized;
}

function normalizeDmRecord(value: unknown): XoreinDmRecord {
  if (!isRecord(value)) {
    throw new XoreinControlError('invalid_response', 'xorein control response was incomplete.', 502);
  }
  const id = optionalString(value.id);
  const peerId = optionalString(value.peer_id);
  const createdAt = optionalString(value.created_at);
  if (!id || !peerId || !createdAt) {
    throw new XoreinControlError('invalid_response', 'xorein control response was incomplete.', 502);
  }
  return {
    id,
    participants: uniqueStrings([peerId]),
    created_at: createdAt,
  };
}

function normalizeRoleRecords(value: unknown): XoreinRoleEntry[] {
  if (value === undefined) {
    return [];
  }
  if (!isRecord(value)) {
    throw new XoreinControlError('invalid_response', 'xorein control response was incomplete.', 502);
  }
  const roles = value.roles;
  if (roles === undefined) {
    return [];
  }
  if (!Array.isArray(roles)) {
    throw new XoreinControlError('invalid_response', 'xorein control response was incomplete.', 502);
  }
  const normalized: XoreinRoleEntry[] = [];
  const seenPeerIds = new Set<string>();
  for (const entry of roles) {
    if (!isRecord(entry)) {
      throw new XoreinControlError('invalid_response', 'xorein control response was incomplete.', 502);
    }
    const peerId = optionalString(entry.peer_id);
    const role = optionalString(entry.role);
    const version = entry.version;
    if (!peerId || !role || typeof version !== 'number' || !Number.isFinite(version)) {
      throw new XoreinControlError('invalid_response', 'xorein control response was incomplete.', 502);
    }
    if (seenPeerIds.has(peerId)) {
      continue;
    }
    seenPeerIds.add(peerId);
    normalized.push({
      peer_id: peerId,
      role,
      version,
    });
  }
  return normalized;
}

function normalizeGroupDmRecords(value: unknown): XoreinGroupDmRecord[] {
  if (value === undefined) {
    return [];
  }
  if (!isRecord(value)) {
    throw new XoreinControlError('invalid_response', 'xorein control response was incomplete.', 502);
  }
  const groupDms = value.group_dms;
  if (groupDms === undefined) {
    return [];
  }
  if (!Array.isArray(groupDms)) {
    throw new XoreinControlError('invalid_response', 'xorein control response was incomplete.', 502);
  }
  const normalized: XoreinGroupDmRecord[] = [];
  const seenIds = new Set<string>();
  for (const entry of groupDms) {
    const record = normalizeGroupDmRecord(entry);
    if (seenIds.has(record.id)) {
      continue;
    }
    seenIds.add(record.id);
    normalized.push(record);
  }
  return normalized;
}

function normalizeGroupDmRecord(value: unknown): XoreinGroupDmRecord {
  if (!isRecord(value)) {
    throw new XoreinControlError('invalid_response', 'xorein control response was incomplete.', 502);
  }
  const id = optionalString(value.id);
  const name = optionalString(value.name);
  const members = normalizeStringList(value.members);
  const createdAt = optionalString(value.created_at);
  if (!id || !createdAt) {
    throw new XoreinControlError('invalid_response', 'xorein control response was incomplete.', 502);
  }
  return {
    id,
    ...(name ? { name } : {}),
    members,
    created_at: createdAt,
  };
}

function normalizeRuntimeMessages(value: unknown): XoreinRuntimeMessage[] | undefined {
  if (value == null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new XoreinControlError('invalid_response', 'xorein runtime state was incomplete.', 502);
  }
  const normalized: XoreinRuntimeMessage[] = [];
  const seenIds = new Set<string>();
  for (const entry of value) {
    const message = normalizeRuntimeMessageRecord(entry);
    if (seenIds.has(message.id)) {
      continue;
    }
    seenIds.add(message.id);
    normalized.push(message);
  }
  return normalized;
}

function normalizeRuntimeMessageRecord(value: unknown): XoreinRuntimeMessage {
  if (!isRecord(value)) {
    throw new XoreinControlError('invalid_response', 'xorein runtime state was incomplete.', 502);
  }
  const id = optionalString(value.id);
  const scopeType = optionalString(value.scope_type);
  const scopeId = optionalString(value.scope_id);
  const senderPeerId = optionalString(value.sender_peer_id);
  const body = optionalString(value.body);
  const serverId = optionalString(value.server_id);
  const replyTo = optionalString(value.reply_to);
  const forwardedFrom = optionalString(value.forwarded_from);
  const createdAt = optionalString(value.created_at);
  const updatedAt = optionalString(value.updated_at);
  const deleted = value.deleted;
  const reactions = normalizeRuntimeReactions(value.reactions);
  if (!id || !scopeType || !scopeId || !senderPeerId || !body) {
    throw new XoreinControlError('invalid_response', 'xorein runtime state was incomplete.', 502);
  }
  if (deleted !== undefined && typeof deleted !== 'boolean') {
    throw new XoreinControlError('invalid_response', 'xorein runtime state was incomplete.', 502);
  }
  return {
    id,
    scope_type: scopeType,
    scope_id: scopeId,
    sender_peer_id: senderPeerId,
    body,
    ...(serverId ? { server_id: serverId } : {}),
    ...(replyTo ? { reply_to: replyTo } : {}),
    ...(forwardedFrom ? { forwarded_from: forwardedFrom } : {}),
    ...(reactions.length > 0 ? { reactions } : {}),
    ...(createdAt ? { created_at: createdAt } : {}),
    ...(updatedAt ? { updated_at: updatedAt } : {}),
    ...(deleted !== undefined ? { deleted: deleted as boolean } : {}),
  };
}

// normalizeRuntimeReactions validates the optional reactions array from the
// xorein /v1/state snapshot, dropping any malformed entries. Mirrors the
// backend ReactionEntry shape { emoji, count, reacted }.
function normalizeRuntimeReactions(value: unknown): { emoji: string; count: number; reacted: boolean }[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: { emoji: string; count: number; reacted: boolean }[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) {
      continue;
    }
    const emoji = optionalString(entry.emoji);
    if (!emoji || typeof entry.count !== 'number') {
      continue;
    }
    out.push({ emoji, count: entry.count, reacted: entry.reacted === true });
  }
  return out;
}

function parseIdentityBackupDocument(rawBackup: string): XoreinIdentityBackupDocument {
  const trimmed = rawBackup.trim();
  if (!trimmed) {
    throw new XoreinControlError('invalid_request', 'Paste an encrypted identity backup to restore.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new XoreinControlError('invalid_request', 'Identity backup must be valid JSON.');
  }

  const candidate = unwrapBackupEnvelope(parsed);
  if (!isRecord(candidate)
    || typeof candidate.version !== 'number'
    || typeof candidate.alg !== 'string'
    || typeof candidate.peer_id !== 'string'
    || typeof candidate.salt !== 'string'
    || typeof candidate.nonce !== 'string'
    || typeof candidate.ciphertext !== 'string') {
    throw new XoreinControlError('invalid_request', 'Identity backup JSON is missing required fields.');
  }

  return {
    version: candidate.version,
    alg: candidate.alg,
    peer_id: candidate.peer_id,
    salt: candidate.salt,
    nonce: candidate.nonce,
    ciphertext: candidate.ciphertext,
  };
}

function unwrapBackupEnvelope(parsed: unknown): unknown {
  if (!isRecord(parsed) || !('backup' in parsed)) {
    return parsed;
  }

  const wrapped = parsed.backup;
  if (typeof wrapped !== 'string') {
    return wrapped;
  }
  try {
    return JSON.parse(wrapped);
  } catch {
    return wrapped;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizeControlChannelRecord(value: unknown): ControlChannelRecord {
  if (!isRecord(value)) {
    throw new XoreinControlError('invalid_response', 'xorein discovery response was incomplete.', 502);
  }
  const id = optionalString(value.id);
  const serverId = optionalString(value.server_id);
  const name = optionalString(value.name);
  const createdAt = optionalString(value.created_at);
  if (!id || !serverId || !name || typeof value.voice !== 'boolean') {
    throw new XoreinControlError('invalid_response', 'xorein discovery response was incomplete.', 502);
  }
  return {
    id,
    server_id: serverId,
    name,
    voice: value.voice,
    ...(createdAt ? { created_at: createdAt } : {}),
  };
}

function normalizeControlChannelRecordForServer(value: unknown, serverId: string): ControlChannelRecord {
  const channel = normalizeControlChannelRecord(value);
  if (channel.server_id !== serverId) {
    throw new XoreinControlError('invalid_response', 'xorein control response was incomplete.', 502);
  }
  return channel;
}

function normalizeControlChannelRecords(value: unknown): ControlChannelRecord[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new XoreinControlError('invalid_response', 'xorein discovery response was incomplete.', 502);
  }
  const normalized: ControlChannelRecord[] = [];
  const seenIds = new Set<string>();
  for (const entry of value) {
    const channel = normalizeControlChannelRecord(entry);
    if (seenIds.has(channel.id)) {
      continue;
    }
    seenIds.add(channel.id);
    normalized.push(channel);
  }
  return normalized;
}

function normalizeSafetyLabels(value: unknown): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new XoreinControlError('invalid_response', 'xorein discovery response was incomplete.', 502);
  }
  const normalized: string[] = [];
  const seenLabels = new Set<string>();
  for (const label of value) {
    const normalizedLabel = optionalString(label);
    if (!normalizedLabel) {
      throw new XoreinControlError('invalid_response', 'xorein discovery response was incomplete.', 502);
    }
    if (seenLabels.has(normalizedLabel)) {
      continue;
    }
    seenLabels.add(normalizedLabel);
    normalized.push(normalizedLabel);
  }
  return normalized;
}

function normalizeServerPreview(raw: unknown): XoreinServerPreview {
  if (!isRecord(raw) || 'token' in raw) {
    throw new XoreinControlError('invalid_response', 'xorein discovery response was not valid.', 502);
  }
  const invite = isRecord(raw.invite) ? raw.invite : null;
  const manifest = isRecord(raw.manifest) ? raw.manifest : null;
  const inviteServerId = optionalString(invite?.server_id);
  const manifestServerId = optionalString(manifest?.server_id);
  const manifestName = optionalString(manifest?.name);
  const inviteExpiresAt = optionalString(invite?.expires_at);
  const inviteOwnerPeerId = optionalString(invite?.owner_peer_id);
  const manifestDescription = optionalString(manifest?.description);
  const manifestHistoryCoverage = optionalString(manifest?.history_coverage);
  const manifestSecurityMode = optionalString(manifest?.security_mode);
  const ownerRole = optionalString(raw.owner_role);
  const channels = raw.channels === undefined ? undefined : normalizeControlChannelRecords(raw.channels);
  const safetyLabels = raw.safety_labels === undefined ? undefined : normalizeSafetyLabels(raw.safety_labels);
  if (!invite || !manifest || !inviteServerId || !manifestServerId || !manifestName) {
    throw new XoreinControlError('invalid_response', 'xorein discovery response was incomplete.', 502);
  }
  if (inviteServerId !== manifestServerId) {
    throw new XoreinControlError('invalid_response', 'xorein discovery response server IDs did not match.', 502);
  }
  return {
    invite: {
      server_id: inviteServerId,
      ...(inviteExpiresAt ? { expires_at: inviteExpiresAt } : {}),
      ...(typeof invite.has_signature === 'boolean' ? { has_signature: invite.has_signature } : {}),
      ...(inviteOwnerPeerId ? { owner_peer_id: inviteOwnerPeerId } : {}),
    },
    manifest: {
      server_id: manifestServerId,
      name: manifestName,
      ...(manifestDescription ? { description: manifestDescription } : {}),
      ...(manifestHistoryCoverage ? { history_coverage: manifestHistoryCoverage } : {}),
      ...(manifestSecurityMode ? { security_mode: manifestSecurityMode } : {}),
    },
    ...(ownerRole ? { owner_role: ownerRole } : {}),
    ...(typeof raw.member_count === 'number' && Number.isFinite(raw.member_count) ? { member_count: raw.member_count } : {}),
    ...(channels !== undefined ? { channels } : {}),
    ...(safetyLabels !== undefined ? { safety_labels: safetyLabels } : {}),
  };
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return values
    .map((value) => value?.trim() ?? '')
    .filter((value, index, all) => value && all.indexOf(value) === index);
}

async function requestControlApi<T>(
  runtimeSnapshot: XoreinRuntimeSnapshot | null,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<T> {
  const endpoint = normalizeRuntimeEndpoint(runtimeSnapshot?.control_endpoint) || normalizeAuthRuntimeSettings(runtimeSnapshot?.settings)?.control_endpoint || '';
  if (!endpoint) {
    throw new XoreinControlError('runtime_unavailable', 'The local xorein control endpoint is unavailable.');
  }
  const endpointUrl = parseTrustedControlEndpoint(endpoint);
  if (!endpointUrl) {
    throw new XoreinControlError('invalid_endpoint', 'The local xorein control endpoint is invalid or untrusted.');
  }
  const normalizedPath = normalizeControlPath(path);

  // The control API is intentionally open: no bearer token is attached.
  if (shouldUseNativeControlBridge(endpoint)) {
    return requestNativeControlApi<T>(endpoint, method, normalizedPath, body);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(new URL(normalizedPath, endpointUrl), {
      method,
      signal: controller.signal,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      let parsed: ControlApiErrorShape | null = null;
      try {
        parsed = await response.json() as ControlApiErrorShape;
      } catch {
        if (controller.signal.aborted) {
          throw new XoreinControlError('transport_unavailable', 'xorein control request timed out.', 503);
        }
        parsed = null;
      }
      throw new XoreinControlError(
        parsed?.code?.trim() || `http_${response.status}`,
        parsed?.message?.trim() || response.statusText || 'xorein request failed',
        response.status,
      );
    }

    // A 204 response carries no body; calling response.json() on it throws, so
    // short-circuit for void endpoints (voice, peers, relays, friend removal).
    if (response.status === 204) {
      return undefined as T;
    }

    try {
      return ensureStructuredJsonResponse<T>(
        await response.json(),
        'xorein control response was not a structured JSON value.',
      );
    } catch (error) {
      if (controller.signal.aborted) {
        throw new XoreinControlError('transport_unavailable', 'xorein control request timed out.', 503);
      }
      throw new XoreinControlError(
        'invalid_response',
        error instanceof Error && error.message.trim() ? error.message.trim() : 'xorein control response was not valid JSON.',
        502,
      );
    }
  } catch (error) {
    if (error instanceof XoreinControlError) {
      throw error;
    }
    throw new XoreinControlError(
      'transport_unavailable',
      controller.signal.aborted
        ? 'xorein control request timed out.'
        : error instanceof Error && error.message.trim() ? error.message.trim() : 'Unable to reach xorein control endpoint.',
      503,
    );
  } finally {
    clearTimeout(timer);
  }
}

async function readNativeRuntimeConfig(): Promise<NativeRuntimeConfig> {
  try {
    return normalizeNativeRuntimeConfig(await invoke<unknown>('read_xorein_runtime_config'));
  } catch {
    return {};
  }
}

async function readNativeRuntimeStatus(): Promise<NativeRuntimeConfig> {
  try {
    return normalizeNativeRuntimeConfig(await invoke<unknown>('read_xorein_runtime_status'));
  } catch {
    return {};
  }
}

export async function readNativeRuntimeBootstrapStatus(): Promise<NativeRuntimeBootstrapStatus> {
  const config = await readNativeRuntimeStatus();
  return describeNativeRuntimeBootstrapStatus(config);
}

function normalizeNativeRuntimeConfig(value: unknown): NativeRuntimeConfig {
  if (!isRecord(value)) {
    return {};
  }

  const rawSidecar = isRecord(value.sidecar) ? value.sidecar : null;
  const sidecar = rawSidecar
    ? {
        ...(typeof rawSidecar.managed === 'boolean' ? { managed: rawSidecar.managed } : {}),
        ...(typeof rawSidecar.running === 'boolean' ? { running: rawSidecar.running } : {}),
        ...(typeof rawSidecar.pid === 'number' || rawSidecar.pid === null ? { pid: rawSidecar.pid as number | null } : {}),
        ...(typeof rawSidecar.data_dir === 'string' || rawSidecar.data_dir === null ? { data_dir: rawSidecar.data_dir as string | null } : {}),
        ...(typeof rawSidecar.control_endpoint === 'string' ? { control_endpoint: rawSidecar.control_endpoint } : {}),
        ...(typeof rawSidecar.last_error === 'string' || rawSidecar.last_error === null ? { last_error: rawSidecar.last_error as string | null } : {}),
      }
    : undefined;
  const settings = normalizeAuthRuntimeSettings(value.settings);

  return {
    ...(typeof value.control_endpoint === 'string' ? { control_endpoint: value.control_endpoint } : {}),
    ...(typeof value.control_ready === 'boolean' ? { control_ready: value.control_ready } : {}),
    ...(typeof value.data_dir === 'string' ? { data_dir: value.data_dir } : {}),
    ...(settings ? { settings } : {}),
    ...(sidecar ? { sidecar } : {}),
  };
}

async function requestNativeControlApi<T>(
  endpoint: string,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<T> {
  let response: NativeControlApiResponse;
  try {
    response = await invoke<NativeControlApiResponse>('request_xorein_control_api', {
      endpoint,
      method,
      path,
      body: body ?? null,
    });
  } catch (error) {
    throw new XoreinControlError(
      'transport_unavailable',
      error instanceof Error && error.message.trim() ? error.message.trim() : 'Unable to reach xorein control endpoint.',
      503,
    );
  }

  const status = typeof response.status === 'number' ? response.status : 502;
  if (status < 200 || status >= 300) {
    const parsed = isRecord(response.body) ? response.body as ControlApiErrorShape : null;
    if (status === 401) {
      clearControlTokenState();
    }
    throw new XoreinControlError(
      parsed?.code?.trim() || `http_${status}`,
      parsed?.message?.trim() || 'xorein request failed',
      status,
    );
  }
  if (status === 204) {
    return undefined as T;
  }
  return ensureStructuredJsonResponse<T>(
    response.body,
    'xorein control response was not a structured JSON value.',
  );
}

async function fetchControlState(endpointUrl: URL): Promise<ControlStateSnapshot> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_CONNECT_TIMEOUT_MS);
  try {
    const response = await fetch(new URL('/v1/state', endpointUrl), {
      signal: controller.signal,
      headers: {},
    });
    if (!response.ok) {
      throw new XoreinControlError('transport_unavailable', 'Unable to reach xorein control endpoint.', response.status);
    }
    return ensureStructuredJsonResponse<ControlStateSnapshot>(
      await response.json(),
      'xorein control response was not a structured JSON value.',
    );
  } catch (error) {
    if (error instanceof XoreinControlError) {
      throw error;
    }
    throw new XoreinControlError(
      'transport_unavailable',
      controller.signal.aborted
        ? 'xorein control request timed out.'
        : error instanceof Error && error.message.trim() ? error.message.trim() : 'Unable to reach xorein control endpoint.',
      503,
    );
  } finally {
    clearTimeout(timer);
  }
}

export async function consumePendingNativeDeepLinks(): Promise<string[]> {
  try {
    return normalizeStringArray(await invoke<unknown>('consume_pending_deeplink'));
  } catch {
    return [];
  }
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return uniqueStrings(
    value
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  );
}

async function waitForNativeRuntimeConfig(): Promise<NativeRuntimeConfig> {
  const initial = await readNativeRuntimeConfig();
  if (nativeRuntimeEndpointReady(initial) || !initial.sidecar?.running) {
    return initial;
  }

  const started = Date.now();
  let latest = initial;
  while (Date.now() - started < NATIVE_RUNTIME_READY_TIMEOUT_MS) {
    await sleep(NATIVE_RUNTIME_READY_POLL_MS);
    latest = await readNativeRuntimeStatus();
    if (nativeRuntimeEndpointReady(latest)) {
      return latest;
    }
    if (latest.sidecar && !latest.sidecar.running) {
      return latest;
    }
  }
  return latest;
}

function describeNativeRuntimeBootstrapStatus(config: NativeRuntimeConfig): NativeRuntimeBootstrapStatus {
  const endpoint = resolveNativeRuntimeEndpoint(config);
  const lastError = config.sidecar?.last_error?.trim() ?? '';
  const running = config.sidecar?.running === true;
  const managed = config.sidecar?.managed === true;

  if (nativeRuntimeEndpointReady(config)) {
    return {
      phase: 'ready',
      message: 'xorein runtime is ready.',
      detail: endpoint,
    };
  }

  if (lastError) {
    return {
      phase: 'failed',
      message: 'xorein could not start.',
      detail: lastError,
    };
  }

  if (running) {
    return {
      phase: 'waiting',
      message: managed
        ? 'xorein sidecar is running. Waiting for the control endpoint...'
        : 'An existing xorein runtime is running. Waiting for it to report readiness...',
      detail: endpoint || config.sidecar?.control_endpoint || config.data_dir || undefined,
    };
  }

  if (managed) {
    return {
      phase: 'connecting',
      message: 'Starting xorein sidecar...',
      detail: config.data_dir || undefined,
    };
  }

  return {
    phase: 'idle',
    message: 'Checking for a local xorein runtime...',
    detail: endpoint || config.data_dir || undefined,
  };
}

function nativeRuntimeEndpointReady(config: NativeRuntimeConfig): boolean {
  const endpoint = resolveNativeRuntimeEndpoint(config);
  return Boolean(endpoint && (config.control_ready === true || isDefaultPublicEndpoint(endpoint)));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function writeNativeRuntimeGlobals(config: NativeRuntimeConfig): void {
  if (typeof window === 'undefined') {
    return;
  }
  const windowRecord = window as unknown as Window & Record<string, unknown>;
  clearNativeRuntimeGlobals();
  const endpoint = resolveNativeRuntimeEndpoint(config);
  const ready = nativeRuntimeEndpointReady(config);
  if (endpoint && ready) {
    windowRecord[CONTROL_ENDPOINT_GLOBAL_KEYS[0]] = endpoint;
  }
  for (const key of CONTROL_READY_GLOBAL_KEYS) {
    windowRecord[key] = ready;
  }
}

function shouldUseNativeControlBridge(endpoint: string): boolean {
  const parsed = parseControlEndpoint(endpoint);
  if (!parsed || !isLocalControlOrigin(parsed)) {
    return false;
  }
  const preferredEndpoint = readPreferredControlEndpoint();
  const preferredUrl = parseControlEndpoint(preferredEndpoint);
  if (preferredUrl && preferredUrl.origin === parsed.origin) {
    return true;
  }
  const nativeEndpoint = readNativeRuntimeEndpoint();
  return readControlBridgeReady() && !!nativeEndpoint && parseControlEndpoint(nativeEndpoint)?.origin === parsed.origin;
}

function readNativeRuntimeEndpoint(): string {
  if (typeof window === 'undefined') {
    return '';
  }
  const windowRecord = window as unknown as Window & Record<string, unknown>;
  for (const key of CONTROL_ENDPOINT_GLOBAL_KEYS) {
    const value = windowRecord[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return '';
}

function resolveNativeRuntimeEndpoint(config: NativeRuntimeConfig): string {
  return normalizeRuntimeEndpoint(config.control_endpoint)
    || normalizeRuntimeEndpoint(config.sidecar?.control_endpoint)
    || normalizeAuthRuntimeSettings(config.settings)?.control_endpoint
    || '';
}

function clearNativeRuntimeGlobals(): void {
  if (typeof window === 'undefined') {
    return;
  }
  const windowRecord = window as unknown as Window & Record<string, unknown>;
  for (const key of CONTROL_ENDPOINT_GLOBAL_KEYS) {
    delete windowRecord[key];
  }
  for (const key of CONTROL_READY_GLOBAL_KEYS) {
    delete windowRecord[key];
  }
  for (const key of CONTROL_GLOBAL_KEYS) {
    delete windowRecord[key];
  }
}

function clearControlTokenState(): void {
  if (typeof window === 'undefined') {
    return;
  }
  const windowRecord = window as unknown as Window & Record<string, unknown>;
  for (const key of CONTROL_GLOBAL_KEYS) {
    delete windowRecord[key];
  }
  for (const key of CONTROL_STORAGE_KEYS) {
    safeStorageRemove(() => window.localStorage, key);
    safeStorageRemove(() => window.sessionStorage, key);
  }
}

function readControlToken(): string {
  if (typeof window === 'undefined') {
    return '';
  }

  const windowRecord = window as unknown as Window & Record<string, unknown>;
  for (const key of CONTROL_GLOBAL_KEYS) {
    const value = windowRecord[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  return '';
}

function readControlBridgeReady(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  const windowRecord = window as unknown as Window & Record<string, unknown>;
  return CONTROL_READY_GLOBAL_KEYS.some((key) => windowRecord[key] === true);
}

// ─── Audit Log ─────────────────────────────────────────────
export interface XoreinAuditEntry {
  id: string;
  server_id: string;
  action: string;
  actor_peer_id: string;
  target?: string;
  detail?: string;
  created_at: string;
}

function normalizeAuditEntry(v: unknown): XoreinAuditEntry | null {
  if (typeof v !== 'object' || v === null) return null;
  const r = v as Record<string, unknown>;
  const id = typeof r.id === 'string' ? r.id : '';
  if (!id) return null;
  return {
    id,
    server_id: typeof r.server_id === 'string' ? r.server_id : '',
    action: typeof r.action === 'string' ? r.action : '',
    actor_peer_id: typeof r.actor_peer_id === 'string' ? r.actor_peer_id : '',
    target: typeof r.target === 'string' ? r.target : undefined,
    detail: typeof r.detail === 'string' ? r.detail : undefined,
    created_at: typeof r.created_at === 'string' ? r.created_at : new Date().toISOString(),
  };
}

export async function listAuditLog(
  runtimeSnapshot: XoreinRuntimeSnapshot | null,
  serverId: string,
  options?: { action?: string; limit?: number },
): Promise<XoreinAuditEntry[]> {
  const sid = controlPathSegment(serverId, 'Server ID');
  const params = new URLSearchParams();
  if (options?.action && options.action !== 'all') params.set('action', options.action);
  if (options?.limit) params.set('limit', String(options.limit));
  const qs = params.toString() ? `?${params.toString()}` : '';
  const result = await requestControlApi<unknown>(runtimeSnapshot, 'GET', `/v1/servers/${sid}/audit${qs}`);
  if (typeof result === 'object' && result !== null && Array.isArray((result as Record<string, unknown>).entries)) {
    return ((result as Record<string, unknown>).entries as unknown[]).flatMap((e) => {
      const entry = normalizeAuditEntry(e);
      return entry ? [entry] : [];
    });
  }
  return [];
}

// ─── AutoMod Rules ─────────────────────────────────────────
export type AutoModRuleType = 'keyword' | 'spam' | 'link' | 'invite' | 'mention';
export type AutoModAction = 'block' | 'delete' | 'timeout' | 'alert';

export interface XoreinAutoModRule {
  id: string;
  server_id: string;
  name: string;
  type: AutoModRuleType;
  enabled: boolean;
  keyword_patterns?: string[];
  actions: AutoModAction[];
  created_at: string;
}

function normalizeAutoModRule(v: unknown): XoreinAutoModRule | null {
  if (typeof v !== 'object' || v === null) return null;
  const r = v as Record<string, unknown>;
  const id = typeof r.id === 'string' ? r.id : '';
  if (!id) return null;
  return {
    id,
    server_id: typeof r.server_id === 'string' ? r.server_id : '',
    name: typeof r.name === 'string' ? r.name : '',
    type: (typeof r.type === 'string' ? r.type : 'keyword') as AutoModRuleType,
    enabled: r.enabled === true,
    keyword_patterns: Array.isArray(r.keyword_patterns)
      ? (r.keyword_patterns as unknown[]).filter((x): x is string => typeof x === 'string')
      : undefined,
    actions: Array.isArray(r.actions)
      ? (r.actions as unknown[]).filter((x): x is AutoModAction => typeof x === 'string')
      : ['block'],
    created_at: typeof r.created_at === 'string' ? r.created_at : new Date().toISOString(),
  };
}

export async function listAutoModRules(
  runtimeSnapshot: XoreinRuntimeSnapshot | null,
  serverId: string,
): Promise<XoreinAutoModRule[]> {
  const result = await requestControlApi<unknown>(
    runtimeSnapshot, 'GET', `/v1/servers/${controlPathSegment(serverId, 'Server ID')}/automod/rules`,
  );
  if (typeof result === 'object' && result !== null && Array.isArray((result as Record<string, unknown>).rules)) {
    return ((result as Record<string, unknown>).rules as unknown[]).flatMap((r) => {
      const rule = normalizeAutoModRule(r);
      return rule ? [rule] : [];
    });
  }
  return [];
}

export async function createAutoModRule(
  runtimeSnapshot: XoreinRuntimeSnapshot | null,
  serverId: string,
  input: { name: string; type: AutoModRuleType; enabled: boolean; keyword_patterns?: string[]; actions: AutoModAction[] },
): Promise<XoreinAutoModRule> {
  const result = await requestControlApi<unknown>(
    runtimeSnapshot, 'POST', `/v1/servers/${controlPathSegment(serverId, 'Server ID')}/automod/rules`, input,
  );
  const rule = normalizeAutoModRule(result);
  if (!rule) throw new Error('Invalid automod rule response');
  return rule;
}

export async function updateAutoModRule(
  runtimeSnapshot: XoreinRuntimeSnapshot | null,
  serverId: string,
  ruleId: string,
  patch: { name?: string; enabled?: boolean; keyword_patterns?: string[]; actions?: AutoModAction[] },
): Promise<void> {
  await requestControlApi<void>(
    runtimeSnapshot, 'PATCH',
    `/v1/servers/${controlPathSegment(serverId, 'Server ID')}/automod/rules/${controlPathSegment(ruleId, 'Rule ID')}`,
    patch,
  );
}

export async function deleteAutoModRule(
  runtimeSnapshot: XoreinRuntimeSnapshot | null,
  serverId: string,
  ruleId: string,
): Promise<void> {
  await requestControlApi<void>(
    runtimeSnapshot, 'DELETE',
    `/v1/servers/${controlPathSegment(serverId, 'Server ID')}/automod/rules/${controlPathSegment(ruleId, 'Rule ID')}`,
  );
}

// ─── Bots ───────────────────────────────────────────────────
export interface XoreinBotRecord {
  id: string;
  server_id: string;
  name: string;
  avatar_url?: string;
  token?: string;
  created_at: string;
}

function normalizeBotRecord(v: unknown): XoreinBotRecord | null {
  if (typeof v !== 'object' || v === null) return null;
  const r = v as Record<string, unknown>;
  const id = typeof r.id === 'string' ? r.id : '';
  if (!id) return null;
  return {
    id,
    server_id: typeof r.server_id === 'string' ? r.server_id : '',
    name: typeof r.name === 'string' ? r.name : '',
    avatar_url: typeof r.avatar_url === 'string' ? r.avatar_url : undefined,
    token: typeof r.token === 'string' && r.token ? r.token : undefined,
    created_at: typeof r.created_at === 'string' ? r.created_at : new Date().toISOString(),
  };
}

export async function listBots(
  runtimeSnapshot: XoreinRuntimeSnapshot | null,
  serverId: string,
): Promise<XoreinBotRecord[]> {
  const result = await requestControlApi<unknown>(
    runtimeSnapshot, 'GET', `/v1/servers/${controlPathSegment(serverId, 'Server ID')}/bots`,
  );
  if (typeof result === 'object' && result !== null && Array.isArray((result as Record<string, unknown>).bots)) {
    return ((result as Record<string, unknown>).bots as unknown[]).flatMap((b) => {
      const bot = normalizeBotRecord(b);
      return bot ? [bot] : [];
    });
  }
  return [];
}

export async function createBot(
  runtimeSnapshot: XoreinRuntimeSnapshot | null,
  serverId: string,
  name: string,
): Promise<XoreinBotRecord> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('Bot name is required');
  const result = await requestControlApi<unknown>(
    runtimeSnapshot, 'POST', `/v1/servers/${controlPathSegment(serverId, 'Server ID')}/bots`,
    { name: trimmed },
  );
  const bot = normalizeBotRecord(result);
  if (!bot) throw new Error('Invalid bot creation response');
  return bot;
}

export async function deleteBot(
  runtimeSnapshot: XoreinRuntimeSnapshot | null,
  serverId: string,
  botId: string,
): Promise<void> {
  await requestControlApi<void>(
    runtimeSnapshot, 'DELETE',
    `/v1/servers/${controlPathSegment(serverId, 'Server ID')}/bots/${controlPathSegment(botId, 'Bot ID')}`,
  );
}
