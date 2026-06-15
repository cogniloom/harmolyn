import { FEATURES } from "../config/featureFlags.js";
import {
  validFeatureFlagName,
  negotiateCapabilities,
  negotiateConversationSecurityMode,
  type CapabilityNegotiationResult,
  type FeatureFlag,
  type SecurityMode,
} from "./capabilities.js";
import { computeReconnectDelay, type BackoffPolicy } from "./backoff.js";
import { parseJoinDeepLink } from "./deeplink.js";
import { parseAbsoluteUrl } from "./url.js";
import {
  cloneManifest,
  MANIFEST_VERSION_V1,
  type Manifest,
  type Sha256Digest,
  validateManifestFreshness,
  validateStoredSignature,
} from "./manifest.js";
import {
  buildFeatureProtocolContract,
  deriveLocalCapabilities,
  type FeatureProtocolContract,
  type FeatureToggleSet,
} from "./featureBridge.js";
import { parseProtocolId, stringifyProtocolId, type ProtocolId } from "./protocolId.js";
import { safeStorageGet, safeStorageSet } from "../lib/browserStorage.js";
import { normalizeRuntimeEndpoint, normalizeRuntimeIdentity, normalizeRuntimeSettings } from "../lib/authPreview.js";
import type { Message } from "../types.js";

export interface XoreinHandshakeRequest {
  serverId: string;
  localCapabilities: FeatureFlag[];
  preferredSecurityModes: SecurityMode[];
  protocolOffers: string[];
}

export interface XoreinHandshakeResponse {
  manifest: Manifest;
  advertisedCapabilities?: string[];
  requiredCapabilities?: string[];
  offeredSecurityModes?: SecurityMode[];
  acceptedProtocol?: string;
}

export interface XoreinTransport {
  connect(): Promise<void>;
  disconnect(reason?: string): Promise<void>;
  performHandshake(request: XoreinHandshakeRequest): Promise<XoreinHandshakeResponse>;
  joinByLink?(rawLink: string, request: XoreinHandshakeRequest): Promise<XoreinHandshakeResponse>;
}

export interface XoreinSession {
  serverId: string;
  manifest: Manifest;
  securityMode: SecurityMode;
  acceptedProtocol: ProtocolId | null;
  capabilityNegotiation: CapabilityNegotiationResult;
  featureContract: FeatureProtocolContract;
  connectedAtMs: number;
  reconnectAttempts: number;
}

export type XoreinConnectionLifecycleState = "connected" | "disconnected" | "reconnecting" | "no-peer" | "no-relay";

export interface XoreinConnectionSnapshot {
  state: XoreinConnectionLifecycleState;
  detail: string;
  serverId: string | null;
  reconnectAttempts: number;
  updatedAtMs: number;
  session: XoreinSession | null;
}

export interface XoreinClientOptions {
  transport: XoreinTransport;
  features?: FeatureToggleSet;
  preferredSecurityModes?: readonly SecurityMode[];
  protocolOffers?: readonly ProtocolId[];
  maxManifestAgeMs?: number;
  backoff?: Partial<BackoffPolicy>;
  digest?: Sha256Digest;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export class XoreinConnectionError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "XoreinConnectionError";
    this.code = code;
  }
}

function ensureStructuredJsonResponse<T>(value: unknown, message: string): T {
  if (!isPlainObject(value)) {
    throw new XoreinConnectionError("invalid_response", message);
  }
  return value as T;
}

export interface XoreinControlTransportOptions {
  endpoint: string;
  token: string;
  fetch?: typeof globalThis.fetch;
}

export interface PersistedChatScopeState {
  version: 1;
  nickname: string;
  mutedUserIds: string[];
  inboxReadIds: string[];
  deletedMessageIds: string[];
  messages: Message[];
  threads: Record<string, Message[]>;
}

export interface BrowserChatActionSupport {
  mode: "connected" | "offline";
  canPersistLocally: boolean;
  canAttemptAttachments: boolean;
  detail: string;
}

// "clear" is intentionally excluded: Harmolyn never prefers or accepts an
// unencrypted conversation. If a peer can only offer "clear", negotiation fails
// closed (security_mode_incompatible) rather than silently dropping to plaintext.
const DEFAULT_PREFERRED_SECURITY_MODES: readonly SecurityMode[] = ["seal", "tree"];

// Encrypted modes the control bridge is allowed to surface as an offer. "clear"
// is never in this set, so the bridge can never negotiate an unencrypted session.
const ENCRYPTED_SECURITY_MODES: ReadonlySet<SecurityMode> = new Set(["seal", "tree"]);

/**
 * Maps a runtime-declared manifest security mode to the set of modes the bridge
 * offers. Only encrypted modes are ever offered; anything else (including
 * "clear", "unspecified", or an unknown/absent value) yields no offer so the
 * handshake fails closed instead of accepting plaintext.
 */
