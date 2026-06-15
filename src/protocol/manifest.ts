export const MANIFEST_VERSION_V1 = 1;

export interface LegacyManifestCapabilities {
  chat: boolean;
  voice: boolean;
}

export type ManifestCapabilities = LegacyManifestCapabilities | string[];

export interface Manifest {
  serverId: string;
  identity: string;
  version: number;
  name?: string;
  description: string;
  ownerPeerId?: string;
  ownerPublicKey?: string;
  ownerAddresses?: string[];
  bootstrapAddrs?: string[];
  relayAddrs?: string[];
  updatedAt: string;
  issuedAt?: string;
  expiresAt?: string;
  historyRetentionMessages?: number;
  historyCoverage?: string;
  historyDurability?: string;
  capabilities: ManifestCapabilities;
  signature: string;
}

export type Sha256Digest = (payload: string) => Promise<string>;

export class ManifestValidationError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "ManifestValidationError";
  }
}

export function cloneManifest(manifest: Manifest): Manifest {
  const capabilities = Array.isArray(manifest.capabilities)
    ? [...manifest.capabilities]
    : {
        chat: manifest.capabilities.chat,
        voice: manifest.capabilities.voice,
      };
  return {
    serverId: manifest.serverId,
    identity: manifest.identity,
    version: manifest.version,
    description: manifest.description,
    ...(manifest.name ? { name: manifest.name } : {}),
    ...(manifest.ownerPeerId ? { ownerPeerId: manifest.ownerPeerId } : {}),
    ...(manifest.ownerPublicKey ? { ownerPublicKey: manifest.ownerPublicKey } : {}),
    ...(manifest.ownerAddresses ? { ownerAddresses: Array.from(manifest.ownerAddresses) } : {}),
    ...(manifest.bootstrapAddrs ? { bootstrapAddrs: Array.from(manifest.bootstrapAddrs) } : {}),
    ...(manifest.relayAddrs ? { relayAddrs: Array.from(manifest.relayAddrs) } : {}),
    updatedAt: manifest.updatedAt,
    ...(manifest.issuedAt ? { issuedAt: manifest.issuedAt } : {}),
    ...(manifest.expiresAt ? { expiresAt: manifest.expiresAt } : {}),
    ...(manifest.historyRetentionMessages !== undefined ? { historyRetentionMessages: manifest.historyRetentionMessages } : {}),
    ...(manifest.historyCoverage ? { historyCoverage: manifest.historyCoverage } : {}),
    ...(manifest.historyDurability ? { historyDurability: manifest.historyDurability } : {}),
    capabilities,
    signature: manifest.signature,
  };
}

export function validateManifestFields(manifest: Manifest | null | undefined): asserts manifest is Manifest {
  if (!isPlainObject(manifest)) {
    throw new ManifestValidationError("manifest required");
  }
  const serverId = requiredString(manifest.serverId, "server id required");
  if (!serverId) {
    throw new ManifestValidationError("server id required");
  }
  if (typeof manifest.version !== "number" || !Number.isFinite(manifest.version) || manifest.version < MANIFEST_VERSION_V1) {
    throw new ManifestValidationError("manifest version must be >= 1");
  }
  const updatedAt = requiredString(manifest.updatedAt, "updated_at required");
  if (!updatedAt) {
    throw new ManifestValidationError("updated_at required");
  }
  if (Number.isNaN(Date.parse(updatedAt))) {
    throw new ManifestValidationError("updated_at invalid");
  }
  if (isXoreinManifest(manifest)) {
    const ownerPeerId = requiredString(manifest.ownerPeerId, "owner_peer_id required");
    const ownerPublicKey = requiredString(manifest.ownerPublicKey, "owner_public_key required");
    const issuedAt = requiredString(manifest.issuedAt, "issued_at required");
    const capabilities = ensureStringArray(manifest.capabilities, "manifest capabilities must be a list");
    optionalStringArray(manifest.ownerAddresses, "owner addresses must be a list");
    optionalStringArray(manifest.bootstrapAddrs, "bootstrap addresses must be a list");
    optionalStringArray(manifest.relayAddrs, "relay addresses must be a list");
    if (!ownerPeerId) {
      throw new ManifestValidationError("owner_peer_id required");
    }
    if (!ownerPublicKey) {
      throw new ManifestValidationError("owner_public_key required");
    }
    if (!issuedAt) {
      throw new ManifestValidationError("issued_at required");
    }
    if (Number.isNaN(Date.parse(issuedAt))) {
      throw new ManifestValidationError("issued_at invalid");
    }
    if (capabilities.some((capability) => !capability.trim())) {
      throw new ManifestValidationError("manifest capabilities must not contain empty values");
    }
    if (manifest.expiresAt !== undefined) {
      const expiresAt = requiredString(manifest.expiresAt, "expires_at invalid");
      if (expiresAt && Number.isNaN(Date.parse(expiresAt))) {
        throw new ManifestValidationError("expires_at invalid");
      }
    }
    return;
  }

  if (!isPlainObject(manifest.capabilities)) {
    throw new ManifestValidationError("legacy manifest capabilities must be an object");
  }
  if (Array.isArray(manifest.capabilities)) {
    throw new ManifestValidationError("legacy manifest capabilities must be an object");
  }
}

