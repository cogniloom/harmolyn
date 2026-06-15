import { parseAbsoluteUrl } from "./url.js";
const MAX_DEEPLINK_LENGTH = 16_384;
const MAX_XOREIN_INVITE_PAYLOAD_LENGTH = 12_288;
const SERVER_ID_PATTERN = /^[A-Za-z0-9_-]{3,64}$/;
const XOREIN_INVITE_REQUIRED_FIELDS = [
    "owner_peer_id",
    "owner_public_key",
    "manifest_hash",
    "signature",
    "security_mode",
];
export class DeeplinkValidationError extends Error {
    constructor(reason) {
        super(`deeplink validation: ${reason}`);
        this.name = "DeeplinkValidationError";
    }
}
/**
 * Build a shareable join deeplink that carries the owner's peer id so a joiner
 * can dial the owner directly over the relay circuit (P2P) and pull the server.
 *   aether://join/<serverId>?invite=<base64url({v,owner,name})>
 */
export function buildJoinDeepLink(serverId, ownerPeerId, serverName, inviteToken) {
    const payload = JSON.stringify({
        v: 1,
        owner: ownerPeerId,
        ...(serverName ? { name: serverName } : {}),
        ...(inviteToken ? { tok: inviteToken } : {}),
    });
    return `aether://join/${serverId}?invite=${encodeBase64Url(payload)}`;
}
/**
 * Parse an invite (aether or xorein) and surface the owner peer id + server name
 * needed for a real P2P join. Validation/serverId come from parseJoinDeepLink;
 * the owner is decoded from the invite payload (best-effort, never throws on an
 * opaque/legacy invite — it just omits the owner).
 */
export function parseInviteMetadata(raw) {
    const { serverId, invite } = parseJoinDeepLink(raw);
    let ownerPeerId;
    let serverName;
    let inviteToken;
    if (invite) {
        try {
            const decoded = JSON.parse(decodeBase64Url(invite));
            if (isRecord(decoded)) {
                ownerPeerId = trimString(decoded.owner_peer_id) || trimString(decoded.owner) || undefined;
                const manifest = isRecord(decoded.manifest) ? decoded.manifest : undefined;
                serverName = trimString(decoded.name) || (manifest ? trimString(manifest.name) : '') || undefined;
                inviteToken = trimString(decoded.tok) || trimString(decoded.invite_token) || undefined;
            }
        }
        catch { /* opaque/legacy invite — owner unknown, caller falls back */ }
    }
    return {
        serverId,
        ...(ownerPeerId ? { ownerPeerId } : {}),
        ...(serverName ? { serverName } : {}),
        ...(inviteToken ? { inviteToken } : {}),
    };
}
export function parseJoinDeepLink(raw) {
    if (!raw) {
        throw new DeeplinkValidationError("empty deeplink");
    }
    if (raw.length > MAX_DEEPLINK_LENGTH) {
        throw new DeeplinkValidationError("deeplink too long");
    }
    const parsed = parseAbsoluteUrl(raw);
    if (!parsed) {
        throw new DeeplinkValidationError("invalid deeplink: malformed absolute URL");
    }
    switch (parsed.protocol.toLowerCase()) {
        case "aether:":
            return parseAetherJoinDeepLink(parsed);
        case "xorein:":
            return parseXoreinInviteDeepLink(parsed);
        default:
            throw new DeeplinkValidationError("invalid scheme, expected aether or xorein");
    }
}
function parseAetherJoinDeepLink(parsed) {
    if (parsed.hostname.toLowerCase() !== "join") {
        throw new DeeplinkValidationError("deeplink host must be join");
    }
    if (parsed.username || parsed.password) {
        throw new DeeplinkValidationError("userinfo is not allowed");
    }
    if (parsed.hash) {
        throw new DeeplinkValidationError("fragments are not allowed");
    }
    const serverId = parsed.pathname.replace(/^\/+|\/+$/g, "");
    if (!serverId) {
        throw new DeeplinkValidationError("missing server identifier");
    }
    if (!SERVER_ID_PATTERN.test(serverId)) {
        throw new DeeplinkValidationError("server identifier invalid (alphanumeric/_/- only, 3-64 chars)");
    }
    const invite = parsed.searchParams.get("invite");
    if (parsed.search) {
        const entries = [...parsed.searchParams.entries()];
        if (entries.length !== 1 || entries[0]?.[0] !== "invite" || !invite) {
            throw new DeeplinkValidationError("deeplink requires only a non-empty invite query parameter");
        }
    }
    return { serverId, invite: invite?.trim() || null };
}
function parseXoreinInviteDeepLink(parsed) {
    if (parsed.hostname.toLowerCase() !== "invite") {
        throw new DeeplinkValidationError("deeplink host must be invite");
    }
    if (parsed.username || parsed.password) {
        throw new DeeplinkValidationError("userinfo is not allowed");
    }
    if (parsed.hash) {
        throw new DeeplinkValidationError("fragments are not allowed");
    }
    if (parsed.search) {
        throw new DeeplinkValidationError("xorein invite deeplink must not include query parameters");
    }
    const rawInvite = parsed.pathname.replace(/^\/+|\/+$/g, "");
    if (!rawInvite) {
        throw new DeeplinkValidationError("missing invite payload");
    }
    const payload = parseXoreinInvitePayload(rawInvite);
    return { serverId: payload.serverId, invite: rawInvite };
}
function parseXoreinInvitePayload(rawInvite) {
    if (rawInvite.length > MAX_XOREIN_INVITE_PAYLOAD_LENGTH) {
        throw new DeeplinkValidationError("xorein invite payload too long");
    }
    const decoded = decodeBase64Url(rawInvite);
    let parsed;
    try {
        parsed = JSON.parse(decoded);
    }
    catch {
        throw new DeeplinkValidationError("xorein invite payload must be valid JSON");
    }
    if (!isRecord(parsed)) {
        throw new DeeplinkValidationError("xorein invite payload must be an object");
    }
    const invite = parsed;
    const serverId = trimString(invite.server_id);
    if (!serverId) {
        throw new DeeplinkValidationError("xorein invite payload missing server_id");
    }
    if (!SERVER_ID_PATTERN.test(serverId)) {
        throw new DeeplinkValidationError("xorein invite payload server_id invalid (alphanumeric/_/- only, 3-64 chars)");
    }
    for (const field of XOREIN_INVITE_REQUIRED_FIELDS) {
        if (!trimString(invite[field])) {
            throw new DeeplinkValidationError(`xorein invite payload missing ${field}`);
        }
    }
    return { serverId };
}
function trimString(value) {
    return typeof value === "string" ? value.trim() : "";
}
function isRecord(value) {
    return Boolean(value)
        && typeof value === "object"
        && !Array.isArray(value)
        && Object.getPrototypeOf(value) === Object.prototype;
}
function encodeBase64Url(value) {
    let base64;
    if (typeof Buffer !== "undefined") {
        base64 = Buffer.from(value, "utf8").toString("base64");
    }
    else {
        const bytes = new TextEncoder().encode(value);
        let binary = "";
        for (const b of bytes)
            binary += String.fromCharCode(b);
        base64 = btoa(binary);
    }
    return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function decodeBase64Url(value) {
    const normalized = value.trim();
    if (!normalized) {
        throw new DeeplinkValidationError("xorein invite payload missing encoded content");
    }
    const padding = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
    const base64 = `${normalized}${padding}`.replace(/-/g, "+").replace(/_/g, "/");
    if (typeof Buffer !== "undefined") {
        return Buffer.from(base64, "base64").toString("utf8");
    }
    const binary = atob(base64);
    return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}