function encryptedOfferFromManifest(manifest: XoreinControlManifest): SecurityMode[] {
  const declared = (manifest.security_mode ?? "").trim().toLowerCase() as SecurityMode;
  return ENCRYPTED_SECURITY_MODES.has(declared) ? [declared] : [];
}
const DEFAULT_PROTOCOL_OFFERS: readonly ProtocolId[] = [
  { family: "chat", version: { major: 0, minor: 1 }, name: "chat/0.1" },
  { family: "voice", version: { major: 0, minor: 1 }, name: "voice/0.1" },
  { family: "manifest", version: { major: 0, minor: 1 }, name: "manifest/0.1" },
  { family: "identity", version: { major: 0, minor: 1 }, name: "identity/0.1" },
  { family: "dm", version: { major: 0, minor: 2 }, name: "dm/0.2" },
  { family: "friends", version: { major: 0, minor: 2 }, name: "friends/0.2" },
  { family: "presence", version: { major: 0, minor: 2 }, name: "presence/0.2" },
  { family: "notify", version: { major: 0, minor: 2 }, name: "notify/0.2" },
];

const CHAT_SCOPE_STATE_STORAGE_PREFIX = "harmolyn:xorein:chat-scope:";
const CONTROL_READY_GLOBAL_KEYS = [
  "__HARMOLYN_XOREIN_CONTROL_READY__",
  "__HARMOLYN_CONTROL_READY__",
] as const;
const RUNTIME_GLOBAL_KEYS = [
  "__HARMOLYN_XOREIN_RUNTIME__",
  "__HARMOLYN_RUNTIME_SNAPSHOT__",
  "__XOREIN_RUNTIME_SNAPSHOT__",
] as const;
const RUNTIME_STORAGE_KEYS = [
  "harmolyn:xorein:runtime",
  "harmolyn:runtime-snapshot",
  "xorein:runtime-snapshot",
] as const;

const PROTOCOL_CAPABILITY_REQUIREMENTS: Readonly<Record<string, FeatureFlag>> = {
  chat: "cap.chat",
  voice: "cap.voice",
  manifest: "cap.manifest",
  identity: "cap.identity",
  dm: "cap.dm",
  friends: "cap.friends",
  presence: "cap.presence",
  notify: "cap.notify",
};

interface XoreinControlStateResponse {
  servers: XoreinControlServerRecord[];
}

interface XoreinControlApiError {
  code?: string;
  message?: string;
}

interface XoreinControlServerRecord {
  id: string;
  name: string;
  description?: string;
  manifest: XoreinControlManifest;
}

interface XoreinControlManifest {
  server_id: string;
  name: string;
  description?: string;
  owner_peer_id: string;
  owner_public_key: string;
  owner_addresses: string[];
  bootstrap_addrs?: string[];
  relay_addrs?: string[];
  capabilities: string[];
  history_retention_messages?: number;
  history_coverage?: string;
  history_durability?: string;
  issued_at: string;
  updated_at: string;
  expires_at?: string;
  security_mode?: string;
  signature: string;
}

function parseHttpEndpoint(raw: string): URL | null {
  const parsed = parseAbsoluteUrl(raw);
  if (!parsed) {
    return null;
  }

  const protocol = parsed.protocol.toLowerCase();
  if (protocol !== "http:" && protocol !== "https:") {
    return null;
  }

  return parsed;
}

function parseTrustedLocalControlEndpoint(raw: string): URL | null {
  const parsed = parseHttpEndpoint(raw);
  if (!parsed) {
    return null;
  }
  return isLocalControlOrigin(parsed) ? parsed : null;
}

function isLocalControlOrigin(endpointUrl: URL): boolean {
  const host = endpointUrl.hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  return host === "localhost"
    || host === "tauri.localhost"
    || host === "::1"
    || host === "0:0:0:0:0:0:0:1"
    || /^127(?:\.\d{1,3}){3}$/.test(host);
}

function normalizeJoinLink(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("empty deeplink");
  }

  const parsed = parseJoinDeepLink(trimmed);
  if (!parsed.invite) {
    throw new Error("signed invite is required for join discovery and remote joins");
  }

  return trimmed;
}

export class XoreinControlTransport implements XoreinTransport {
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly endpointUrl: URL;

  constructor(private readonly options: XoreinControlTransportOptions) {
    const fetchImpl = options.fetch ?? globalThis.fetch;
    if (!fetchImpl) {
      throw new XoreinConnectionError("fetch_unavailable", "fetch unavailable for xorein control transport");
    }
    const endpointUrl = parseTrustedLocalControlEndpoint(options.endpoint);
    if (!endpointUrl) {
      throw new XoreinConnectionError("invalid_endpoint", "invalid or untrusted xorein control transport endpoint");
    }
    this.fetchImpl = fetchImpl;
    this.endpointUrl = endpointUrl;
  }

  async connect(): Promise<void> {
    normalizeControlStateResponse(await this.request<unknown>("GET", "/v1/state"));
  }