function requiredString(value: unknown, reason: string): string {
  if (typeof value !== "string") {
    throw new ManifestValidationError(reason);
  }
  return value.trim();
}

function ensureStringArray(value: unknown, reason: string): string[] {
  if (!Array.isArray(value)) {
    throw new ManifestValidationError(reason);
  }
  return value.map((entry) => {
    if (typeof entry !== "string") {
      throw new ManifestValidationError(reason);
    }
    return entry;
  });
}

function optionalStringArray(value: unknown, reason: string): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  return ensureStringArray(value, reason);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value)
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

export function canonicalizeManifest(manifest: Manifest): string {
  if (isXoreinManifest(manifest)) {
    return canonicalizeXoreinManifest(manifest);
  }
  validateManifestFields(manifest);
  const capabilities = legacyCapabilities(manifest.capabilities);
  return JSON.stringify({
    server_id: manifest.serverId.trim(),
    identity: manifest.identity.trim(),
    version: manifest.version,
    description: manifest.description ?? "",
    updated_at: manifest.updatedAt.trim(),
    capabilities: {
      chat: Boolean(capabilities.chat),
      voice: Boolean(capabilities.voice),
    },
  });
}

export async function signManifest(
  manifest: Omit<Manifest, "identity" | "signature"> & Partial<Pick<Manifest, "identity" | "signature">>,
  identity: string,
  digest?: Sha256Digest,
): Promise<Manifest> {
  const normalizedIdentity = identity.trim();
  if (!normalizedIdentity) {
    throw new ManifestValidationError("identity required for signing");
  }

  const signed: Manifest = {
    serverId: manifest.serverId,
    identity: normalizedIdentity,
    version: manifest.version,
    description: manifest.description ?? "",
    updatedAt: manifest.updatedAt,
    capabilities: {
      chat: Boolean(legacyCapabilities(manifest.capabilities).chat),
      voice: Boolean(legacyCapabilities(manifest.capabilities).voice),
    },
    signature: "",
  };

  const serialized = canonicalizeManifest(signed);
  signed.signature = await sha256Hex(`${serialized}${normalizedIdentity}`, digest);
  return signed;
}

export async function validateManifestSignature(
  manifest: Manifest,
  identity: string,
  digest?: Sha256Digest,
): Promise<boolean> {
  if (isXoreinManifest(manifest)) {
    return validateXoreinManifestSignature(manifest);
  }
  const normalizedIdentity = identity.trim();
  if (!normalizedIdentity || !manifest.signature.trim()) {
    return false;
  }
  const serialized = canonicalizeManifest(manifest);
  const expected = await sha256Hex(`${serialized}${normalizedIdentity}`, digest);
  return expected === manifest.signature.trim();
}

export async function validateStoredSignature(manifest: Manifest, digest?: Sha256Digest): Promise<void> {
  validateManifestFields(manifest);
  if (isXoreinManifest(manifest)) {
    if (!(await validateXoreinManifestSignature(manifest))) {
      throw new ManifestValidationError("manifest signature invalid");
    }
    return;
  }
  if (!manifest.identity.trim()) {
    throw new ManifestValidationError("manifest identity required");
  }
  if (!manifest.signature.trim()) {
    throw new ManifestValidationError("manifest signature required");
  }
  if (!(await validateManifestSignature(manifest, manifest.identity, digest))) {
    throw new ManifestValidationError("manifest signature invalid");
  }
}

export function validateManifestFreshness(
  manifest: Manifest,
  reference: Date = new Date(),
  maxAgeMs = 0,
): void {
  validateManifestFields(manifest);
  if (manifest.expiresAt) {
    const expiresMs = Date.parse(manifest.expiresAt);
    if (!Number.isNaN(expiresMs) && reference.getTime() > expiresMs) {
      throw new ManifestValidationError("manifest is stale");
    }
  }
  if (maxAgeMs <= 0) {
    return;
  }
  const referenceMs = reference.getTime();
  const updatedMs = Date.parse(manifest.updatedAt);
  if (referenceMs - updatedMs > maxAgeMs) {
    throw new ManifestValidationError("manifest is stale");
  }
}

