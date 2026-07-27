import { useMutation, useQuery } from '@tanstack/react-query';
import { useRuntimeMutations } from './useRuntimeMutations';
import { useRuntimeSnapshot } from '@/lib/xoreinRuntimeContext';
import {
  listAuditLog, listAutoModRules, createAutoModRule, updateAutoModRule, deleteAutoModRule,
  listBots, createBot, deleteBot,
} from '@/lib/xoreinControl';
import type { XoreinAttachment } from '@/types';
import type { AutoModRuleType, AutoModAction } from '@/lib/xoreinControl';

export function useSendChannelMessage() {
  const m = useRuntimeMutations();
  return useMutation({
    mutationFn: ({ channelId, content, replyTo, media }: { channelId: string; content: string; replyTo?: string; media?: XoreinAttachment[] }) =>
      m.sendChannelMessage(channelId, content, {
        ...(replyTo ? { reply_to: replyTo } : {}),
        ...(media && media.length ? { media } : {}),
      }),
  });
}

export function useSendDmMessage() {
  const m = useRuntimeMutations();
  return useMutation({
    mutationFn: ({ dmId, content, forwardedFrom, media }: { dmId: string; content: string; forwardedFrom?: string; media?: XoreinAttachment[] }) =>
      m.sendDmMessage(dmId, content, {
        ...(forwardedFrom ? { forwarded_from: forwardedFrom } : {}),
        ...(media && media.length ? { media } : {}),
      }),
  });
}

export function useEditMessage() {
  const m = useRuntimeMutations();
  return useMutation({
    mutationFn: ({ messageId, content }: { messageId: string; content: string }) =>
      m.editMessage(messageId, content),
  });
}

export function useDeleteMessage() {
  const m = useRuntimeMutations();
  return useMutation({
    mutationFn: ({ messageId }: { messageId: string }) => m.deleteMessage(messageId),
  });
}

export function useAddReaction() {
  const m = useRuntimeMutations();
  return useMutation({
    mutationFn: ({ messageId, emoji }: { messageId: string; emoji: string }) =>
      m.addReaction(messageId, emoji),
  });
}

export function useRemoveReaction() {
  const m = useRuntimeMutations();
  return useMutation({
    mutationFn: ({ messageId, emoji }: { messageId: string; emoji: string }) =>
      m.removeReaction(messageId, emoji),
  });
}

export function useUpdatePresence() {
  const m = useRuntimeMutations();
  return useMutation({
    mutationFn: ({ status, statusText, typingInScope }: { status: string; statusText?: string; typingInScope?: string }) =>
      m.updatePresence({ status, status_text: statusText, typing_in_scope: typingInScope }),
  });
}

export function usePinMessage() {
  const m = useRuntimeMutations();
  return useMutation({
    mutationFn: ({ channelId, messageId }: { channelId: string; messageId: string }) =>
      m.pinMessage(channelId, messageId),
  });
}

/** Mark or unmark a peer's identity as verified after confirming the safety number. */
export function useSetPeerVerified() {
  const m = useRuntimeMutations();
  return useMutation({
    mutationFn: ({ peerId, verified }: { peerId: string; verified: boolean }) =>
      m.setPeerVerified(peerId, verified),
  });
}

export function useUnpinMessage() {
  const m = useRuntimeMutations();
  return useMutation({
    mutationFn: ({ channelId, messageId }: { channelId: string; messageId: string }) =>
      m.unpinMessage(channelId, messageId),
  });
}

export function useCreateServer() {
  const m = useRuntimeMutations();
  return useMutation({
    mutationFn: (input: { name: string; description?: string }) => m.createServer(input),
  });
}

export function useJoinServer() {
  const m = useRuntimeMutations();
  return useMutation({
    mutationFn: ({ deeplink }: { deeplink: string }) => m.joinServerByInvite(deeplink),
  });
}

export function useCreateChannel() {
  const m = useRuntimeMutations();
  return useMutation({
    mutationFn: ({ serverId, name, voice }: { serverId: string; name: string; voice?: boolean }) =>
      m.createChannel(serverId, name, voice),
  });
}

export function useUpdateChannel() {
  const m = useRuntimeMutations();
  return useMutation({
    mutationFn: ({ serverId, channelId, patch }: { serverId: string; channelId: string; patch: { name?: string; topic?: string; bitrate?: number; user_limit?: number } }) =>
      m.updateChannel(serverId, channelId, patch),
  });
}

export function useDeleteChannel() {
  const m = useRuntimeMutations();
  return useMutation({
    mutationFn: ({ serverId, channelId }: { serverId: string; channelId: string }) =>
      m.deleteChannel(serverId, channelId),
  });
}

export function useCreateRole() {
  const m = useRuntimeMutations();
  return useMutation({
    mutationFn: ({ serverId, roleName }: { serverId: string; roleName: string }) =>
      m.createRole(serverId, { role_name: roleName }),
  });
}

export function useUpdateRole() {
  const m = useRuntimeMutations();
  return useMutation({
    mutationFn: ({ serverId, roleId, patch }: { serverId: string; roleId: string; patch: { name?: string; color?: string; permissions?: string[] } }) =>
      m.updateRole(serverId, roleId, patch),
  });
}

export function useDeleteRole() {
  const m = useRuntimeMutations();
  return useMutation({
    mutationFn: ({ serverId, roleId }: { serverId: string; roleId: string }) =>
      m.deleteRole(serverId, roleId),
  });
}