  async disconnect(): Promise<void> {
    // The local control bridge is stateless; disconnect only clears caller state.
  }

  async performHandshake(request: XoreinHandshakeRequest): Promise<XoreinHandshakeResponse> {
    const state = normalizeControlStateResponse(await this.request<unknown>("GET", "/v1/state"));
    const server = state.servers.find((candidate) => candidate.id === request.serverId);
    if (!server) {
      throw new XoreinConnectionError("server_not_found", `server not found in local runtime: ${request.serverId}`);
    }
    return handshakeResponseFromServerRecord(server, request);
  }

  async joinByLink(rawLink: string, request: XoreinHandshakeRequest): Promise<XoreinHandshakeResponse> {
    const deeplink = normalizeJoinLink(rawLink);
    const server = normalizeControlServerRecord(await this.request<unknown>("POST", "/v1/servers/join", { deeplink }));
    return handshakeResponseFromServerRecord(server, request);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(new URL(path, this.endpointUrl), {
        method,
        headers: {
          Authorization: `Bearer ${this.options.token}`,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (error) {
      const message = error instanceof Error && error.message.trim() ? error.message.trim() : "xorein control transport unreachable";
      throw new XoreinConnectionError("control_transport_unreachable", message);
    }

    if (!response.ok) {
      let parsedError: XoreinControlApiError | undefined;
      try {
        parsedError = await response.json() as XoreinControlApiError;
      } catch {
        parsedError = undefined;
      }
      const code = parsedError?.code?.trim() || `http-${response.status}`;
      const message = parsedError?.message?.trim() || response.statusText || "request failed";
      throw new XoreinConnectionError(code, `xorein ${code}: ${message}`);
    }

    return ensureStructuredJsonResponse<T>(
      await response.json(),
      "xorein control transport response was not a structured JSON value",
    );
  }
}

export function readPersistedChatScopeState(scopeId: string): PersistedChatScopeState {
  if (typeof window === "undefined" || !scopeId.trim()) {
    return createEmptyPersistedChatScopeState();
  }

  const raw = safeStorageGet(() => window.localStorage, buildChatScopeStorageKey(scopeId));
  if (!raw) {
    return createEmptyPersistedChatScopeState();
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isPlainObject(parsed)) {
      return createEmptyPersistedChatScopeState();
    }
    const state = parsed as Partial<PersistedChatScopeState>;
    return {
      version: 1,
      nickname: typeof state.nickname === "string" ? state.nickname.trim() : "",
      mutedUserIds: normalizeStoredStringList(state.mutedUserIds),
      inboxReadIds: normalizeStoredStringList(state.inboxReadIds),
      deletedMessageIds: normalizeStoredStringList(state.deletedMessageIds),
      messages: normalizeStoredMessages(state.messages),
      threads: normalizeStoredThreads(state.threads),
    };
  } catch {
    return createEmptyPersistedChatScopeState();
  }
}

export function writePersistedChatScopeState(scopeId: string, state: PersistedChatScopeState): void {
  if (typeof window === "undefined" || !scopeId.trim()) {
    return;
  }

  const nickname = typeof state.nickname === "string" ? state.nickname.trim() : "";
  safeStorageSet(() => window.localStorage, buildChatScopeStorageKey(scopeId), JSON.stringify({
    version: 1,
      nickname,
      mutedUserIds: normalizeStoredStringList(state.mutedUserIds).sort(),
      inboxReadIds: normalizeStoredStringList(state.inboxReadIds).sort(),
      deletedMessageIds: normalizeStoredStringList(state.deletedMessageIds).sort(),
      messages: normalizeStoredMessages(state.messages),
      threads: normalizeStoredThreads(state.threads),
    } satisfies PersistedChatScopeState));
}

export function readBrowserChatActionSupport(): BrowserChatActionSupport {
  if (typeof window === "undefined") {
    return {
      mode: "offline",
      canPersistLocally: false,
      canAttemptAttachments: false,
      detail: "Chat actions require a browser session.",
    };
  }

  const runtime = readBrowserRuntimeSnapshot();
  const peerId = normalizeRuntimeIdentity(runtime?.identity)?.peer_id ?? "";
  const endpoint = normalizeRuntimeEndpoint(runtime?.control_endpoint) || normalizeRuntimeSettings(runtime?.settings)?.control_endpoint || "";

  // For local endpoints the native control bridge must be ready.
  // For remote HTTP/HTTPS endpoints (e.g. the public hosted node), having a
  // valid peer ID and a parseable endpoint is sufficient — mutations go via
  // requestControlApi which supports remote endpoints via CORS + origin auth.
  const isLocal = Boolean(parseTrustedLocalControlEndpoint(endpoint));
  const isRemote = !isLocal && Boolean(endpoint && parseHttpEndpoint(endpoint));
  const runtimeReady = Boolean(peerId && ((isLocal && readBrowserControlBridgeReady()) || isRemote));

  if (!runtimeReady) {
    return {
      mode: "offline",
      canPersistLocally: false,
      canAttemptAttachments: false,
      detail: "The local xorein runtime is offline. Start or reconnect the node before sending chat messages.",
    };
  }

  return {
    mode: "connected",
    canPersistLocally: true,
    canAttemptAttachments: true,
    detail: isLocal
      ? "Backend connected — chat mutations are sent to the local xorein runtime."
      : "Backend connected — chat mutations are sent to the remote xorein node.",
  };
}

export class XoreinClient {
  private readonly features: FeatureToggleSet;
  private readonly preferredSecurityModes: readonly SecurityMode[];
  private readonly protocolOffers: readonly ProtocolId[];
  private readonly maxManifestAgeMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  private lastServerId: string | null = null;
  private currentSession: XoreinSession | null = null;
  private reconnectAttempts = 0;
  private healPromise: Promise<XoreinSession> | null = null;
  private readonly connectionListeners = new Set<(snapshot: XoreinConnectionSnapshot) => void>();
  private connectionSnapshot: XoreinConnectionSnapshot;

  constructor(private readonly options: XoreinClientOptions) {
    this.features = options.features ?? FEATURES;
    this.preferredSecurityModes = options.preferredSecurityModes ?? DEFAULT_PREFERRED_SECURITY_MODES;
    this.protocolOffers = options.protocolOffers ?? DEFAULT_PROTOCOL_OFFERS;
    this.maxManifestAgeMs = Math.max(0, options.maxManifestAgeMs ?? 5 * 60_000);
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? (() => Date.now());
    this.connectionSnapshot = this.buildConnectionSnapshot("disconnected", "Not connected to a xorein server.");
  }

  snapshot(): XoreinSession | null {
    return cloneSession(this.currentSession);
  }

  connection(): XoreinConnectionSnapshot {
    return cloneConnectionSnapshot(this.connectionSnapshot);
  }

  subscribe(listener: (snapshot: XoreinConnectionSnapshot) => void): () => void {
    this.connectionListeners.add(listener);
    listener(this.connection());
    return () => {
      this.connectionListeners.delete(listener);
    };
  }

  async connectByLink(rawLink: string): Promise<XoreinSession> {
    const deeplink = normalizeJoinLink(rawLink);
    const { serverId } = parseJoinDeepLink(deeplink);
    return this.establishSession(serverId, (request) =>
      this.options.transport.joinByLink
        ? this.options.transport.joinByLink(deeplink, request)
        : this.options.transport.performHandshake(request));
  }

  async connectToServer(serverId: string): Promise<XoreinSession> {
    return this.establishSession(serverId, (request) => this.options.transport.performHandshake(request));
  }

  private async establishSession(
    serverId: string,
    resolveHandshake: (request: XoreinHandshakeRequest) => Promise<XoreinHandshakeResponse>,
  ): Promise<XoreinSession> {
    const localCapabilities = deriveLocalCapabilities(this.features);
    const protocolOffers = this.protocolOffers.map((offer) => stringifyProtocolId(offer));
    this.lastServerId = serverId;

    this.updateConnection(this.reconnectAttempts > 0 ? "reconnecting" : "disconnected", `Connecting to ${serverId}...`);

    try {
      await this.options.transport.connect();
      const response = await resolveHandshake({
        serverId,
        localCapabilities,
        preferredSecurityModes: [...this.preferredSecurityModes],
        protocolOffers,
      });

      if (!response.manifest) {
        throw new XoreinConnectionError("manifest_invalid", "manifest required from handshake response");
      }

      if (response.manifest.serverId !== serverId) {
        throw new XoreinConnectionError("manifest_mismatch", "manifest server mismatch");
      }
      await validateStoredSignature(response.manifest, this.options.digest);
      validateManifestFreshness(response.manifest, new Date(this.now()), this.maxManifestAgeMs);

      const capabilityNegotiation = negotiateCapabilities(
        localCapabilities,
        response.advertisedCapabilities ?? [],
        response.requiredCapabilities ?? [],
      );
      if (capabilityNegotiation.missingRequired.length > 0) {
        throw new XoreinConnectionError("capabilities_unsupported", `required capabilities unsupported: ${capabilityNegotiation.missingRequired.join(", ")}`);
      }

      const securityResult = negotiateConversationSecurityMode(
        this.preferredSecurityModes,
        response.offeredSecurityModes ?? [],
      );
      if (securityResult.reason !== "matched") {
        throw new XoreinConnectionError("security_mode_incompatible", `security mode negotiation failed: ${securityResult.reason}`);
      }

      let acceptedProtocol: ProtocolId | null = null;
      if (response.acceptedProtocol) {
        try {
          acceptedProtocol = parseProtocolId(response.acceptedProtocol);
        } catch {
          throw new XoreinConnectionError("protocol_invalid", `invalid accepted protocol: ${response.acceptedProtocol}`);
        }
        if (!protocolOffers.includes(response.acceptedProtocol)) {
          throw new XoreinConnectionError("protocol_unoffered", "accepted protocol was not offered locally");
        }
      }

      const featureContract = buildFeatureProtocolContract(capabilityNegotiation, this.features);
      const attemptCount = this.reconnectAttempts;
      const session: XoreinSession = {
        serverId,
        manifest: cloneManifest(response.manifest),
        securityMode: securityResult.mode,
        acceptedProtocol,
        capabilityNegotiation: cloneCapabilityNegotiation(capabilityNegotiation),
        featureContract: cloneFeatureContract(featureContract),
        connectedAtMs: this.now(),
        reconnectAttempts: attemptCount,
      };

      this.currentSession = session;
      this.reconnectAttempts = 0;
      this.updateConnection("connected", `Connected to ${session.manifest.name || serverId}.`);
      return cloneSession(session)!;
    } catch (error) {
      this.currentSession = null;
      this.updateConnection(mapConnectionFailure(error), describeConnectionFailure(error));
      await safeDisconnect(this.options.transport, "handshake-failed");
      throw error;
    }
  }

  async selfHeal(): Promise<XoreinSession> {
    if (!this.lastServerId) {
      throw new XoreinConnectionError("no_previous_server", "no previous server to reconnect to");
    }
    if (this.healPromise) {
      return this.healPromise;
    }

    const attempt = ++this.reconnectAttempts;
    const delayMs = computeReconnectDelay(attempt, this.options.backoff);
    this.updateConnection("reconnecting", `Reconnect attempt ${attempt} scheduled in ${delayMs}ms.`);

    this.healPromise = (async () => {
      await this.sleep(delayMs);
      try {
        return await this.connectToServer(this.lastServerId!);
      } finally {
        this.healPromise = null;
      }
    })();

    return this.healPromise;
  }

  async disconnect(reason = "client-disconnect"): Promise<void> {
    this.currentSession = null;
    this.healPromise = null;
    this.reconnectAttempts = 0;
    this.updateConnection("disconnected", reason === "client-disconnect" ? "Disconnected from xorein." : reason);
    await safeDisconnect(this.options.transport, reason);
  }

  private buildConnectionSnapshot(state: XoreinConnectionLifecycleState, detail: string): XoreinConnectionSnapshot {
    return {
      state,
      detail,
      serverId: this.lastServerId,
      reconnectAttempts: this.reconnectAttempts,
      updatedAtMs: this.now(),
      session: cloneSession(this.currentSession),
    };
  }

  private updateConnection(state: XoreinConnectionLifecycleState, detail: string): void {
    this.connectionSnapshot = this.buildConnectionSnapshot(state, detail);
    for (const listener of this.connectionListeners) {
      listener(this.connection());
    }
  }
}

function handshakeResponseFromServerRecord(
  server: XoreinControlServerRecord,
  request: XoreinHandshakeRequest,
): XoreinHandshakeResponse {
  if (!server?.manifest) {
    throw new XoreinConnectionError("manifest_invalid", "manifest required from xorein bridge");
  }

  const advertisedCapabilities = normalizeManifestCapabilities(server.manifest.capabilities);
  return {
    manifest: {
      serverId: server.manifest.server_id,
      identity: server.manifest.owner_peer_id,
      version: MANIFEST_VERSION_V1,
      name: server.manifest.name,
      description: server.manifest.description ?? server.description ?? "",
      ownerPeerId: server.manifest.owner_peer_id,
      ownerPublicKey: server.manifest.owner_public_key,
      ownerAddresses: [...(server.manifest.owner_addresses ?? [])],
      bootstrapAddrs: [...(server.manifest.bootstrap_addrs ?? [])],
      relayAddrs: [...(server.manifest.relay_addrs ?? [])],
      updatedAt: server.manifest.updated_at,
      issuedAt: server.manifest.issued_at,
      expiresAt: server.manifest.expires_at,
      historyRetentionMessages: server.manifest.history_retention_messages,
      historyCoverage: server.manifest.history_coverage,
      historyDurability: server.manifest.history_durability,
      capabilities: advertisedCapabilities,
      signature: server.manifest.signature,
    },
    advertisedCapabilities,
    requiredCapabilities: [],
    offeredSecurityModes: encryptedOfferFromManifest(server.manifest),
    acceptedProtocol: selectAcceptedProtocol(request.protocolOffers, advertisedCapabilities),
  };
}

function normalizeControlStateResponse(value: unknown): XoreinControlStateResponse {
  if (!isPlainObject(value)) {
    throw new XoreinConnectionError("manifest_invalid", "xorein control state was incomplete");
  }
  if (!Array.isArray(value.servers)) {
    throw new XoreinConnectionError("manifest_invalid", "xorein control state was incomplete");
  }
  return {
    servers: value.servers.map(normalizeControlServerRecord),
  };
}

function normalizeControlServerRecord(value: unknown): XoreinControlServerRecord {
  if (!isPlainObject(value)) {
    throw new XoreinConnectionError("manifest_invalid", "xorein control state was incomplete");
  }
  const id = optionalString(value.id);
  const name = optionalString(value.name);
  const description = optionalString(value.description);
  const manifest = normalizeControlManifest(value.manifest);
  if (!id || !name || !manifest) {
    throw new XoreinConnectionError("manifest_invalid", "xorein control state was incomplete");
  }
  return {
    id,
    name,
    ...(description ? { description } : {}),
    manifest,
  };
}

function normalizeControlManifest(value: unknown): XoreinControlManifest {
  if (!isPlainObject(value)) {
    throw new XoreinConnectionError("manifest_invalid", "xorein manifest was incomplete");
  }

  const serverId = optionalString(value.server_id);
  const name = optionalString(value.name);
  const description = optionalString(value.description);
  const ownerPeerId = optionalString(value.owner_peer_id);
  const ownerPublicKey = optionalString(value.owner_public_key);
  const ownerAddresses = normalizeManifestStringArray(value.owner_addresses, "owner_addresses", true);
  const bootstrapAddrs = normalizeManifestStringArray(value.bootstrap_addrs, "bootstrap_addrs");
  const relayAddrs = normalizeManifestStringArray(value.relay_addrs, "relay_addrs");
  const capabilities = normalizeManifestStringArray(value.capabilities, "capabilities", true);
  const historyRetentionMessages = value.history_retention_messages;
  const historyCoverage = optionalString(value.history_coverage);
  const historyDurability = optionalString(value.history_durability);
  const issuedAt = optionalString(value.issued_at);
  const updatedAt = optionalString(value.updated_at);
  const expiresAt = optionalString(value.expires_at);
  const securityMode = optionalString(value.security_mode);
  const signature = optionalString(value.signature);

  if (!serverId || !name || !ownerPeerId || !ownerPublicKey || !issuedAt || !updatedAt || !signature) {
    throw new XoreinConnectionError("manifest_invalid", "xorein manifest was incomplete");
  }
  if (historyRetentionMessages !== undefined && (typeof historyRetentionMessages !== "number" || !Number.isFinite(historyRetentionMessages))) {
    throw new XoreinConnectionError("manifest_invalid", "xorein manifest was incomplete");
  }
  const normalizedHistoryRetentionMessages = typeof historyRetentionMessages === "number" && Number.isFinite(historyRetentionMessages)
    ? historyRetentionMessages
    : undefined;

  return {
    server_id: serverId,
    name,
    ...(description ? { description } : {}),
    owner_peer_id: ownerPeerId,
    owner_public_key: ownerPublicKey,
    owner_addresses: ownerAddresses ?? [],
    ...(bootstrapAddrs !== undefined ? { bootstrap_addrs: bootstrapAddrs } : {}),
    ...(relayAddrs !== undefined ? { relay_addrs: relayAddrs } : {}),
    capabilities: capabilities ?? [],
    ...(normalizedHistoryRetentionMessages !== undefined ? { history_retention_messages: normalizedHistoryRetentionMessages } : {}),
    ...(historyCoverage ? { history_coverage: historyCoverage } : {}),
    ...(historyDurability ? { history_durability: historyDurability } : {}),
    issued_at: issuedAt,
    updated_at: updatedAt,
    ...(expiresAt ? { expires_at: expiresAt } : {}),
    ...(securityMode ? { security_mode: securityMode } : {}),
    signature,
  };
}

function normalizeManifestStringArray(value: unknown, fieldName: string, required = false): string[] | undefined {
  if (value === undefined) {
    if (required) {
      throw new XoreinConnectionError("manifest_invalid", `xorein manifest ${fieldName} was incomplete`);
    }
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new XoreinConnectionError("manifest_invalid", `xorein manifest ${fieldName} was incomplete`);
  }
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") {
      throw new XoreinConnectionError("manifest_invalid", `xorein manifest ${fieldName} was incomplete`);
    }
    const trimmed = entry.trim();
    if (!trimmed || seen.has(trimmed)) {
      if (!trimmed) {
        throw new XoreinConnectionError("manifest_invalid", `xorein manifest ${fieldName} was incomplete`);
      }
      continue;
    }
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeManifestCapabilities(capabilities: readonly string[]): FeatureFlag[] {
  const normalized = new Set<FeatureFlag>();
  for (const rawCapability of capabilities) {
    const capability = rawCapability.trim();
    if (!capability) {
      continue;
    }
    if (!validFeatureFlagName(capability)) {
      throw new XoreinConnectionError("manifest_invalid", `invalid manifest capability: ${capability}`);
    }
    normalized.add(capability as FeatureFlag);
  }
  return [...normalized].sort();
}

function selectAcceptedProtocol(protocolOffers: readonly string[], advertisedCapabilities: readonly FeatureFlag[]): string | undefined {
  const remoteCapabilities = new Set(advertisedCapabilities);
  for (const offer of protocolOffers) {
    let parsed: ProtocolId;
    try {
      parsed = parseProtocolId(offer);
    } catch {
      continue;
    }
    const requiredCapability = PROTOCOL_CAPABILITY_REQUIREMENTS[parsed.family];
    if (requiredCapability && remoteCapabilities.has(requiredCapability)) {
      return offer;
    }
  }
  return undefined;
}

async function safeDisconnect(transport: XoreinTransport, reason: string): Promise<void> {
  try {
    await transport.disconnect(reason);
  } catch {
    // Transport shutdown should not prevent recovery or caller cleanup.
  }
}

function cloneCapabilityNegotiation(
  negotiation: CapabilityNegotiationResult,
): CapabilityNegotiationResult {
  return {
    accepted: Array.from(negotiation.accepted),
    ignoredRemote: Array.from(negotiation.ignoredRemote),
    missingRequired: Array.from(negotiation.missingRequired),
    feedback: negotiation.feedback,
  };
}

function cloneFeatureContract(contract: FeatureProtocolContract): FeatureProtocolContract {
  return {
    localSupported: Array.from(contract.localSupported),
    blockedProtocolFeatures: Array.from(contract.blockedProtocolFeatures),
    localOnlyEnabledFeatures: Array.from(contract.localOnlyEnabledFeatures),
  };
}

function cloneSession(session: XoreinSession | null): XoreinSession | null {
  if (!session) {
    return null;
  }
  const acceptedProtocol = session.acceptedProtocol
    ? {
        family: session.acceptedProtocol.family,
        version: {
          major: session.acceptedProtocol.version.major,
          minor: session.acceptedProtocol.version.minor,
        },
        name: session.acceptedProtocol.name,
      }
    : null;
  return {
    manifest: cloneManifest(session.manifest),
    capabilityNegotiation: cloneCapabilityNegotiation(session.capabilityNegotiation),
    featureContract: cloneFeatureContract(session.featureContract),
    serverId: session.serverId,
    securityMode: session.securityMode,
    acceptedProtocol,
    connectedAtMs: session.connectedAtMs,
    reconnectAttempts: session.reconnectAttempts,
  };
}

function cloneConnectionSnapshot(snapshot: XoreinConnectionSnapshot): XoreinConnectionSnapshot {
  return {
    state: snapshot.state,
    detail: snapshot.detail,
    serverId: snapshot.serverId,
    reconnectAttempts: snapshot.reconnectAttempts,
    updatedAtMs: snapshot.updatedAtMs,
    session: cloneSession(snapshot.session),
  };
}

function mapConnectionFailure(error: unknown): XoreinConnectionLifecycleState {
  const code = extractErrorCode(error);
  switch (code) {
    case "server_not_found":
    case "no_previous_server":
    case "peer_offline":
    case "peer_unreachable":
    case "manifest_mismatch":
      return "no-peer";
    case "relay_unavailable":
    case "no_relay":
    case "delivery_failed":
    case "control_transport_unreachable":
      return "no-relay";
    case "capabilities_unsupported":
    case "security_mode_incompatible":
    case "protocol_unoffered":
    case "fetch_unavailable":
    case "manifest_invalid":
      return "disconnected";
    default:
      break;
  }

  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (message.includes("server not found in local runtime") || message.includes("no previous server")) {
    return "no-peer";
  }
  if (message.includes("relay") || message.includes("delivery failed on direct and relay paths")) {
    return "no-relay";
  }
  return "disconnected";
}

function describeConnectionFailure(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }
  const code = extractErrorCode(error);
  if (code) {
    return code;
  }
  return "connection failed";
}

function extractErrorCode(error: unknown): string {
  if (!error || typeof error !== "object") {
    return "";
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code.trim().toLowerCase() : "";
}

function buildChatScopeStorageKey(scopeId: string): string {
  return `${CHAT_SCOPE_STATE_STORAGE_PREFIX}${scopeId.trim()}`;
}

function createEmptyPersistedChatScopeState(): PersistedChatScopeState {
  return {
    version: 1,
    nickname: "",
    mutedUserIds: [],
    inboxReadIds: [],
    deletedMessageIds: [],
    messages: [],
    threads: {},
  };
}

function normalizeStoredThreads(value: unknown): Record<string, Message[]> {
  if (!isPlainObject(value)) {
    return {};
  }

  const entries = Object.entries(value as Record<string, unknown>);
  const normalized: Record<string, Message[]> = {};
  for (const [key, threadMessages] of entries) {
    const normalizedKey = typeof key === "string" ? key.trim() : "";
    if (!normalizedKey || Object.prototype.hasOwnProperty.call(normalized, normalizedKey)) {
      continue;
    }

    normalized[normalizedKey] = normalizeStoredMessages(threadMessages);
  }

  return normalized;
}

function normalizeStoredMessages(value: unknown): Message[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized: Message[] = [];
  const seenIds = new Set<string>();
  for (const entry of value) {
    if (!isStoredMessage(entry)) {
      continue;
    }
    const message = normalizeStoredMessage(entry);
    if (!message || seenIds.has(message.id)) {
      continue;
    }
    seenIds.add(message.id);
    normalized.push(message);
  }

  return normalized;
}

function normalizeStoredStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") {
      continue;
    }
    const trimmed = entry.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    normalized.push(trimmed);
  }

  return normalized;
}