function isXoreinManifest(manifest: Manifest): boolean {
  return Array.isArray(manifest.capabilities);
}

function canonicalizeXoreinManifest(manifest: Manifest): string {
  validateManifestFields(manifest);
  const ownerAddresses = dedupeSorted(manifest.ownerAddresses);
  const bootstrapAddrs = dedupeSorted(manifest.bootstrapAddrs);
  const relayAddrs = dedupeSorted(manifest.relayAddrs);
  const capabilities = dedupeSorted(Array.isArray(manifest.capabilities) ? manifest.capabilities : []);

  const payload: Record<string, unknown> = {
    server_id: manifest.serverId.trim(),
    name: manifest.name?.trim() || manifest.serverId.trim(),
    owner_peer_id: manifest.ownerPeerId?.trim() || "",
    owner_public_key: manifest.ownerPublicKey?.trim() || "",
    owner_addresses: ownerAddresses,
    capabilities,
    issued_at: manifest.issuedAt?.trim() || "",
    updated_at: manifest.updatedAt.trim(),
  };

  if (manifest.description.trim()) {
    payload.description = manifest.description.trim();
  }
  if (bootstrapAddrs.length > 0) {
    payload.bootstrap_addrs = bootstrapAddrs;
  }
  if (relayAddrs.length > 0) {
    payload.relay_addrs = relayAddrs;
  }
  if ((manifest.historyRetentionMessages ?? 0) > 0) {
    payload.history_retention_messages = Math.trunc(manifest.historyRetentionMessages ?? 0);
  }
  if (manifest.historyCoverage?.trim()) {
    payload.history_coverage = manifest.historyCoverage.trim();
  }
  if (manifest.historyDurability?.trim()) {
    payload.history_durability = manifest.historyDurability.trim();
  }
  if (manifest.expiresAt?.trim()) {
    payload.expires_at = manifest.expiresAt.trim();
  }

  return JSON.stringify(payload);
}

function legacyCapabilities(capabilities: ManifestCapabilities): LegacyManifestCapabilities {
  if (Array.isArray(capabilities)) {
    throw new ManifestValidationError("legacy manifest capabilities must be an object");
  }
  return capabilities;
}

async function validateXoreinManifestSignature(manifest: Manifest): Promise<boolean> {
  if (!manifest.ownerPublicKey?.trim() || !manifest.signature.trim()) {
    return false;
  }
  const payload = new TextEncoder().encode(canonicalizeXoreinManifest(manifest));
  const publicKey = decodeBase64Url(manifest.ownerPublicKey);
  const signature = decodeBase64Url(manifest.signature);

  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    const importedKey = await subtle.importKey("raw", publicKey, { name: "Ed25519" }, false, ["verify"]);
    return subtle.verify("Ed25519", importedKey, signature, payload);
  }

  const processLike = typeof globalThis === "object" && globalThis && "process" in globalThis
    ? (globalThis as { process?: { versions?: { node?: string } } }).process
    : undefined;
  if (processLike?.versions?.node) {
    const nodeCrypto = await importNodeCrypto();
    const spkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
    const key = nodeCrypto.createPublicKey({
      key: Buffer.concat([spkiPrefix, Buffer.from(publicKey)]),
      format: "der",
      type: "spki",
    });
    return nodeCrypto.verify(null, Buffer.from(payload), key, Buffer.from(signature));
  }

  throw new ManifestValidationError("WebCrypto unavailable");
}

// Uint8Array<ArrayBuffer> generic is required by TS 5.9's stricter ArrayBuffer inference.
function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.trim();
  if (!normalized) {
    return new Uint8Array();
  }
  const padding = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  const base64 = `${normalized}${padding}`.replace(/-/g, "+").replace(/_/g, "/");
  if (typeof Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(base64, "base64"));
  }
  const binary = atob(base64);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function dedupeSorted(values: readonly string[] | undefined): string[] {
  if (!values?.length) {
    return [];
  }
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

export async function sha256Hex(payload: string, digest?: Sha256Digest): Promise<string> {
  if (digest) {
    return digest(payload);
  }
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    const bytes = new TextEncoder().encode(payload);
    const hash = await subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  const processLike = typeof globalThis === "object" && globalThis && "process" in globalThis
    ? (globalThis as { process?: { versions?: { node?: string } } }).process
    : undefined;
  if (processLike?.versions?.node) {
    const nodeCrypto = await importNodeCrypto();
    return nodeCrypto.createHash("sha256").update(payload).digest("hex");
  }

  throw new ManifestValidationError("WebCrypto unavailable");
}

async function importNodeCrypto(): Promise<typeof import("node:crypto")> {
  // Keep the Node-only fallback invisible to Vite's browser dependency scan.
  return import(/* @vite-ignore */ "node:crypto");
}