export function useAssignRole() {
  const m = useRuntimeMutations();
  return useMutation({
    mutationFn: ({ serverId, peerId, roleId }: { serverId: string; peerId: string; roleId: string }) =>
      m.assignRole(serverId, peerId, roleId),
  });
}

export function useCastPollVote() {
  const m = useRuntimeMutations();
  return useMutation({
    mutationFn: ({ messageId, optionIndex }: { messageId: string; optionIndex: number }) =>
      m.castPollVote(messageId, optionIndex),
  });
}

export function useModerationAction() {
  const m = useRuntimeMutations();
  return useMutation({
    mutationFn: ({
      serverId, action, input,
    }: {
      serverId: string;
      action: 'kick' | 'ban' | 'unban' | 'mute' | 'slowmode';
      input: { target_peer_id?: string; reason?: string; duration_ms?: number; channel_id?: string; min_delay_ms?: number };
    }) => m.moderationAction(serverId, action, input),
  });
}

export function useCreateIdentity() {
  const m = useRuntimeMutations();
  return useMutation({
    mutationFn: ({ displayName, bio, passphrase }: { displayName: string; bio?: string; passphrase: string }) =>
      m.createIdentity(displayName, bio, passphrase),
  });
}

export function useUpdateProfile() {
  const m = useRuntimeMutations();
  return useMutation({
    mutationFn: ({ displayName, bio, avatar }: { displayName: string; bio?: string; avatar?: string }) =>
      m.updateProfile(displayName, bio, avatar),
  });
}

export function useRestoreIdentity() {
  const m = useRuntimeMutations();
  return useMutation({
    mutationFn: ({ backup, passphrase }: { backup: string; passphrase: string }) =>
      m.restoreIdentity(backup, passphrase),
  });
}

export function useBackupIdentity() {
  const m = useRuntimeMutations();
  return useMutation({
    mutationFn: ({ passphrase }: { passphrase: string }) => m.getIdentityBackup(passphrase),
  });
}

export function useJoinVoice() {
  const m = useRuntimeMutations();
  return useMutation({
    mutationFn: ({ channelId }: { channelId: string; muted?: boolean }) =>
      m.joinVoiceChannel(channelId),
  });
}

export function useLeaveVoice() {
  const m = useRuntimeMutations();
  return useMutation({
    mutationFn: ({ channelId }: { channelId: string }) => m.leaveVoiceChannel(channelId),
  });
}

export function useMuteVoice() {
  const m = useRuntimeMutations();
  return useMutation({
    mutationFn: ({ channelId, muted }: { channelId: string; muted: boolean }) =>
      m.setVoiceMuted(channelId, muted),
  });
}

export function useRegisterRelay() {
  const m = useRuntimeMutations();
  return useMutation({
    mutationFn: ({ multiaddr }: { multiaddr: string }) => m.registerRelay(multiaddr),
  });
}

export function useRemoveRelay() {
  const m = useRuntimeMutations();
  return useMutation({
    mutationFn: ({ multiaddr }: { multiaddr: string }) => m.removeRelay(multiaddr),
  });
}

// ─── Audit Log ─────────────────────────────────────────────
export function useAuditLog(serverId: string, options?: { action?: string; limit?: number }) {
  const snapshot = useRuntimeSnapshot();
  return useQuery({
    queryKey: ['audit-log', serverId, options?.action, options?.limit],
    queryFn: () => listAuditLog(snapshot, serverId, options),
    enabled: !!serverId,
    refetchInterval: 10_000,
  });
}

// ─── AutoMod ───────────────────────────────────────────────
export function useAutoModRules(serverId: string) {
  const snapshot = useRuntimeSnapshot();
  return useQuery({
    queryKey: ['automod-rules', serverId],
    queryFn: () => listAutoModRules(snapshot, serverId),
    enabled: !!serverId,
  });
}

export function useCreateAutoModRule(serverId: string) {
  const snapshot = useRuntimeSnapshot();
  return useMutation({
    mutationFn: (input: { name: string; type: AutoModRuleType; enabled: boolean; keyword_patterns?: string[]; actions: AutoModAction[] }) =>
      createAutoModRule(snapshot, serverId, input),
  });
}

export function useUpdateAutoModRule(serverId: string) {
  const snapshot = useRuntimeSnapshot();
  return useMutation({
    mutationFn: ({ ruleId, patch }: { ruleId: string; patch: { name?: string; enabled?: boolean; keyword_patterns?: string[]; actions?: AutoModAction[] } }) =>
      updateAutoModRule(snapshot, serverId, ruleId, patch),
  });
}

export function useDeleteAutoModRule(serverId: string) {
  const snapshot = useRuntimeSnapshot();
  return useMutation({
    mutationFn: ({ ruleId }: { ruleId: string }) => deleteAutoModRule(snapshot, serverId, ruleId),
  });
}

// ─── Bots ───────────────────────────────────────────────────
export function useBots(serverId: string) {
  const snapshot = useRuntimeSnapshot();
  return useQuery({
    queryKey: ['bots', serverId],
    queryFn: () => listBots(snapshot, serverId),
    enabled: !!serverId,
  });
}

export function useCreateBot(serverId: string) {
  const snapshot = useRuntimeSnapshot();
  return useMutation({
    mutationFn: ({ name }: { name: string }) => createBot(snapshot, serverId, name),
  });
}

export function useDeleteBot(serverId: string) {
  const snapshot = useRuntimeSnapshot();
  return useMutation({
    mutationFn: ({ botId }: { botId: string }) => deleteBot(snapshot, serverId, botId),
  });
}
