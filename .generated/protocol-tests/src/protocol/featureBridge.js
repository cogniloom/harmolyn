import { FEATURES } from "../config/featureFlags.js";
import {} from "./capabilities.js";
export const FEATURE_CAPABILITY_MAP = {
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
};
export function deriveLocalCapabilities(features = FEATURES) {
    const capabilities = new Set();
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
export function buildFeatureProtocolContract(negotiation, features = FEATURES) {
    const accepted = new Set(negotiation.accepted);
    const blockedProtocolFeatures = new Set();
    const localOnlyEnabledFeatures = new Set();
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
function normalizeFeatureToggleSet(features) {
    if (!isPlainObject(features)) {
        return {};
    }
    const normalized = {};
    for (const [feature, enabled] of Object.entries(features)) {
        if (typeof enabled === "boolean") {
            normalized[feature] = enabled;
        }
    }
    return normalized;
}
function isPlainObject(value) {
    return Boolean(value)
        && typeof value === "object"
        && !Array.isArray(value)
        && Object.getPrototypeOf(value) === Object.prototype;
}
