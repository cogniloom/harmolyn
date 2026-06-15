import { FEATURES } from "../config/featureFlags.js";
import {
  type CapabilityNegotiationResult,
  type FeatureFlag,
} from "./capabilities.js";

export type FeatureToggleSet = Readonly<Record<string, boolean>>;

export const FEATURE_CAPABILITY_MAP: Readonly<Record<string, readonly FeatureFlag[]>> = {
  markdownComposer: ["cap.chat"],
  messageReactions: ["cap.chat"],
  messageReplies: ["cap.chat"],
  pinnedMessages: ["cap.chat"],
  messageEditing: ["cap.chat"],
  fileUploads: ["cap.chat"],
  emojiPicker: ["cap.chat"],
  typingIndicators: ["cap.presence", "cap.chat"],
  linkEmbeds: ["cap.chat"],
  spoilerText: ["cap.chat"],
  messageForwarding: ["cap.chat"],
  polls: ["cap.chat"],
  threads: ["cap.chat"],
  slashCommands: ["cap.chat"],
  messageLinks: ["cap.chat"],
  mentionAutocomplete: ["cap.mentions", "cap.chat"],
  slowmode: ["cap.slow-mode"],
  voiceJoinLeave: ["cap.voice"],
  screenShare: ["cap.voice"],
  voiceControlBar: ["cap.voice"],
  loginScreen: ["cap.identity"],
  registerScreen: ["cap.identity"],
  qrLogin: ["cap.identity"],
  mfa: ["cap.identity"],
  accountSwitching: ["cap.identity"],
  profileCustomization: ["cap.identity"],
  serverProfile: ["cap.identity"],
  friendsList: ["cap.friends"],
  userStatus: ["cap.presence"],
  serverSettings: ["cap.management"],
  membersManagement: ["cap.management"],
  channelCreationFlow: ["cap.management"],
  joinViaInvite: ["cap.manifest"],
  vanityUrls: ["cap.manifest"],
  directMessages: ["cap.dm"],
  desktopNotifications: ["cap.notify"],
  inbox: ["cap.notify"],
  autoMod: ["cap.moderation"],
  timeout: ["cap.moderation"],
  rolesManagement: ["cap.rbac"],
  roleHierarchyDragDrop: ["cap.rbac"],
} as const;

export interface FeatureProtocolContract {
  localSupported: FeatureFlag[];
  blockedProtocolFeatures: string[];
  localOnlyEnabledFeatures: string[];
}

export function deriveLocalCapabilities(features: FeatureToggleSet = FEATURES): FeatureFlag[] {
  const capabilities = new Set<FeatureFlag>();

  for (const [feature, enabled] of Object.entries(normalizeFeatureToggleSet(features))) {
    if (!enabled) {
      continue;
    }
    const required = FEATURE_CAPABILITY_MAP[feature];
    if (!required) {
      continue;
    }
    for (const capability of required) {
      capabilities.add(capability);
    }
  }

  return [...capabilities].sort();
}

export function buildFeatureProtocolContract(
  negotiation: CapabilityNegotiationResult,
  features: FeatureToggleSet = FEATURES,
): FeatureProtocolContract {
  const accepted = new Set(negotiation.accepted);
  const blockedProtocolFeatures = new Set<string>();
  const localOnlyEnabledFeatures = new Set<string>();

  for (const [feature, enabled] of Object.entries(normalizeFeatureToggleSet(features))) {
    if (!enabled) {
      continue;
    }
    const required = FEATURE_CAPABILITY_MAP[feature];
    if (!required || required.length === 0) {
      localOnlyEnabledFeatures.add(feature);
      continue;
    }
    if (required.some((capability) => !accepted.has(capability))) {
      blockedProtocolFeatures.add(feature);
    }
  }

  return {
    localSupported: deriveLocalCapabilities(features),
    blockedProtocolFeatures: [...blockedProtocolFeatures].sort(),
    localOnlyEnabledFeatures: [...localOnlyEnabledFeatures].sort(),
  };
}

function normalizeFeatureToggleSet(features: FeatureToggleSet): FeatureToggleSet {
  if (!isPlainObject(features)) {
    return {};
  }

  const normalized: Record<string, boolean> = {};
  for (const [feature, enabled] of Object.entries(features)) {
    if (typeof enabled === "boolean") {
      normalized[feature] = enabled;
    }
  }
  return normalized;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value)
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}
