export interface ProtocolVersion {
  major: number;
  minor: number;
}

export interface ProtocolId {
  family: string;
  version: ProtocolVersion;
  name: string;
}

export const MULTISTREAM_NAMESPACE = "/aether" as const;

export function stringifyProtocolId(protocol: ProtocolId): string {
  return `${MULTISTREAM_NAMESPACE}/${protocol.family.toLowerCase()}/${protocol.version.major}.${protocol.version.minor}`;
}

export function parseProtocolId(input: string): ProtocolId {
  const trimmed = input.trim();
  if (!trimmed.startsWith(`${MULTISTREAM_NAMESPACE}/`)) {
    throw new Error(`invalid protocol namespace: ${trimmed}`);
  }

  const parts = trimmed.slice(MULTISTREAM_NAMESPACE.length + 1).split("/");
  if (parts.length !== 2) {
    throw new Error(`malformed protocol identifier: ${trimmed}`);
  }

  const family = parts[0].trim().toLowerCase();
  if (!family) {
    throw new Error("protocol family required");
  }

  const versionParts = parts[1].split(".");
  if (versionParts.length !== 2) {
    throw new Error(`unexpected version syntax: ${parts[1]}`);
  }

  const major = parseVersionPart(versionParts[0], "major");
  const minor = parseVersionPart(versionParts[1], "minor");

  return {
    family,
    version: { major, minor },
    name: `${family}/${major}.${minor}`,
  };
}

function parseVersionPart(value: string, label: string): number {
  if (!value) {
    throw new Error(`invalid ${label} version: empty`);
  }
  if (!/^\d+$/.test(value)) {
    throw new Error(`invalid ${label} version: ${value}`);
  }
  return Number.parseInt(value, 10);
}