function normalizeStoredMessage(value: unknown): Message | null {
  if (!isPlainObject(value)) {
    return null;
  }

  const candidate = value as Partial<Message>;
  const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
  const userId = typeof candidate.userId === "string" ? candidate.userId.trim() : "";
  const content = typeof candidate.content === "string" ? candidate.content : "";
  const timestamp = typeof candidate.timestamp === "string" ? candidate.timestamp.trim() : "";
  if (!id || !userId || !content || !timestamp) {
    return null;
  }

  const message: Message = {
    id,
    userId,
    content,
    timestamp,
  };

  if (Array.isArray(candidate.attachments)) {
    message.attachments = candidate.attachments.filter((attachment): attachment is string => typeof attachment === "string" && attachment.trim().length > 0).map((attachment) => attachment.trim());
  }
  if (Array.isArray(candidate.reactions)) {
    message.reactions = candidate.reactions.filter((reaction): reaction is NonNullable<Message["reactions"]>[number] => isPlainObject(reaction) && typeof reaction.emoji === "string" && reaction.emoji.trim().length > 0 && typeof reaction.count === "number" && Number.isFinite(reaction.count) && typeof reaction.reacted === "boolean").map((reaction) => ({
      emoji: reaction.emoji.trim(),
      count: reaction.count,
      reacted: reaction.reacted,
    }));
  }
  if (typeof candidate.isSystem === "boolean") {
    message.isSystem = candidate.isSystem;
  }
  if (typeof candidate.pinned === "boolean") {
    message.pinned = candidate.pinned;
  }
  if (typeof candidate.replyToId === "string" && candidate.replyToId.trim()) {
    message.replyToId = candidate.replyToId.trim();
  }
  if (typeof candidate.editedAt === "string" && candidate.editedAt.trim()) {
    message.editedAt = candidate.editedAt.trim();
  }
  if (typeof candidate.sticker === "boolean") {
    message.sticker = candidate.sticker;
  }

  return message;
}

