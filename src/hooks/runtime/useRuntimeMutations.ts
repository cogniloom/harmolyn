// Mutation facade: routes to the native engine when nativeEngine flag is on
// and the engine is connected; otherwise falls through to the HTTP control client.
// This is the single switch-point — mutations.ts calls this hook instead of
// importing xoreinControl functions directly.
import { useMemo } from 'react';
import { useNativeEngine } from '@/native/engine/provider';
import { useRuntimeSnapshot } from '@/lib/xoreinRuntimeContext';
import type { XoreinRuntimeSnapshot } from '@/types';
import { resolveFeatureFlag } from '@/config/featureFlags';
import {
  nativeSendChannelMessage, nativeSendDmMessage,
  nativeEditMessage, nativeDeleteMessage,
  nativeAddReaction, nativeRemoveReaction,
  nativePinMessage, nativeUnpinMessage,
  nativeCreateServer, nativeCreateChannel,
  nativeUpdateChannel, nativeDeleteChannel,
  type ChannelEditPatch, type ServerMetaPatch,
  nativeUpdateServerMeta, nativeRemoveMember,
  nativeLeaveServer, nativeDeleteServer,
  nativeRotateInvite, nativeRevokeInvite,
  nativeSetActiveScope, nativeMarkScopeRead,
  nativeJoinVoice, nativeLeaveVoice,
  nativeAddRelay, nativeRemoveRelay as nativeRemoveRelayMutation,
  nativeUpdatePresence,
  nativeAddFriendRequest, nativeAcceptFriend, nativeDeclineFriend,
  nativeJoinServer,
  nativeEnsureDirectMessage,
  nativeCreateRole, nativeUpdateRole, nativeDeleteRole, nativeAssignRole, nativeCastPollVote,
  nativeSearchMessages, nativeSetPeerVerified, nativeSubmitReport, type ReportInput,
} from '@/native/state/mutations';
import { saveCurrentToVault } from '@/native/identity/storage';
import { mergeNativeIdentityProfile, getState } from '@/native/state/store';
import { publishNativeSnapshot } from '@/native/state/snapshot';
import {
  sendChannelMessage, sendDmMessage,
  editMessage, deleteMessage,
  addReaction, removeReaction,
  updatePresence,
  pinMessage, unpinMessage,
  createServer, joinServerByInvite,
  createChannel,
  createRole, assignRole, moderationAction,
  createIdentity, restoreIdentity, getIdentityBackup,
  joinVoiceChannel, leaveVoiceChannel, setVoiceMuted,
  registerRelay, removeRelay,
  sendFriendRequest, actOnFriendRequest, removeFriend,
  markNotificationsRead, searchNotifications,
  searchMessages as xoreinSearchMessages,
  uploadAttachment,
  sendVoiceFrame,
} from '@/lib/xoreinControl';

type Snapshot = XoreinRuntimeSnapshot | null | undefined;

