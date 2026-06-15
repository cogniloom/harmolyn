/**
 * Centralized localStorage keys for browser-scoped feature state.
 *
 * The xorein control API exposes runtime state + a fixed set of mutations
 * (messages, channels, voice, dms, identities, peers). Features without a
 * runtime endpoint persist deterministically in the browser under these keys.
 * Keep the `harmolyn:xorein:<feature>` namespace so keys can't collide.
 */
export const PREVIEW_STORAGE_KEYS = {
  forum: (channelId: string) => `harmolyn:xorein:forum:${channelId}`,
  announcements: (channelId: string) => `harmolyn:xorein:announcements:${channelId}`,
  channelKinds: 'harmolyn:xorein:channel-kinds',
  voiceText: (channelId: string) => `harmolyn:xorein:voice-text:${channelId}`,
  stage: (channelId: string) => `harmolyn:xorein:stage:${channelId}`,
  channelFollows: 'harmolyn:xorein:channel-follows',
  serverApplications: (serverId: string) => `harmolyn:xorein:server-applications:${serverId}`,
  serverBoost: (serverId: string) => `harmolyn:xorein:server-boost:${serverId}`,
  scheduledEvents: (serverId: string) => `harmolyn:xorein:scheduled-events:${serverId}`,
  soundboard: 'harmolyn:xorein:soundboard',
  shop: 'harmolyn:xorein:shop',
  quests: 'harmolyn:xorein:quests',
  serverAdmin: (serverId: string) => `harmolyn:xorein:server-admin:${serverId}`,
  discovery: 'harmolyn:xorein:discovery',
} as const;