function isStoredMessage(value: unknown): value is Message {
  if (!isPlainObject(value)) {
    return false;
  }

  const candidate = value as Partial<Message>;
  return typeof candidate.id === "string"
    && typeof candidate.userId === "string"
    && typeof candidate.content === "string"
    && typeof candidate.timestamp === "string";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value)
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function readBrowserRuntimeSnapshot(): {
  identity?: { peer_id?: string };
  control_endpoint?: string;
  settings?: Record<string, string>;
} | null {
  const windowRecord = window as unknown as Record<string, unknown>;
  for (const key of RUNTIME_GLOBAL_KEYS) {
    const value = parseBrowserJson(windowRecord[key]);
    if (value) {
      return value;
    }
  }

  for (const key of RUNTIME_STORAGE_KEYS) {
    const value = parseBrowserJson(safeStorageGet(() => window.localStorage, key)) || parseBrowserJson(safeStorageGet(() => window.sessionStorage, key));
    if (value) {
      return value;
    }
  }

  return null;
}

function readBrowserControlBridgeReady(): boolean {
  const windowRecord = window as unknown as Record<string, unknown>;
  for (const key of CONTROL_READY_GLOBAL_KEYS) {
    if (windowRecord[key] === true) {
      return true;
    }
  }

  return false;
}

function parseBrowserJson(value: unknown): {
  identity?: { peer_id?: string };
  control_endpoint?: string;
  settings?: Record<string, string>;
} | null {
  if (!value) {
    return null;
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return normalizeBrowserRuntimeJson(parsed);
    } catch {
      return null;
    }
  }
  if (typeof value === "object") {
    return normalizeBrowserRuntimeJson(value);
  }
  return null;
}

function normalizeBrowserRuntimeJson(value: unknown): {
  identity?: { peer_id?: string };
  control_endpoint?: string;
  settings?: Record<string, string>;
} | null {
  if (!isPlainObject(value)) {
    return null;
  }

  const identity = normalizeRuntimeIdentity(value.identity);
  const controlEndpoint = normalizeRuntimeEndpoint(value.control_endpoint);
  const settings = normalizeRuntimeSettings(value.settings);
  if (!identity && !controlEndpoint && !settings) {
    return null;
  }

  return {
    ...(identity ? { identity } : {}),
    ...(controlEndpoint ? { control_endpoint: controlEndpoint } : {}),
    ...(settings ? { settings } : {}),
  };
}