export function useRuntimeMutations() {
  const { engine, registerIdentity } = useNativeEngine();
  const snapshot = useRuntimeSnapshot();
  // Use the native engine for all mutations once it has started, regardless of
  // whether the relay is currently connected. Local mutations (createServer,
  // createChannel, sendMessage, etc.) are purely offline-capable; P2P ops that
  // genuinely need the relay (joinServer) will surface a clear error when offline.
  const native = resolveFeatureFlag('nativeEngine') && engine != null;

  return useMemo(() => {
    const snap = snapshot as Snapshot;

    // Identity ops are offline-capable (encrypt + persist + set in-memory state +
    // publish) and must NOT wait for the transport to reach `connected`. When the
    // native engine flag is on we always drive registration through the engine,
    // even while the relay is still reserving a circuit — otherwise creating an
    // account during that window fell through to the HTTP path (which ignores the
    // passphrase, never sets a native peer_id) and the user stayed "Viewing as
    // guest" until reload. These are defined once and shared by both branches.
    const engineActive = resolveFeatureFlag('nativeEngine');
    const identityOps = {
      createIdentity: async (displayName: string, bio?: string, passphrase?: string) => {
        if (!passphrase) {
          throw new Error('A password is required to create your identity.');
        }
        if (engineActive) {
          await registerIdentity(passphrase, displayName, bio);
        }
        // Best-effort: inform the support node of the display name (non-fatal;
        // it 401s on most origins, which must never block local registration).
        try {
          await createIdentity(snap, displayName, bio);
        } catch {
          /* support node optional in native mode */
        }
        // Read the freshly-registered peer_id from the LIVE native store, never the
        // stale `snap` closure (which predates this registration and would skip the
        // vault save and return an empty peer_id).
        const peerId = engineActive
          ? (getState().identity?.peer_id ?? '')
          : (snap?.identity?.peer_id ?? '');
        if (peerId && engineActive) {
          // Auto-save the new identity to the vault so it's immediately switchable.
          saveCurrentToVault(peerId, displayName).catch(() => { /* vault write best-effort */ });
        }
        return { peer_id: peerId, display_name: displayName, ...(bio ? { bio } : {}) };
      },
      // Profile edit for an already-registered identity — no passphrase / no
      // re-encryption; update display name/bio/avatar and publish. The avatar is a
      // self-contained data: URI that persists on the identity profile (restored on
      // reload) and is broadcast to peers via voice/presence.
      updateProfile: async (displayName: string, bio?: string, avatar?: string) => {
        if (engineActive) {
          mergeNativeIdentityProfile(displayName, bio, avatar);
          publishNativeSnapshot();
        }
        try {
          await createIdentity(snap, displayName, bio);
        } catch {
          /* support node optional in native mode */
        }
        const peerId = engineActive ? (getState().identity?.peer_id ?? '') : (snap?.identity?.peer_id ?? '');
        return { peer_id: peerId, display_name: displayName, ...(bio ? { bio } : {}), ...(avatar ? { avatar } : {}) };
      },
      restoreIdentity: async (backup: string, passphrase: string) => {
        const result = await restoreIdentity(snap, backup, passphrase);
        const r = result as { display_name?: string; profile?: { display_name?: string; bio?: string }; bio?: string };
        const dn = r?.profile?.display_name ?? r?.display_name;
        const bio = r?.profile?.bio ?? r?.bio;
        if (dn && engineActive) { mergeNativeIdentityProfile(dn, bio); publishNativeSnapshot(); }
        return result;
      },
      getIdentityBackup: (passphrase: string) => getIdentityBackup(snap, passphrase),
    };

    if (native) {
      return {
        // Message mutations — fully native
        sendChannelMessage: (channelId: string, content: string, opts: object = {}) =>
          Promise.resolve(nativeSendChannelMessage(channelId, content, opts as { reply_to?: string })),
        sendDmMessage: (dmId: string, content: string, opts: object = {}) =>
          Promise.resolve(nativeSendDmMessage(dmId, content, opts as { forwarded_from?: string })),
        editMessage: (messageId: string, content: string) =>
          Promise.resolve(nativeEditMessage(messageId, content)),
        deleteMessage: (messageId: string) =>
          Promise.resolve(nativeDeleteMessage(messageId)),
        addReaction: (messageId: string, emoji: string) =>
          Promise.resolve(nativeAddReaction(messageId, emoji)),
        removeReaction: (messageId: string, emoji: string) =>
          Promise.resolve(nativeRemoveReaction(messageId, emoji)),

        // Server / channel — native
        createServer: (input: { name: string; description?: string }) =>
          Promise.resolve(nativeCreateServer(input.name, input.description)),
        createChannel: (serverId: string, name: string, voice = false) =>
          Promise.resolve(nativeCreateChannel(serverId, name, voice)),
        updateChannel: (serverId: string, channelId: string, patch: ChannelEditPatch) =>
          Promise.resolve(nativeUpdateChannel(serverId, channelId, patch)),
        deleteChannel: (serverId: string, channelId: string) =>
          Promise.resolve(nativeDeleteChannel(serverId, channelId)),
        updateServerMeta: (serverId: string, patch: ServerMetaPatch) =>
          Promise.resolve(nativeUpdateServerMeta(serverId, patch)),
        removeMember: (serverId: string, peerId: string) =>
          Promise.resolve(nativeRemoveMember(serverId, peerId)),
        leaveServer: (serverId: string) => Promise.resolve(nativeLeaveServer(serverId)),
        deleteServer: (serverId: string) => Promise.resolve(nativeDeleteServer(serverId)),
        rotateInvite: (serverId: string) => Promise.resolve(nativeRotateInvite(serverId)),
        revokeInvite: (serverId: string) => Promise.resolve(nativeRevokeInvite(serverId)),

        // Read-state / notifications — native
        setActiveScope: (scopeId: string | null) => Promise.resolve(nativeSetActiveScope(scopeId)),
        markScopeRead: (scopeId: string) => Promise.resolve(nativeMarkScopeRead(scopeId)),

        // Identity verification (safety numbers) — native
        setPeerVerified: (peerId: string, verified: boolean) => Promise.resolve(nativeSetPeerVerified(peerId, verified)),
        // Abuse reporting — native (delivered P2P to the server owner for server scope)
        submitReport: (input: ReportInput) => Promise.resolve(nativeSubmitReport(input)),

        // Presence — native
        updatePresence: (opts: { status: string; status_text?: string; typing_in_scope?: string }) =>
          Promise.resolve(nativeUpdatePresence(opts.status, opts)),

        // Voice — real WebRTC media when voiceMediaTransport flag is on; store-only
        // state update (today's behaviour) when the flag is off.
        joinVoiceChannel: (channelId: string) =>
          resolveFeatureFlag('voiceMediaTransport') && engine
            ? engine.joinVoice(channelId)
            : Promise.resolve(nativeJoinVoice(channelId)),
        leaveVoiceChannel: (channelId: string) =>
          resolveFeatureFlag('voiceMediaTransport') && engine
            ? engine.leaveVoice(channelId)
            : Promise.resolve(nativeLeaveVoice(channelId)),

        // Relay — native
        registerRelay: (multiaddr: string) => Promise.resolve(nativeAddRelay(multiaddr)),
        removeRelay: (multiaddr: string) => Promise.resolve(nativeRemoveRelayMutation(multiaddr)),

        // Friend request — native
        addFriendRequest: (peerAddr: string) => Promise.resolve(nativeAddFriendRequest(peerAddr)),

        // Open/create a 1:1 DM thread for a peer and return its id — native.
        ensureDirectMessage: (peerId: string) => nativeEnsureDirectMessage(peerId),

        // Native join: dial the server owner over the relay circuit (P2P) and pull
        // the manifest/channels/history; the engine handles the fallback when the
        // owner is offline. engine is non-null on the native path.
        joinServerByInvite: (deeplink: string) =>
          engine ? engine.joinServer(deeplink) : Promise.resolve(nativeJoinServer(deeplink)),
        // Page older channel history from the owner or any reachable member.
        loadOlderHistory: (serverId: string, channelId: string) =>
          engine ? engine.pullOlderHistory(serverId, channelId) : Promise.resolve({ added: 0, hasMore: false }),
        pinMessage: (channelId: string, messageId: string) => Promise.resolve(nativePinMessage(channelId, messageId)),
        unpinMessage: (channelId: string, messageId: string) => Promise.resolve(nativeUnpinMessage(channelId, messageId)),
        createRole: (serverId: string, opts: { role_name: string; permissions_bitfield?: number }) =>
          Promise.resolve(nativeCreateRole(serverId, opts.role_name, [])),
        updateRole: (serverId: string, roleId: string, patch: { name?: string; color?: string; permissions?: string[] }) =>
          Promise.resolve(nativeUpdateRole(serverId, roleId, patch)),
        deleteRole: (serverId: string, roleId: string) => Promise.resolve(nativeDeleteRole(serverId, roleId)),
        assignRole: (serverId: string, peerId: string, roleId: string) => Promise.resolve(nativeAssignRole(serverId, peerId, roleId)),
        castPollVote: (messageId: string, optionIndex: number) => Promise.resolve(nativeCastPollVote(messageId, optionIndex)),
        moderationAction: (serverId: string, action: string, input: object) => moderationAction(snap, serverId, action as Parameters<typeof moderationAction>[2], input),
        ...identityOps,
        setVoiceMuted: (channelId: string, muted: boolean) =>
          resolveFeatureFlag('voiceMediaTransport') && engine
            ? Promise.resolve(engine.setVoiceMuted(channelId, muted))
            : setVoiceMuted(snap, channelId, muted),
        // Voice video / screen share — real WebRTC track add/remove via the mesh.
        setVoiceCamera: (channelId: string, on: boolean) =>
          engine ? engine.setVoiceCamera(channelId, on) : Promise.resolve(),
        startVoiceScreenShare: (channelId: string, opts: { withAudio?: boolean; quality?: string; surface?: 'screen' | 'window' | 'tab' } = {}) =>
          engine ? engine.startVoiceScreenShare(channelId, opts) : Promise.reject(new Error('Screen share requires the native engine.')),
        stopVoiceScreenShare: (channelId: string) =>
          engine ? engine.stopVoiceScreenShare(channelId) : Promise.resolve(),
        isVoiceScreenSharing: (channelId: string) =>
          engine ? engine.isVoiceScreenSharing(channelId) : false,
        // Friends — native P2P: request / accept / decline travel peer-to-peer over
        // PROTOCOLS.friends so they reach the other peer (the HTTP support node
        // can't deliver to another peer). removeFriend/block stay HTTP for now.
        sendFriendRequest: (peerAddr: string) => Promise.resolve(nativeAddFriendRequest(peerAddr)),
        acceptFriend: (requestId: string) => Promise.resolve(nativeAcceptFriend(requestId)),
        declineFriend: (requestId: string) => Promise.resolve(nativeDeclineFriend(requestId)),
        actOnFriendRequest: (requestId: string, action: 'accept' | 'decline' | 'cancel' | 'block') =>
          action === 'accept'
            ? Promise.resolve(nativeAcceptFriend(requestId))
            : Promise.resolve(nativeDeclineFriend(requestId)),
        removeFriend: (friendId: string) => removeFriend(snap, friendId),
        // Notifications — HTTP
        markNotificationsRead: (input: { read_through_message_id: string; server_id?: string; scope_type?: 'channel' | 'dm'; scope_id?: string }) => markNotificationsRead(snap, input),
        searchNotifications: (filter?: Parameters<typeof searchNotifications>[1]) => searchNotifications(snap, filter),
        // Message search — native local store (full-text over P2P messages, no API round-trip).
        searchMessages: (q?: Parameters<typeof nativeSearchMessages>[0]) => Promise.resolve(nativeSearchMessages(q ?? {})),
        // Uploads — HTTP (blob store)
        uploadAttachment: (input: { filename: string; contentType: string; data: string }) => uploadAttachment(snap, input),
        // Voice frames — HTTP
        sendVoiceFrame: (channelId: string, payload: unknown) => sendVoiceFrame(snap, channelId, payload),
      };
    }

    // HTTP control client path (default).
    return {
      sendChannelMessage: (channelId: string, content: string, opts: object = {}) =>
        sendChannelMessage(snap, channelId, content, opts),
      sendDmMessage: (dmId: string, content: string, opts: object = {}) =>
        sendDmMessage(snap, dmId, content, opts),
      editMessage: (messageId: string, content: string) => editMessage(snap, messageId, content),
      deleteMessage: (messageId: string) => deleteMessage(snap, messageId),
      addReaction: (messageId: string, emoji: string) => addReaction(snap, messageId, emoji),
      removeReaction: (messageId: string, emoji: string) => removeReaction(snap, messageId, emoji),
      createServer: (input: { name: string; description?: string }) => createServer(snap, input),
      createChannel: (serverId: string, name: string, voice = false) =>
        createChannel(snap, serverId, name, voice),
      updateChannel: (serverId: string, channelId: string, patch: ChannelEditPatch) =>
        Promise.resolve(nativeUpdateChannel(serverId, channelId, patch)),
      deleteChannel: (serverId: string, channelId: string) =>
        Promise.resolve(nativeDeleteChannel(serverId, channelId)),
      updateServerMeta: (serverId: string, patch: ServerMetaPatch) =>
        Promise.resolve(nativeUpdateServerMeta(serverId, patch)),
      removeMember: (serverId: string, peerId: string) =>
        Promise.resolve(nativeRemoveMember(serverId, peerId)),
      leaveServer: (serverId: string) => Promise.resolve(nativeLeaveServer(serverId)),
      deleteServer: (serverId: string) => Promise.resolve(nativeDeleteServer(serverId)),
      rotateInvite: (serverId: string) => Promise.resolve(nativeRotateInvite(serverId)),
      revokeInvite: (serverId: string) => Promise.resolve(nativeRevokeInvite(serverId)),
      setActiveScope: (scopeId: string | null) => Promise.resolve(nativeSetActiveScope(scopeId)),
      markScopeRead: (scopeId: string) => Promise.resolve(nativeMarkScopeRead(scopeId)),
      setPeerVerified: (peerId: string, verified: boolean) => Promise.resolve(nativeSetPeerVerified(peerId, verified)),
      submitReport: (input: ReportInput) => Promise.resolve(nativeSubmitReport(input)),
      updatePresence: (opts: { status: string; status_text?: string; typing_in_scope?: string }) =>
        updatePresence(snap, opts),
      joinVoiceChannel: (channelId: string) => joinVoiceChannel(snap, channelId),
      leaveVoiceChannel: (channelId: string) => leaveVoiceChannel(snap, channelId),
      registerRelay: (multiaddr: string) => registerRelay(snap, multiaddr),
      removeRelay: (multiaddr: string) => removeRelay(snap, multiaddr),
      addFriendRequest: (peerAddr: string) => sendFriendRequest(snap, peerAddr),
      ensureDirectMessage: (peerId: string) => nativeEnsureDirectMessage(peerId),
      joinServerByInvite: (deeplink: string) => joinServerByInvite(snap, deeplink),
      loadOlderHistory: (_serverId: string, _channelId: string) => Promise.resolve({ added: 0, hasMore: false }),
      pinMessage: (channelId: string, messageId: string) => pinMessage(snap, channelId, messageId),
      unpinMessage: (channelId: string, messageId: string) => unpinMessage(snap, channelId, messageId),
      createRole: (serverId: string, opts: { role_name: string; permissions_bitfield?: number }) => createRole(snap, serverId, opts),
      updateRole: (_serverId: string, _roleId: string, _patch: { name?: string; color?: string; permissions?: string[] }) => Promise.resolve(),
      deleteRole: (_serverId: string, _roleId: string) => Promise.resolve(),
      assignRole: (serverId: string, peerId: string, role: string) => assignRole(snap, serverId, peerId, role),
      castPollVote: (_messageId: string, _optionIndex: number) => Promise.resolve(),
      moderationAction: (serverId: string, action: string, input: object) =>
        moderationAction(snap, serverId, action as Parameters<typeof moderationAction>[2], input),
      ...identityOps,
      setVoiceMuted: (channelId: string, muted: boolean) => setVoiceMuted(snap, channelId, muted),
      setVoiceCamera: (_channelId: string, _on: boolean) => Promise.resolve(),
      startVoiceScreenShare: (_channelId: string, _opts: { withAudio?: boolean; quality?: string; surface?: 'screen' | 'window' | 'tab' } = {}) => Promise.reject(new Error('Screen share requires the native engine.')),
      stopVoiceScreenShare: (_channelId: string) => Promise.resolve(),
      isVoiceScreenSharing: (_channelId: string) => false,
      sendFriendRequest: (peerAddr: string) => sendFriendRequest(snap, peerAddr),
      acceptFriend: (requestId: string) => actOnFriendRequest(snap, requestId, 'accept'),
      declineFriend: (requestId: string) => actOnFriendRequest(snap, requestId, 'decline'),
      actOnFriendRequest: (requestId: string, action: 'accept' | 'decline' | 'cancel' | 'block') => actOnFriendRequest(snap, requestId, action),
      removeFriend: (friendId: string) => removeFriend(snap, friendId),
      markNotificationsRead: (input: { read_through_message_id: string; server_id?: string; scope_type?: 'channel' | 'dm'; scope_id?: string }) => markNotificationsRead(snap, input),
      searchNotifications: (filter?: Parameters<typeof searchNotifications>[1]) => searchNotifications(snap, filter),
      searchMessages: (q?: Parameters<typeof xoreinSearchMessages>[1]) => xoreinSearchMessages(snap, q),
      uploadAttachment: (input: { filename: string; contentType: string; data: string }) => uploadAttachment(snap, input),
      sendVoiceFrame: (channelId: string, payload: unknown) => sendVoiceFrame(snap, channelId, payload),
    };
  // Recompute when native engine state or snapshot changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [native, snapshot, registerIdentity]);
}
