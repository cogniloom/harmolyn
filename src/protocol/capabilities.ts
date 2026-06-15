export const FEATURE_FLAG_PREFIX = "cap." as const;

export type FeatureFlag = `cap.${string}`;

export const DEFAULT_FEATURE_FLAGS = [
  "cap.chat",
  "cap.voice",
  "cap.management",
  "cap.manifest",
  "cap.identity",
  "cap.sync",
  "cap.dm",
  "cap.group-dm",
  "cap.friends",
  "cap.presence",
  "cap.notify",
  "cap.mentions",
  "cap.moderation",
  "cap.rbac",
  "cap.slow-mode",
] as const satisfies readonly FeatureFlag[];

export type SecurityMode = "unspecified" | "seal" | "tree" | "clear";
export type ModeNegotiationReason = "matched" | "unsupported-mode" | "no-offer";
export type CapabilityFeedback = "none" | "remote-features-ignored" | "upgrade-required";

export interface ModeNegotiationResult {
  mode: SecurityMode;
  reason: ModeNegotiationReason;
}

export interface CapabilityNegotiationResult {
  accepted: FeatureFlag[];
  ignoredRemote: string[];
  missingRequired: string[];
  feedback: CapabilityFeedback;
}

export function validFeatureFlagName(flag: string): flag is FeatureFlag {
  if (!flag.startsWith(FEATURE_FLAG_PREFIX)) {
    return false;
  }
  if (flag !== flag.toLowerCase()) {
    return false;
  }

  const tail = flag.slice(FEATURE_FLAG_PREFIX.length);
  if (tail.length === 0) {
    return false;
  }

  let lastWasSeparator = true;
  for (const char of tail) {
    const isAlpha = char >= "a" && char <= "z";
    const isDigit = char >= "0" && char <= "9";
    const isSeparator = char === "." || char === "-";

    if (isAlpha || isDigit) {
      lastWasSeparator = false;
      continue;
    }
    if (isSeparator) {
      if (lastWasSeparator) {
        return false;
      }
      lastWasSeparator = true;
      continue;
    }
    return false;
  }

  return !lastWasSeparator;
}

export function negotiateCapabilities(
  localSupported: readonly FeatureFlag[],
  remoteAdvertised: readonly string[],
  remoteRequired: readonly string[],
): CapabilityNegotiationResult {
  const localSet = new Set(localSupported);
  const accepted = new Set<FeatureFlag>();
  const ignoredRemote = new Set<string>();
  const missingRequired = new Set<string>();

  for (const rawName of remoteAdvertised) {
    const name = rawName.trim();
    if (!name) {
      continue;
    }
    if (!validFeatureFlagName(name)) {
      ignoredRemote.add(name);
      continue;
    }
    if (localSet.has(name)) {
      accepted.add(name);
      continue;
    }
    ignoredRemote.add(name);
  }

  for (const rawName of remoteRequired) {
    const name = rawName.trim();
    if (!name) {
      continue;
    }
    if (!validFeatureFlagName(name) || !localSet.has(name)) {
      missingRequired.add(name);
    }
  }

  const result: CapabilityNegotiationResult = {
    accepted: [...accepted].sort(),
    ignoredRemote: [...ignoredRemote].sort(),
    missingRequired: [...missingRequired].sort(),
    feedback: "none",
  };

  if (result.missingRequired.length > 0) {
    result.feedback = "upgrade-required";
    return result;
  }
  if (result.ignoredRemote.length > 0) {
    result.feedback = "remote-features-ignored";
  }
  return result;
}

export function negotiateConversationSecurityMode(
  localPreferred: readonly SecurityMode[],
  remoteOffered: readonly SecurityMode[],
): ModeNegotiationResult {
  if (remoteOffered.length === 0) {
    return { mode: "unspecified", reason: "no-offer" };
  }

  const offered = new Set(remoteOffered);
  for (const mode of localPreferred) {
    if (mode === "unspecified") {
      continue;
    }
    if (offered.has(mode)) {
      return { mode, reason: "matched" };
    }
  }
  return { mode: "unspecified", reason: "unsupported-mode" };
}
