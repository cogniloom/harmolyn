import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Category, Channel, Server, User } from '@/types';
import { X, Settings, Hash, Shield, Users, Link, Volume2, Crown, Pencil, Trash2, Plus, Copy, Check, FileText, Clock, Filter, ShieldAlert, Ban, AlertTriangle, Search, Bot, Key, Flag } from 'lucide-react';
import { useFeature } from '@/hooks/useFeature';
import { useNodeHealth } from '@/hooks/useNodeHealth';
import { NODE_OFFLINE_MESSAGE } from '@/lib/nodeHealth';
import { useEscapeKey } from '@/hooks/useEscapeKey';
import { copyTextToClipboardSafely, safeConfirm } from '@/components/contextMenuUtils';
import { resolveAvatarSrc } from '@/lib/avatar';
import { createCollisionResistantId } from '@/lib/localIds';
import { useCreateChannel, useCreateRole, useUpdateRole, useDeleteRole, useAssignRole, useModerationAction, useUpdateChannel, useDeleteChannel, useAuditLog, useAutoModRules, useCreateAutoModRule, useUpdateAutoModRule, useDeleteAutoModRule, useBots, useCreateBot, useDeleteBot } from '@/hooks/runtime/mutations';
import { useRuntimeMutations } from '@/hooks/runtime/useRuntimeMutations';
import { useRuntimeSnapshot } from '@/lib/xoreinRuntimeContext';
import { ReportInbox } from '@/components/ReportInbox';

interface ServerSettingsScreenProps {
  server: Server;
  onClose: () => void;
}

type SettingsSection = 'overview' | 'roles' | 'channels' | 'members' | 'invites' | 'reports' | 'audit-log' | 'automod' | 'bots';
type FeedbackTone = 'error' | 'info' | 'success';

interface FeedbackState {
  tone: FeedbackTone;
  message: string;
}

interface ManagedRole {
  id: string;
  name: string;
  color: string;
  permissions: string[];
  protected?: boolean;
}

interface InviteRecord {
  id: string;
  code: string;
  createdAt: string;
  expiresIn: string;
  uses: number;
  singleUse: boolean;
}

interface AutomodRule {
  id: string;
  name: string;
  description: string;
  type: 'keyword' | 'spam' | 'link' | 'invite' | 'mention';
  enabled: boolean;
  actions: string[];
}

interface AdminState {
  serverName: string;
  serverDescription: string;
  serverRegion: string;
  roles: ManagedRole[];
  categories: Category[];
  members: User[];
  invites: InviteRecord[];
  rules: AutomodRule[];
  auditFilter: string;
}

const ROLE_COLORS = ['#FF2A6D', '#05FFA1', '#13DDEC', '#A855F7', '#F6F8F8'];

interface AuditEntry {
  id: string;
  action: string;
  user: string;
  target: string;
  timestamp: string;
  detail: string;
}

interface BotRecord {
  id: string;
  name: string;
  token?: string;
  created_at: string;
}

const actionColors: Record<string, string> = {
  CHANNEL_CREATE: 'text-accent-success',
  ROLE_UPDATE: 'text-accent-purple',
  MEMBER_BAN: 'text-accent-danger',
  MESSAGE_DELETE: 'text-accent-warning',
  SERVER_UPDATE: 'text-primary',
  INVITE_CREATE: 'text-primary',
};

const ruleTypeColors: Record<AutomodRule['type'], string> = {
  keyword: 'text-accent-danger',
  spam: 'text-accent-warning',
  link: 'text-primary',
  invite: 'text-accent-purple',
  mention: 'text-accent-success',
};

function isSettingsRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function normalizeSettingsText(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function normalizeSettingsStatus(value: unknown): User['status'] {
  return value === 'online' || value === 'idle' || value === 'dnd' || value === 'offline' ? value : 'offline';
}

function normalizeSettingsUser(value: unknown, fallbackId: string): User {
  if (!isSettingsRecord(value)) {
    return { id: fallbackId, username: fallbackId, avatar: '', status: 'offline' };
  }

  const id = normalizeSettingsText(value.id, fallbackId);
  return {
    id,
    username: normalizeSettingsText(value.username, id),
    avatar: typeof value.avatar === 'string' ? value.avatar : '',
    status: normalizeSettingsStatus(value.status),
    ...(typeof value.role === 'string' && value.role.trim() ? { role: value.role.trim() } : {}),
    ...(typeof value.color === 'string' && value.color.trim() ? { color: value.color.trim() } : {}),
    ...(typeof value.bio === 'string' && value.bio.trim() ? { bio: value.bio.trim() } : {}),
  };
}

function normalizeAdminMembers(value: unknown[]): User[] {
  const normalized: User[] = [];
  const seen = new Set<string>();

  for (const [index, member] of value.entries()) {
    const normalizedMember = normalizeSettingsUser(member, `member-${index}`);
    if (seen.has(normalizedMember.id)) {
      continue;
    }
    seen.add(normalizedMember.id);
    normalized.push(normalizedMember);
  }

  return normalized;
}

function normalizeCategoryText(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function normalizeServerChannel(value: unknown, fallbackId: string): Channel | null {
  if (!isSettingsRecord(value)) {
    return null;
  }

  const id = normalizeCategoryText(value.id, fallbackId);
  const name = normalizeCategoryText(value.name, id);
  const type = value.type === 'voice' || value.type === 'forum' || value.type === 'announcement' ? value.type : 'text';
  const categoryId = normalizeCategoryText(value.categoryId, '');
  if (!id || !categoryId) {
    return null;
  }

  return {
    id,
    name,
    type,
    categoryId,
    ...(typeof value.unreadCount === 'number' ? { unreadCount: value.unreadCount } : {}),
    ...(Array.isArray(value.activeUsers) ? { activeUsers: value.activeUsers.map((user, index) => normalizeSettingsUser(user, `member-${index}`)) } : {}),
  };
}

function normalizeServerCategory(value: unknown, fallbackId: string): Category | null {
  if (!isSettingsRecord(value)) {
    return null;
  }

  const id = normalizeCategoryText(value.id, fallbackId);
  const name = normalizeCategoryText(value.name, id);
  if (!id) {
    return null;
  }

  const seenChannels = new Set<string>();
  const channels = Array.isArray(value.channels)
    ? value.channels.reduce<Channel[]>((acc, channel, index) => {
      const normalizedChannel = normalizeServerChannel(channel, `channel-${index}`);
      if (!normalizedChannel || seenChannels.has(normalizedChannel.id)) {
        return acc;
      }
      seenChannels.add(normalizedChannel.id);
      acc.push(normalizedChannel);
      return acc;
    }, [])
    : [];

  return { id, name, channels };
}

function normalizeServerCategories(value: unknown): Category[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized: Category[] = [];
  const seen = new Set<string>();
  value.forEach((category, index) => {
    const normalizedCategory = normalizeServerCategory(category, `category-${index}`);
    if (!normalizedCategory || seen.has(normalizedCategory.id)) {
      return;
    }
    seen.add(normalizedCategory.id);
    normalized.push(normalizedCategory);
  });

  return normalized;
}

function createInitialAdminState(server: Server): AdminState {
  return {
    serverName: server.name,
    serverDescription: server.description ?? '',
    serverRegion: server.region ?? 'AUTO',
    roles: [
      {
        id: `${server.id}-role-admin`,
        name: 'Admin',
        color: '#FF2A6D',
        permissions: ['MANAGE_SERVER', 'MANAGE_CHANNELS', 'MANAGE_ROLES', 'KICK_MEMBERS', 'BAN_MEMBERS', 'MANAGE_MESSAGES', 'MANAGE_INVITES', 'SEND_MESSAGES', 'READ_MESSAGES'],
        protected: true,
      },
      {
        id: `${server.id}-role-member`,
        name: 'Member',
        color: '#13DDEC',
        permissions: ['SEND_MESSAGES', 'READ_MESSAGES', 'ADD_REACTIONS', 'ATTACH_FILES'],
        protected: false,
      },
    ],
    categories: normalizeServerCategories(server.categories),
    members: normalizeAdminMembers(server.members),
    // The real invite is the deeplink built from the live invite_secret (see
    // InvitesSection); there are no fake local invite records.
    invites: [],
    rules: [
      {
        id: `${server.id}-rule-spam`,
        name: 'Spam Filter',
        description: 'Block messages with repeated content or excessive mentions.',
        type: 'spam',
        enabled: true,
        actions: ['Delete message', 'Timeout 60s'],
      },
      {
        id: `${server.id}-rule-invite`,
        name: 'No External Invites',
        description: 'Block messages containing invite links to other Spaces.',
        type: 'invite',
        enabled: true,
        actions: ['Delete message', 'Alert moderator'],
      },
    ],
    auditFilter: 'all',
  };
}

export const ServerSettingsScreen: React.FC<ServerSettingsScreenProps> = ({ server, onClose }) => {
  const [activeSection, setActiveSection] = useState<SettingsSection>('overview');
  const [adminState, setAdminState] = useState(() => createInitialAdminState(server));
  const [feedback, setFeedback] = useState<FeedbackState | null>(null);
  const initializedServerIdRef = useRef(server.id);
  const [copiedInviteCode, setCopiedInviteCode] = useState<string | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<User | null>(null);
  // Real, shareable P2P invite: carries this server + its owner peer id (you, the
  // owner) so a joiner can dial you over the relay circuit and pull the server.
  const snapshot = useRuntimeSnapshot();
  const ownerPeerId = snapshot?.identity?.peer_id?.trim() ?? '';
  const createChannelMutation = useCreateChannel();
  const updateChannelMutation = useUpdateChannel();
  const deleteChannelMutation = useDeleteChannel();
  const createRoleMutation = useCreateRole();
  const updateRoleMutation = useUpdateRole();
  const deleteRoleMutation = useDeleteRole();
  const assignRoleMutation = useAssignRole();
  const moderationMutation = useModerationAction();
  // Roles derived from the live runtime snapshot (P2P-synced via sync.update).
  const snapshotRoles = useMemo<ManagedRole[]>(() => {
    const srv = snapshot?.servers?.find(s => s.id === server.id);
    if (srv?.roles && srv.roles.length > 0) {
      return srv.roles.map(r => ({
        id: r.id,
        name: r.name,
        color: r.color ?? '#13DDEC',
        permissions: r.permissions ?? [],
        protected: r.protected ?? false,
      }));
    }
    return adminState.roles;
  }, [snapshot, server.id, adminState.roles]);
  const mutations = useRuntimeMutations();
  // Real, shareable P2P invite minted from the LIVE store secret — the published
  // snapshot strips invite_secret, so it cannot be derived from render state.
  // Recomputed each render; rotate/revoke publish a fresh snapshot and re-render.
  const inviteDeepLink = mutations.inviteLink?.(server.id) ?? '';
  const hasRoles = useFeature('rolesManagement');
  const hasAuditLog = useFeature('auditLog');
  const hasAutoMod = useFeature('autoMod');
  const hasBotsFeature = useFeature('bots');
  // Audit log / automod / bots are served by the HTTP support node; when it is
  // unreachable these sections show an inline note (queries pause via mutations.ts).
  const { nodeOffline } = useNodeHealth();
  const nodeOfflineNote = nodeOffline ? (
    <div
      role="status"
      data-testid="node-offline-section-note"
      className="mb-4 rounded-r2 border border-accent-warning/30 bg-accent-warning/10 px-4 py-3 text-xs text-accent-warning"
    >
      {NODE_OFFLINE_MESSAGE}
    </div>
  ) : null;

  // Audit log / automod / bots — real queries backed by the control API.
  const auditLogQuery = useAuditLog(server.id, {
    action: adminState.auditFilter === 'all' ? undefined : adminState.auditFilter,
  });
  const autoModRulesQuery = useAutoModRules(server.id);
  const createAutoModRuleMutation = useCreateAutoModRule(server.id);
  const updateAutoModRuleMutation = useUpdateAutoModRule(server.id);
  const deleteAutoModRuleMutation = useDeleteAutoModRule(server.id);
  const botsQuery = useBots(server.id);
  const createBotMutation = useCreateBot(server.id);
  const deleteBotMutation = useDeleteBot(server.id);

  // Server management (delete, kick, edit, rotate invite) is owner-authoritative.
  // Gate the destructive/structural controls to the owner so members never see
  // actions that would no-op (and to match what the engine actually enforces).
  const serverOwnerPeerId = snapshot?.servers?.find((s) => s.id === server.id)?.owner_peer_id ?? '';
  const isOwner = !!ownerPeerId && ownerPeerId === serverOwnerPeerId;

  // Inline channel rename (real edit, not a stub): which channel is being renamed.
  const [channelEdit, setChannelEdit] = useState<{ id: string; name: string } | null>(null);

  // While the destructive-confirm dialog is open, Escape should dismiss only
  // the dialog (handled inside it) — not the whole settings screen.
  useEscapeKey(onClose, !pendingRemoval);

  useEffect(() => {
    if (initializedServerIdRef.current === server.id) {
      return;
    }

    initializedServerIdRef.current = server.id;
    setActiveSection('overview');
    setAdminState(createInitialAdminState(server));
    setFeedback(null);
    setCopiedInviteCode(null);
    setPendingRemoval(null);
    setChannelEdit(null);
  }, [server]);

  // Keep the channels/members/name lists LIVE from the runtime snapshot (via the
  // server prop) rather than a frozen mirror — so real channel/member changes (and
  // those pushed by other peers) show here, and actions operate on real ids.
  useEffect(() => {
    setAdminState((prev) => ({
      ...prev,
      serverName: server.name,
      serverDescription: server.description ?? '',
      categories: normalizeServerCategories(server.categories),
      members: normalizeAdminMembers(server.members),
    }));
  }, [server.name, server.description, server.categories, server.members]);

  useEffect(() => {
    if (!feedback) {
      return;
    }

    const timer = window.setTimeout(() => setFeedback(null), 2500);
    return () => window.clearTimeout(timer);
  }, [feedback]);

  useEffect(() => {
    if (!copiedInviteCode) {
      return;
    }

    const timer = window.setTimeout(() => setCopiedInviteCode(null), 1400);
    return () => window.clearTimeout(timer);
  }, [copiedInviteCode]);

  const showFeedback = (tone: FeedbackTone, message: string) => setFeedback({ tone, message });
  const showUnsupported = (message: string) => showFeedback('info', message);

  const handleCopyInvite = async () => {
    if (!inviteDeepLink) {
      showFeedback('error', 'No active invite — generate one first.');
      return;
    }
    if (await copyTextToClipboardSafely(inviteDeepLink)) {
      setCopiedInviteCode(inviteDeepLink);
      showFeedback('success', 'Invite link copied to clipboard.');
      return;
    }
    showUnsupported('Clipboard access is unavailable in this browser context; invite link was not copied.');
  };

  const handleCreateRole = async () => {
    const nextIndex = snapshotRoles.length;
    const roleName = `Custom Role ${nextIndex + 1}`;
    try {
      await createRoleMutation.mutateAsync({ serverId: server.id, roleName });
      showFeedback('success', `Created ${roleName} — synced P2P.`);
    } catch (error) {
      showFeedback('error', error instanceof Error ? error.message : 'Unable to create role.');
    }
  };

  const handleRenameRole = async (role: ManagedRole, name: string) => {
    const trimmed = name.trim();
    if (!trimmed || trimmed === role.name) return;
    try {
      await updateRoleMutation.mutateAsync({ serverId: server.id, roleId: role.id, patch: { name: trimmed } });
      showFeedback('success', `Renamed to ${trimmed} — synced P2P.`);
    } catch (error) {
      showFeedback('error', error instanceof Error ? error.message : 'Unable to rename role.');
    }
  };

  const handleDeleteRole = async (role: ManagedRole) => {
    if (role.protected) {
      showUnsupported(`${role.name} is a protected role and cannot be deleted.`);
      return;
    }
    try {
      await deleteRoleMutation.mutateAsync({ serverId: server.id, roleId: role.id });
      showFeedback('success', `Deleted ${role.name} — synced P2P.`);
    } catch (error) {
      showFeedback('error', error instanceof Error ? error.message : 'Unable to delete role.');
    }
  };

  const handleAddChannel = async (categoryId: string) => {
    if (!isOwner) { showUnsupported('Only the Space Owner can add channels.'); return; }
    const category = adminState.categories.find((entry) => entry.id === categoryId);
    // When no categories exist yet, create the first channel named 'general'.
    const nextIndex = category ? category.channels.length + 1 : 1;
    const name = nextIndex === 1 && !category ? 'general' : `new-${nextIndex}`;
    const voice = /voice/i.test(categoryId);
    try {
      await createChannelMutation.mutateAsync({ serverId: server.id, name, voice });
      // The live-sync effect picks up the real channel (with its real id) from the
      // snapshot — no synthetic local placeholder, so edit/delete target real ids.
      showFeedback('success', `Created #${name}.`);
    } catch (error) {
      showFeedback('error', error instanceof Error ? error.message : 'Unable to add channel.');
    }
  };

  const handleEditChannel = (channel: Channel) => {
    if (!isOwner) { showUnsupported('Only the Space Owner can edit channels.'); return; }
    setChannelEdit({ id: channel.id, name: channel.name });
  };

  const handleCommitChannelEdit = async () => {
    if (!channelEdit) return;
    const nextName = channelEdit.name.trim();
    const original = adminState.categories.flatMap((c) => c.channels).find((c) => c.id === channelEdit.id);
    if (!nextName || nextName === original?.name) { setChannelEdit(null); return; }
    try {
      await updateChannelMutation.mutateAsync({ serverId: server.id, channelId: channelEdit.id, patch: { name: nextName } });
      showFeedback('success', `Renamed channel to #${nextName}.`);
    } catch (error) {
      showFeedback('error', error instanceof Error ? error.message : 'Unable to rename channel.');
    } finally {
      setChannelEdit(null);
    }
  };

  const handleDeleteChannel = async (channel: Channel) => {
    if (!isOwner) { showUnsupported('Only the Space Owner can delete channels.'); return; }
    try {
      await deleteChannelMutation.mutateAsync({ serverId: server.id, channelId: channel.id });
      showFeedback('success', `Deleted #${channel.name}.`);
    } catch (error) {
      showFeedback('error', error instanceof Error ? error.message : 'Unable to delete channel.');
    }
  };

  const handleSaveServerMeta = async (patch: { name?: string; description?: string }) => {
    if (!isOwner) { showUnsupported('Only the Space Owner can edit Space details.'); return; }
    try {
      await mutations.updateServerMeta?.(server.id, patch);
      showFeedback('success', 'Space details updated.');
    } catch (error) {
      showFeedback('error', error instanceof Error ? error.message : 'Unable to update Space.');
    }
  };

  const handleDeleteServer = async () => {
    if (!isOwner) { showUnsupported('Only the Space Owner can delete this Space.'); return; }
    if (!safeConfirm(`Delete “${server.name}”? This permanently removes it for every member and cannot be undone.`)) return;
    try {
      await mutations.deleteServer?.(server.id);
      onClose();
    } catch (error) {
      showFeedback('error', error instanceof Error ? error.message : 'Unable to delete Space.');
    }
  };

  const handleRequestRemoveMember = (member: User) => {
    if (member.role === 'Admin' || member.id === server.ownerId || member.id === 'me') {
      showUnsupported(`${member.username} is a protected member and cannot be removed.`);
      return;
    }

    // Destructive: gate the removal behind an explicit confirmation step.
    setPendingRemoval(member);
  };

  const handleConfirmRemoveMember = async () => {
    const member = pendingRemoval;
    if (!member) {
      return;
    }
    setPendingRemoval(null);
    try {
      await mutations.removeMember?.(server.id, member.id);
      showFeedback('success', `${member.username} was removed from the Space.`);
    } catch (error) {
      showFeedback('error', error instanceof Error ? error.message : 'Unable to remove member.');
    }
  };

  // "Generate/rotate" mints a fresh invite secret — this invalidates every old link
  // and the displayed deeplink updates from the new secret. Real, owner-only.
  const handleRotateInvite = async () => {
    if (!isOwner) { showUnsupported('Only the Space Owner can manage invites.'); return; }
    try {
      await mutations.rotateInvite?.(server.id);
      showFeedback('success', 'Invite link rotated — previous links no longer work.');
    } catch (error) {
      showFeedback('error', error instanceof Error ? error.message : 'Unable to rotate invite.');
    }
  };

  // Revoke closes the server: the invite secret is cleared, so no link is accepted
  // until a new one is minted.
  const handleRevokeInvite = async () => {
    if (!isOwner) { showUnsupported('Only the Space Owner can manage invites.'); return; }
    if (!safeConfirm('Revoke invites? Existing links stop working until you generate a new one.')) return;
    try {
      await mutations.revokeInvite?.(server.id);
      showFeedback('info', 'Invites revoked. The Space is now closed to new links.');
    } catch (error) {
      showFeedback('error', error instanceof Error ? error.message : 'Unable to revoke invites.');
    }
  };

  /** Audit/automod/bots are node-backed: refuse mutations with the canonical
   * message while the node is offline instead of surfacing a raw transport error. */
  const guardNodeOffline = (): boolean => {
    if (!nodeOffline) return false;
    showFeedback('error', NODE_OFFLINE_MESSAGE);
    return true;
  };

  const handleCreateRule = async () => {
    if (guardNodeOffline()) return;
    const name = `Custom Rule ${(autoModRulesQuery.data?.length ?? 0) + 1}`;
    try {
      await createAutoModRuleMutation.mutateAsync({ name, type: 'keyword', enabled: false, actions: ['delete'] });
      await autoModRulesQuery.refetch();
      showFeedback('success', `Created ${name}.`);
    } catch (error) {
      showFeedback('error', error instanceof Error ? error.message : 'Unable to create rule.');
    }
  };

  const toggleRule = async (id: string) => {
    if (guardNodeOffline()) return;
    const rule = autoModRulesQuery.data?.find((r) => r.id === id);
    if (!rule) return;
    const nextEnabled = !rule.enabled;
    try {
      await updateAutoModRuleMutation.mutateAsync({ ruleId: id, patch: { enabled: nextEnabled } });
      await autoModRulesQuery.refetch();
      showFeedback('success', `${rule.name} ${nextEnabled ? 'enabled' : 'disabled'}.`);
    } catch (error) {
      showFeedback('error', error instanceof Error ? error.message : 'Unable to update rule.');
    }
  };

  const handleDeleteRule = async (id: string) => {
    if (guardNodeOffline()) return;
    const rule = autoModRulesQuery.data?.find((r) => r.id === id);
    if (!rule) return;
    try {
      await deleteAutoModRuleMutation.mutateAsync({ ruleId: id });
      await autoModRulesQuery.refetch();
      showFeedback('success', `${rule.name} deleted.`);
    } catch (error) {
      showFeedback('error', error instanceof Error ? error.message : 'Unable to delete rule.');
    }
  };

  const filteredAuditEntries: AuditEntry[] = (auditLogQuery.data ?? []).map((e) => ({
    id: e.id,
    action: e.action,
    user: e.actor_peer_id,
    target: e.target ?? '',
    timestamp: e.created_at,
    detail: e.detail ?? '',
  }));

  const autoModRules: AutomodRule[] = (autoModRulesQuery.data ?? []).map((r) => ({
    id: r.id,
    name: r.name,
    description: r.keyword_patterns?.length ? `Patterns: ${r.keyword_patterns.join(', ')}` : `${r.type} rule`,
    type: r.type as AutomodRule['type'],
    enabled: r.enabled,
    actions: r.actions,
  }));

  const sections: { id: SettingsSection; label: string; icon: React.ReactNode }[] = [
    { id: 'overview', label: 'Overview', icon: <Settings size={16} /> },
    ...(hasRoles ? [{ id: 'roles' as SettingsSection, label: 'Roles', icon: <Shield size={16} /> }] : []),
    { id: 'channels', label: 'Channels', icon: <Hash size={16} /> },
    { id: 'members', label: 'Members', icon: <Users size={16} /> },
    { id: 'invites', label: 'Invites', icon: <Link size={16} /> },
    // Reports inbox is owner-only — reports are delivered P2P to the server owner.
    ...(isOwner ? [{ id: 'reports' as SettingsSection, label: 'Reports', icon: <Flag size={16} /> }] : []),
    ...(hasAuditLog ? [{ id: 'audit-log' as SettingsSection, label: 'Audit Log', icon: <FileText size={16} /> }] : []),
    ...(hasAutoMod ? [{ id: 'automod' as SettingsSection, label: 'AutoMod', icon: <ShieldAlert size={16} /> }] : []),
    ...(hasBotsFeature ? [{ id: 'bots' as SettingsSection, label: 'Bots', icon: <Bot size={16} /> }] : []),
  ];

  return (
    <div className="absolute inset-0 z-[100] bg-bg-0 flex flex-col md:flex-row text-white/70 animate-in fade-in zoom-in-95 duration-300 overflow-hidden">
      <div className="hidden md:flex w-[224px] bg-bg-1 flex-col items-end py-10 px-5 border-r border-white/5">
        <div className="w-full space-y-1.5">
          <div className="micro-label text-white/20 px-3 mb-3">SPACE // CONFIGURATION</div>
          {sections.map((section) => (
            <button
              key={section.id}
              onClick={() => setActiveSection(section.id)}
              className={`flex items-center gap-2.5 px-3 py-2.5 rounded-r1 w-full cursor-pointer transition-all border ${
                activeSection === section.id
                  ? 'bg-primary/10 border-primary/20 text-white shadow-inner'
                  : 'border-transparent text-white/40 hover:bg-white/5 hover:text-white'
              }`}
            >
              <div className={activeSection === section.id ? 'text-primary' : ''}>{section.icon}</div>
              <span className="font-bold text-xs tracking-tight">{section.label}</span>
            </button>
          ))}

          {isOwner && (
            <>
              <div className="h-6" />
              <div className="border-t border-white/5 my-3 mx-3" />
              <button
                onClick={() => void handleDeleteServer()}
                className="flex items-center gap-2.5 px-3 py-2 rounded-r1 w-full text-accent-danger hover:bg-accent-danger/10 transition-all micro-label"
              >
                <Trash2 size={16} />
                <span>Delete Space</span>
              </button>
            </>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto bg-bg-2 grid-overlay">
        {/* `.grid-overlay` sets `pointer-events: none`; that property inherits, so
            without re-enabling it here every field/button below becomes unclickable. */}
        <div className="max-w-[640px] mx-auto py-12 px-6 md:px-10 pointer-events-auto">
          {feedback && <FeedbackBanner feedback={feedback} />}

          {activeSection === 'overview' && (
            <OverviewSection
              serverId={server.id}
              serverName={adminState.serverName}
              serverDescription={adminState.serverDescription}
              serverRegion={adminState.serverRegion}
              memberCount={adminState.members.length}
              canEdit={isOwner}
              onSave={handleSaveServerMeta}
            />
          )}

          {activeSection === 'roles' && (
            <RolesSection
              roles={snapshotRoles}
              onCreateRole={() => void handleCreateRole()}
              onRenameRole={handleRenameRole}
              onDeleteRole={(role) => void handleDeleteRole(role)}
            />
          )}

          {activeSection === 'channels' && (
            <ChannelsSection
              categories={adminState.categories}
              canManage={isOwner}
              channelEdit={channelEdit}
              onAddChannel={(categoryId) => void handleAddChannel(categoryId)}
              onEditChannel={handleEditChannel}
              onChangeEditName={(name) => setChannelEdit((prev) => (prev ? { ...prev, name } : prev))}
              onCommitEdit={() => void handleCommitChannelEdit()}
              onCancelEdit={() => setChannelEdit(null)}
              onDeleteChannel={(channel) => void handleDeleteChannel(channel)}
            />
          )}

          {activeSection === 'members' && (
            <MembersSection
              members={adminState.members}
              canManage={isOwner}
              ownerPeerId={serverOwnerPeerId}
              onRemoveMember={handleRequestRemoveMember}
            />
          )}

          {activeSection === 'invites' && (
            <InvitesSection
              inviteDeepLink={inviteDeepLink}
              canManage={isOwner}
              onCopyInvite={() => void handleCopyInvite()}
              onRotateInvite={() => void handleRotateInvite()}
              onRevokeInvite={() => void handleRevokeInvite()}
            />
          )}

          {activeSection === 'reports' && isOwner && (
            <ReportInbox serverId={server.id} />
          )}

          {activeSection === 'audit-log' && hasAuditLog && (
            <>
              {nodeOfflineNote}
              <AuditLogSection
                filter={adminState.auditFilter}
                onChangeFilter={(filter) => setAdminState((prev) => ({ ...prev, auditFilter: filter }))}
                entries={filteredAuditEntries}
              />
            </>
          )}

          {activeSection === 'automod' && hasAutoMod && (
            <>
              {nodeOfflineNote}
              <AutoModSection
                rules={autoModRules}
                onCreateRule={() => void handleCreateRule()}
                onToggleRule={(id) => void toggleRule(id)}
                onDeleteRule={(id) => void handleDeleteRule(id)}
              />
            </>
          )}

          {activeSection === 'bots' && hasBotsFeature && (
            <>
            {nodeOfflineNote}
            <BotManagementSection
              bots={(botsQuery.data ?? []).map((b) => ({ id: b.id, name: b.name, token: b.token, created_at: b.created_at }))}
              onCreate={async (name) => {
                if (nodeOffline) throw new Error(NODE_OFFLINE_MESSAGE);
                const result = await createBotMutation.mutateAsync({ name });
                await botsQuery.refetch();
                return { id: result.id, name: result.name, token: result.token, created_at: result.created_at };
              }}
              onDelete={async (botId) => {
                if (nodeOffline) throw new Error(NODE_OFFLINE_MESSAGE);
                await deleteBotMutation.mutateAsync({ botId });
                await botsQuery.refetch();
              }}
            />
            </>
          )}
        </div>
      </div>

      {pendingRemoval && (
        <RemoveMemberConfirm
          member={pendingRemoval}
          onCancel={() => setPendingRemoval(null)}
          onConfirm={handleConfirmRemoveMember}
        />
      )}

      <div className="absolute top-6 right-6 flex flex-col items-center gap-1.5 group cursor-pointer z-[110]" onClick={onClose}>
        <div className="w-10 h-10 rounded-full border border-white/10 glass-panel flex items-center justify-center group-hover:border-primary group-hover:shadow-glow transition-all">
          <X size={20} className="text-white group-hover:text-primary" />
        </div>
        <span className="micro-label text-[7px] text-white/20 group-hover:text-white">ESC</span>
      </div>
    </div>
  );
};

const RemoveMemberConfirm: React.FC<{
  member: User;
  onCancel: () => void;
  onConfirm: () => void;
}> = ({ member, onCancel, onConfirm }) => {
  useEscapeKey(onCancel);

  return (
    <div
      className="absolute inset-0 z-[120] flex items-center justify-center bg-bg-0/70 backdrop-blur-sm animate-in fade-in duration-200"
      onClick={onCancel}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="remove-member-title"
        aria-describedby="remove-member-desc"
        className="glass-panel rounded-r2 border border-accent-danger/30 w-[360px] max-w-[90vw] p-6 shadow-glow animate-in zoom-in-95 duration-200"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center gap-2.5 mb-3">
          <AlertTriangle size={18} className="text-accent-danger" />
          <h3 id="remove-member-title" className="text-sm font-bold text-white font-display tracking-tight">
            Remove member?
          </h3>
        </div>
        <p id="remove-member-desc" className="text-xs text-white/50 leading-relaxed mb-5">
          This removes <span className="text-white font-medium">{member.username}</span> from this Space. They
          will lose access until invited again.
        </p>
        <div className="flex items-center justify-end gap-2.5">
          <button
            type="button"
            onClick={onCancel}
            className="focus-ring px-4 py-2 rounded-full text-[11px] font-bold text-white/60 hover:text-white border border-white/10 hover:bg-white/5 transition-all"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="focus-ring px-4 py-2 rounded-full text-[11px] font-bold text-bg-0 bg-accent-danger hover:shadow-glow-sm transition-all"
          >
            Remove member
          </button>
        </div>
      </div>
    </div>
  );
};

const FeedbackBanner: React.FC<{ feedback: FeedbackState }> = ({ feedback }) => (
  <div className={`rounded-r2 border px-4 py-3 text-xs mb-6 ${feedback.tone === 'error' ? 'border-accent-danger/30 bg-accent-danger/10 text-accent-danger' : feedback.tone === 'success' ? 'border-accent-success/30 bg-accent-success/10 text-accent-success' : 'border-primary/30 bg-primary/10 text-primary'}`}>
    {feedback.message}
  </div>
);

const OverviewSection: React.FC<{
  serverId: string;
  serverName: string;
  serverDescription: string;
  serverRegion: string;
  memberCount: number;
  canEdit: boolean;
  onSave: (patch: { name?: string; description?: string }) => void | Promise<void>;
}> = ({ serverId, serverName, serverDescription, serverRegion, memberCount, canEdit, onSave }) => {
  const [name, setName] = useState(serverName);
  const [description, setDescription] = useState(serverDescription);
  // Re-sync drafts when the live values change (and we're not mid-edit on them).
  useEffect(() => { setName(serverName); }, [serverName]);
  useEffect(() => { setDescription(serverDescription); }, [serverDescription]);
  const dirty = name.trim() !== serverName || description.trim() !== (serverDescription ?? '');

  return (
    <>
      <header className="mb-10">
        <h2 className="text-[26px] font-bold text-white mb-2 font-display tracking-tight">SPACE // OVERVIEW</h2>
        <p className="micro-label text-white/30">CONFIGURATION // IDENTITY // REGION</p>
      </header>

      <div className="glass-card rounded-r2 overflow-hidden mb-6 border border-white/10">
        <div className="h-[100px] bg-gradient-to-r from-primary/10 via-primary/5 to-accent-purple/10 relative">
          <div className="absolute inset-0 grid-overlay opacity-30" />
        </div>
        <div className="px-6 pb-6 -mt-10 flex items-end gap-5">
          <div className="w-20 h-20 rounded-r2 border-[5px] border-bg-2 bg-bg-1 overflow-hidden shadow-xl flex items-center justify-center">
            <Shield size={28} className="text-primary" />
          </div>
          <div className="mb-1.5">
            <div className="text-lg font-bold text-white font-display leading-tight">{serverName}</div>
            <div className="text-primary/60 font-mono text-[10px] tracking-widest mt-1 uppercase">ID // {serverId.toUpperCase()}</div>
          </div>
        </div>

        <div className="px-6 py-5 space-y-5">
          <div>
            <label className="micro-label text-white/20 mb-1.5 block" htmlFor="server-name-input">Space Name</label>
            <input
              id="server-name-input"
              type="text"
              value={name}
              disabled={!canEdit}
              onChange={(e) => setName(e.target.value)}
              className="focus-ring w-full bg-surface-dark border border-white/10 rounded-r1 px-4 py-2.5 text-sm text-white placeholder:text-white/25 disabled:opacity-50"
            />
          </div>
          <div>
            <label className="micro-label text-white/20 mb-1.5 block" htmlFor="server-desc-input">Description</label>
            <textarea
              id="server-desc-input"
              value={description}
              disabled={!canEdit}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="No description set."
              rows={2}
              className="focus-ring w-full bg-surface-dark border border-white/10 rounded-r1 px-4 py-2.5 text-sm text-white placeholder:text-white/25 resize-none disabled:opacity-50"
            />
          </div>
          <FieldRow label="Region" value={serverRegion || 'AUTO'} />
          <FieldRow label="Members" value={`${memberCount} entities`} />
          {canEdit && (
            <div className="flex justify-end pt-1">
              <button
                type="button"
                disabled={!dirty}
                onClick={() => onSave({ name: name.trim(), description: description.trim() })}
                className="px-4 py-2 rounded-full text-[11px] font-bold bg-primary text-bg-0 hover:shadow-glow-sm transition-all disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Save changes
              </button>
            </div>
          )}
        </div>
      </div>
    </>
  );
};

const RoleRow: React.FC<{ role: ManagedRole; onRename: (role: ManagedRole, name: string) => void; onDelete: (role: ManagedRole) => void }> = ({ role, onRename, onDelete }) => {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(role.name);

  const commit = () => {
    setEditing(false);
    onRename(role, draft);
  };

  return (
    <div className="glass-card rounded-r2 p-4 flex items-center justify-between group hover:border-primary/20 transition-all border border-white/8">
      <div className="flex items-center gap-3 flex-1 min-w-0">
        <div className="w-3.5 h-3.5 rounded-full flex-shrink-0" style={{ backgroundColor: role.color, boxShadow: `0 0 8px ${role.color}50` }} />
        <div className="flex-1 min-w-0">
          {editing && !role.protected ? (
            <input
              autoFocus
              aria-label={`Rename ${role.name}`}
              value={draft}
              onChange={e => setDraft(e.target.value)}
              onBlur={commit}
              onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') { setEditing(false); setDraft(role.name); } }}
              className="w-full bg-transparent border-b border-primary/40 text-white font-bold text-xs focus:outline-none pb-0.5"
            />
          ) : (
            <div className="flex items-center gap-2">
              <button onClick={() => !role.protected && setEditing(true)} className="text-white font-bold text-xs hover:text-primary transition-colors text-left" aria-label={`Edit name of ${role.name}`}>{role.name}</button>
              {role.protected && <span className="text-[8px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-full border border-white/10 text-white/25 bg-white/5">protected</span>}
            </div>
          )}
          <div className="text-[9px] text-white/30 font-mono">
            {role.permissions.length > 0 ? role.permissions.join(' · ') : 'DEFAULT // PERMISSIONS'}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
        {!role.protected && (
          <button onClick={() => onDelete(role)} aria-label={`Delete ${role.name}`} title={`Delete ${role.name}`} className="p-1.5 rounded-full hover:bg-accent-danger/10 text-white/40 hover:text-accent-danger transition-all"><Trash2 size={12} /></button>
        )}
      </div>
    </div>
  );
};

const RolesSection: React.FC<{
  roles: ManagedRole[];
  onCreateRole: () => void;
  onRenameRole: (role: ManagedRole, name: string) => void;
  onDeleteRole: (role: ManagedRole) => void;
}> = ({ roles, onCreateRole, onRenameRole, onDeleteRole }) => {


  return (
    <>
      <header className="mb-10">
        <h2 className="text-[26px] font-bold text-white mb-2 font-display tracking-tight">ROLES // HIERARCHY</h2>
        <p className="micro-label text-white/30">PERMISSION // MATRIX // CONTROL</p>
      </header>

      <div className="flex items-center justify-between mb-5">
        <span className="micro-label text-white/30">CONFIGURED ROLES // {roles.length}</span>
        <button onClick={onCreateRole} className="flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-stroke-primary text-primary text-[10px] font-bold hover:bg-primary/10 transition-all">
          <Plus size={12} /> Create Role
        </button>
      </div>

      <div className="space-y-2.5">
        {roles.map((role) => (
          <RoleRow key={role.id} role={role} onRename={onRenameRole} onDelete={onDeleteRole} />
        ))}
      </div>
    </>
  );
};

const ChannelsSection: React.FC<{
  categories: Category[];
  canManage: boolean;
  channelEdit: { id: string; name: string } | null;
  onAddChannel: (categoryId: string) => void;
  onEditChannel: (channel: Channel) => void;
  onChangeEditName: (name: string) => void;
  onCommitEdit: () => void;
  onCancelEdit: () => void;
  onDeleteChannel: (channel: Channel) => void;
}> = ({ categories, canManage, channelEdit, onAddChannel, onEditChannel, onChangeEditName, onCommitEdit, onCancelEdit, onDeleteChannel }) => (
  <>
    <header className="mb-10">
      <h2 className="text-[26px] font-bold text-white mb-2 font-display tracking-tight">CHANNELS // MAP</h2>
      <p className="micro-label text-white/30">TOPOLOGY // STRUCTURE // ROUTING</p>
    </header>

    {!canManage && (
      <p className="text-[11px] text-white/30 mb-5">Only the Space Owner can add, rename, or remove channels.</p>
    )}

    {categories.length === 0 && (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <Hash size={32} className="text-white/10 mb-3" />
        <p className="text-white/40 text-xs mb-4">No channels yet.</p>
        {canManage && (
          <button
            onClick={() => onAddChannel(`${Date.now()}-text`)}
            className="flex items-center gap-1.5 px-4 py-2 rounded-r1 bg-primary/10 border border-primary/20 text-primary text-xs hover:bg-primary/20 transition-all"
          >
            <Plus size={12} /> Add Channel
          </button>
        )}
      </div>
    )}

    {categories.map((category) => (
      <div key={category.id} className="mb-6">
        <div className="flex items-center justify-between mb-3">
          <span className="micro-label text-white/40">{category.name}</span>
          {canManage && (
            <button onClick={() => onAddChannel(category.id)} className="flex items-center gap-1 text-primary text-[10px] hover:underline"><Plus size={10} /> Add Channel</button>
          )}
        </div>
        <div className="space-y-1.5">
          {category.channels.map((channel) => {
            const editing = channelEdit?.id === channel.id;
            return (
            <div key={channel.id} className="glass-card rounded-r1 px-4 py-3 flex items-center justify-between group border border-white/5 hover:border-primary/20 transition-all">
              <div className="flex items-center gap-2.5 flex-1 min-w-0">
                {channel.type === 'voice' ? <Volume2 size={14} className="text-accent-success" /> : <Hash size={14} className="text-primary" />}
                {editing ? (
                  <input
                    autoFocus
                    value={channelEdit?.name ?? ''}
                    onChange={(e) => onChangeEditName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') onCommitEdit(); if (e.key === 'Escape') onCancelEdit(); }}
                    onBlur={onCommitEdit}
                    aria-label={`Rename ${channel.name}`}
                    className="focus-ring flex-1 min-w-0 bg-surface-dark border border-primary/30 rounded px-2 py-1 text-xs text-white"
                  />
                ) : (
                  <>
                    <span className="text-white text-xs font-medium truncate">{channel.name}</span>
                    <span className="text-[8px] font-mono text-white/20 uppercase">{channel.type}</span>
                  </>
                )}
              </div>
              {canManage && !editing && (
                <div className="flex items-center gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button onClick={() => onEditChannel(channel)} aria-label={`Edit ${channel.name}`} title={`Edit ${channel.name}`} className="p-1.5 rounded-full hover:bg-white/5 text-white/40 hover:text-primary transition-all"><Pencil size={12} /></button>
                  <button onClick={() => onDeleteChannel(channel)} aria-label={`Delete ${channel.name}`} title={`Delete ${channel.name}`} className="p-1.5 rounded-full hover:bg-accent-danger/10 text-white/40 hover:text-accent-danger transition-all"><Trash2 size={12} /></button>
                </div>
              )}
            </div>
            );
          })}
        </div>
      </div>
    ))}
  </>
);

const MembersSection: React.FC<{
  members: User[];
  canManage: boolean;
  ownerPeerId: string;
  onRemoveMember: (member: User) => void;
}> = ({ members, canManage, ownerPeerId, onRemoveMember }) => {
  const [query, setQuery] = useState('');

  const getRoleBadge = (user: User) => {
    const isAdmin = user.role === 'Admin';
    const color = isAdmin ? '#FF2A6D' : '#F6F8F8';

    return (
      <span
        className="text-[8px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-full border"
        style={{ color, borderColor: `${color}40`, backgroundColor: `${color}15` }}
      >
        {isAdmin ? 'Admin' : 'Member'}
      </span>
    );
  };

  const normalizedQuery = query.trim().toLowerCase();
  const filteredMembers = useMemo(() => {
    if (!normalizedQuery) {
      return members;
    }
    return members.filter((member) =>
      member.username.toLowerCase().includes(normalizedQuery) ||
      (member.role ?? '').toLowerCase().includes(normalizedQuery) ||
      (member.bio ?? '').toLowerCase().includes(normalizedQuery),
    );
  }, [members, normalizedQuery]);

  return (
    <>
      <header className="mb-10">
        <h2 className="text-[26px] font-bold text-white mb-2 font-display tracking-tight">MEMBERS // REGISTRY</h2>
        <p className="micro-label text-white/30">ENTITIES // {members.length} // CONNECTED</p>
      </header>

      <div className="relative mb-5">
        <Search size={14} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-white/30 pointer-events-none" />
        <input
          type="text"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search members by name, role, or status"
          aria-label="Search members"
          className="focus-ring w-full bg-surface-dark border border-white/10 rounded-full pl-10 pr-4 py-2.5 text-xs text-white placeholder:text-white/25"
        />
      </div>

      <div className="space-y-1.5">
        {filteredMembers.map((member) => (
          <div key={member.id} className="glass-card rounded-r1 px-4 py-3 flex items-center justify-between group border border-white/5 hover:border-primary/20 transition-all">
            <div className="flex items-center gap-3">
              <img src={resolveAvatarSrc(member.avatar, member.username)} className="w-8 h-8 rounded-full border border-white/10" alt={member.username} />
              <div>
                <div className="flex items-center gap-1.5">
                  <span className="text-white font-bold text-xs" style={{ color: member.color || '#F6F8F8' }}>{member.username}</span>
                  {(member.id === ownerPeerId || member.id === 'me') && <Crown size={10} className="text-accent-warning" />}
                </div>
                <div className="text-[9px] text-white/30 font-mono">{member.bio || 'No status set.'}</div>
              </div>
            </div>
            <div className="flex items-center gap-2.5">
              {getRoleBadge(member)}
              {canManage && member.id !== ownerPeerId && member.id !== 'me' && (
                <button onClick={() => onRemoveMember(member)} aria-label={`Remove ${member.username}`} title={`Remove ${member.username}`} className="p-1.5 rounded-full hover:bg-accent-danger/10 text-white/40 hover:text-accent-danger transition-all opacity-0 group-hover:opacity-100">
                  <Trash2 size={12} />
                </button>
              )}
            </div>
          </div>
        ))}
        {members.length > 0 && filteredMembers.length === 0 && (
          <div className="glass-card rounded-r1 px-4 py-8 border border-white/5 text-center">
            <div className="text-white/30 text-xs">No members match &ldquo;{query.trim()}&rdquo;</div>
          </div>
        )}
      </div>
    </>
  );
};

const InvitesSection: React.FC<{
  inviteDeepLink: string;
  canManage: boolean;
  onCopyInvite: () => void;
  onRotateInvite: () => void;
  onRevokeInvite: () => void;
}> = ({ inviteDeepLink, canManage, onCopyInvite, onRotateInvite, onRevokeInvite }) => (
  <>
    <header className="mb-10">
      <h2 className="text-[26px] font-bold text-white mb-2 font-display tracking-tight">INVITES // GATEWAY</h2>
      <p className="micro-label text-white/30">ACCESS // LINK // DISTRIBUTION</p>
    </header>

    <div className="glass-card rounded-r2 p-5 border border-white/10 mb-6">
      <div className="micro-label text-white/30 mb-3">SHAREABLE // INVITE LINK</div>
      <div className="flex items-center gap-2.5">
        <div className="flex-1 bg-surface-dark rounded-full px-4 py-2.5 border border-white/5 font-mono text-xs text-primary truncate">
          {inviteDeepLink || 'NO ACTIVE INVITE — GENERATE ONE'}
        </div>
        <button
          type="button"
          aria-label="Copy invite link"
          onClick={onCopyInvite}
          disabled={!inviteDeepLink}
          className="px-4 py-2.5 rounded-full font-bold text-xs micro-label tracking-tight transition-all bg-primary text-bg-0 hover:shadow-glow-sm disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Copy size={14} />
        </button>
      </div>
      <p className="mt-3 text-[10px] text-white/30 leading-relaxed">
        Anyone with this link can join. It carries your peer id so they can reach you over the relay, plus a capability token that grants channel history. Rotate it to invalidate every previously shared link.
      </p>
      {canManage ? (
        <div className="flex items-center gap-2.5 mt-4">
          <button onClick={onRotateInvite} className="flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-stroke-primary text-primary text-[10px] font-bold hover:bg-primary/10 transition-all">
            <Plus size={12} /> {inviteDeepLink ? 'Rotate Link' : 'Generate Link'}
          </button>
          {inviteDeepLink && (
            <button onClick={onRevokeInvite} className="px-3 py-1.5 rounded-full border border-white/10 text-[10px] font-bold text-white/60 hover:text-accent-danger hover:border-accent-danger/30 hover:bg-accent-danger/10 transition-all">
              Revoke
            </button>
          )}
        </div>
      ) : (
        <p className="mt-4 text-[10px] text-white/25">Only the Space Owner can rotate or revoke invites.</p>
      )}
    </div>
  </>
);

const FieldRow: React.FC<{ label: string; value: string; onModify?: () => void }> = ({ label, value, onModify }) => (
  <div className="flex justify-between items-center py-3 border-b border-white/5 group">
    <div>
      <div className="micro-label text-white/20 mb-1">{label}</div>
      <div className="text-white font-medium text-sm">{value}</div>
    </div>
    {onModify && (
      <button onClick={onModify} className="px-3 py-1 rounded-full bg-white/5 border border-white/5 hover:border-primary/40 hover:bg-primary/10 hover:text-primary text-[10px] transition-all">
        Modify
      </button>
    )}
  </div>
);

const AuditLogSection: React.FC<{
  filter: string;
  onChangeFilter: (filter: string) => void;
  entries: AuditEntry[];
}> = ({ filter, onChangeFilter, entries }) => {
  const actions = ['all', 'CHANNEL_CREATE', 'ROLE_UPDATE', 'MEMBER_BAN', 'MESSAGE_DELETE', 'SERVER_UPDATE', 'INVITE_CREATE'];

  return (
    <>
      <header className="mb-10">
        <h2 className="text-[26px] font-bold text-white mb-2 font-display tracking-tight">AUDIT // LOG</h2>
        <p className="micro-label text-white/30">ACTIONS // HISTORY // TRANSPARENCY</p>
      </header>

      <div className="flex items-center gap-2 mb-6 flex-wrap">
        <Filter size={12} className="text-white/30" />
        {actions.map((action) => (
          <button
            key={action}
            onClick={() => onChangeFilter(action)}
            className={`px-3 py-1.5 rounded-full text-[9px] font-bold uppercase tracking-wider border transition-all ${
              filter === action
                ? 'bg-primary/15 border-primary/30 text-primary'
                : 'bg-white/3 border-white/5 text-white/30 hover:bg-white/5 hover:text-white/50'
            }`}
          >
            {action === 'all' ? 'All' : action.replace('_', ' ')}
          </button>
        ))}
      </div>

      <div className="space-y-2">
        {entries.map((entry) => (
          <div key={entry.id} className="glass-card rounded-r2 p-4 border border-white/5 hover:border-white/10 transition-all group">
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <span className={`text-[9px] font-bold uppercase tracking-wider ${actionColors[entry.action] || 'text-white/40'}`}>{entry.action.replace('_', ' ')}</span>
                  <span className="text-[8px] font-mono text-white/15">by</span>
                  <span className="text-[10px] font-bold text-white/70">{entry.user}</span>
                </div>
                <p className="text-[11px] text-white/50">{entry.detail}</p>
                <div className="flex items-center gap-2 mt-1.5">
                  <span className="text-[9px] font-mono text-white/20">TARGET: {entry.target}</span>
                </div>
              </div>
              <div className="flex items-center gap-1.5 text-[8px] font-mono text-white/15 flex-shrink-0">
                <Clock size={10} />
                {entry.timestamp}
              </div>
            </div>
          </div>
        ))}
      </div>

      {entries.length === 0 && (
        <div className="text-center py-16">
          <FileText size={32} className="mx-auto text-white/10 mb-3" />
          <p className="text-xs text-white/20">No matching audit entries</p>
        </div>
      )}
    </>
  );
};

const AutoModSection: React.FC<{
  rules: AutomodRule[];
  onCreateRule: () => void;
  onToggleRule: (id: string) => void;
  onDeleteRule?: (id: string) => void;
}> = ({ rules, onCreateRule, onToggleRule, onDeleteRule }) => (
  <>
    <header className="mb-10">
      <h2 className="text-[26px] font-bold text-white mb-2 font-display tracking-tight">AUTOMOD // SHIELD</h2>
      <p className="micro-label text-white/30">AUTOMATED // MODERATION // RULES</p>
    </header>

    <div className="flex items-center justify-between mb-5">
      <span className="micro-label text-white/30">ACTIVE RULES // {rules.filter((rule) => rule.enabled).length}/{rules.length}</span>
      <button onClick={onCreateRule} className="flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-stroke-primary text-primary text-[10px] font-bold hover:bg-primary/10 transition-all">
        <Plus size={12} /> Create Rule
      </button>
    </div>

    <div className="space-y-3">
      {rules.map((rule) => (
        <div key={rule.id} className={`glass-card rounded-r2 p-4 border transition-all ${rule.enabled ? 'border-white/8' : 'border-white/5 opacity-50'}`}>
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1">
              <div className="flex items-center gap-2 mb-1.5">
                <ShieldAlert size={14} className={ruleTypeColors[rule.type] || 'text-white/40'} />
                <span className="text-sm font-bold text-white">{rule.name}</span>
                <span className={`text-[8px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-full border ${ruleTypeColors[rule.type]} bg-white/3 border-white/5`}>
                  {rule.type}
                </span>
              </div>
              <p className="text-[11px] text-white/40 mb-3">{rule.description}</p>
              <div className="flex flex-wrap gap-1.5">
                {rule.actions.map((action, index) => (
                  <span key={index} className="px-2 py-0.5 rounded-full bg-white/5 text-[9px] font-mono text-white/30 border border-white/5">
                    {action}
                  </span>
                ))}
              </div>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              {onDeleteRule && (
                <button
                  onClick={() => onDeleteRule(rule.id)}
                  aria-label={`Delete ${rule.name}`}
                  className="p-1.5 rounded-full hover:bg-accent-danger/10 text-white/30 hover:text-accent-danger transition-all"
                >
                  <Trash2 size={12} />
                </button>
              )}
              <button
                onClick={() => onToggleRule(rule.id)}
                className={`w-10 h-6 rounded-full transition-all relative ${rule.enabled ? 'bg-primary/30' : 'bg-white/10'}`}
              >
                <div className={`absolute top-1 w-4 h-4 rounded-full transition-all ${rule.enabled ? 'left-5 bg-primary shadow-glow-sm' : 'left-1 bg-white/30'}`} />
              </button>
            </div>
          </div>
        </div>
      ))}
    </div>

    <div className="mt-8">
      <div className="micro-label text-white/30 mb-3">AUTOMOD // RULES</div>
      <div className="grid grid-cols-3 gap-3">
        {[
          { label: 'ACTIVE', value: String(rules.filter((r) => r.enabled).length), icon: <ShieldAlert size={14} /> },
          { label: 'TOTAL', value: String(rules.length), icon: <Ban size={14} /> },
          { label: 'ENFORCING', value: String(rules.filter((r) => r.enabled && r.actions.some((a) => /block|delete|timeout/i.test(a))).length), icon: <Clock size={14} /> },
        ].map((stat) => (
          <div key={stat.label} className="glass-card rounded-r2 p-4 border border-white/5 text-center">
            <div className="text-white/20 mb-2 flex justify-center">{stat.icon}</div>
            <div className="text-lg font-bold text-white font-display">{stat.value}</div>
            <div className="micro-label text-white/20 mt-1">{stat.label}</div>
          </div>
        ))}
      </div>
    </div>
  </>
);

const BotManagementSection: React.FC<{
  bots: BotRecord[];
  onCreate: (name: string) => Promise<BotRecord>;
  onDelete: (botId: string) => Promise<void>;
}> = ({ bots, onCreate, onDelete }) => {
  const [newBotName, setNewBotName] = useState('');
  const [creating, setCreating] = useState(false);
  const [lastToken, setLastToken] = useState<{ name: string; token: string } | null>(null);
  const [copiedToken, setCopiedToken] = useState(false);
  const [localFeedback, setLocalFeedback] = useState<{ tone: FeedbackTone; message: string } | null>(null);

  const handleCreate = async () => {
    const name = newBotName.trim();
    if (!name) return;
    setCreating(true);
    try {
      const bot = await onCreate(name);
      setNewBotName('');
      if (bot.token) {
        setLastToken({ name: bot.name, token: bot.token });
      }
      setLocalFeedback({ tone: 'success', message: `Bot "${bot.name}" created. Copy the token below — it won't be shown again.` });
    } catch (error) {
      setLocalFeedback({ tone: 'error', message: error instanceof Error ? error.message : 'Unable to create bot.' });
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (botId: string, name: string) => {
    if (!safeConfirm(`Delete bot "${name}"? This immediately revokes its token.`)) return;
    try {
      await onDelete(botId);
      if (lastToken?.name === name) setLastToken(null);
      setLocalFeedback({ tone: 'success', message: `Bot "${name}" deleted.` });
    } catch (error) {
      setLocalFeedback({ tone: 'error', message: error instanceof Error ? error.message : 'Unable to delete bot.' });
    }
  };

  const gatewayBase = typeof window !== 'undefined' ? window.location.origin.replace(/^http/, 'https') : 'https://your-xorein-node';
  const gatewayWs = gatewayBase.replace(/^https/, 'wss') + '/v10/gateway';

  return (
    <>
      <header className="mb-10">
        <h2 className="text-[26px] font-bold text-white mb-2 font-display tracking-tight">BOTS // GATEWAY</h2>
        <p className="micro-label text-white/30">AUTOMATED // INTEGRATIONS // TOKENS</p>
      </header>

      {/* Discord-compatible gateway info */}
      <div className="glass-card rounded-r2 p-5 border border-white/10 mb-6">
        <div className="micro-label text-white/30 mb-3">DISCORD // COMPATIBLE // GATEWAY</div>
        <p className="text-[11px] text-white/50 leading-relaxed mb-4">
          Point your existing Discord bot at this node. Set the REST base and gateway URL,
          then use your bot&rsquo;s xorein token as the Discord bot token.
        </p>
        <div className="space-y-2.5">
          <div>
            <div className="text-[9px] font-mono text-white/25 mb-1">REST BASE (discord.js: rest.api)</div>
            <div className="flex items-center gap-2">
              <div className="flex-1 bg-surface-dark rounded-full px-3 py-2 border border-white/5 font-mono text-[10px] text-primary/80 truncate">{gatewayBase}/v10</div>
              <button onClick={() => copyTextToClipboardSafely(gatewayBase + '/v10')} className="p-1.5 rounded-full hover:bg-white/5 text-white/30 hover:text-primary transition-all" aria-label="Copy REST base"><Copy size={12} /></button>
            </div>
          </div>
          <div>
            <div className="text-[9px] font-mono text-white/25 mb-1">GATEWAY WS URL</div>
            <div className="flex items-center gap-2">
              <div className="flex-1 bg-surface-dark rounded-full px-3 py-2 border border-white/5 font-mono text-[10px] text-primary/80 truncate">{gatewayWs}</div>
              <button onClick={() => copyTextToClipboardSafely(gatewayWs)} className="p-1.5 rounded-full hover:bg-white/5 text-white/30 hover:text-primary transition-all" aria-label="Copy gateway URL"><Copy size={12} /></button>
            </div>
          </div>
        </div>
        <p className="mt-3 text-[9px] text-white/20 font-mono leading-relaxed">
          discord.js: {'{ rest: { api: "…/v10" }, ws: { buildURL: () =>'} &ldquo;{gatewayWs}&rdquo; {'} }'}
        </p>
      </div>

      {localFeedback && (
        <div className={`rounded-r2 border px-4 py-3 text-xs mb-6 ${localFeedback.tone === 'error' ? 'border-accent-danger/30 bg-accent-danger/10 text-accent-danger' : 'border-accent-success/30 bg-accent-success/10 text-accent-success'}`}>
          {localFeedback.message}
        </div>
      )}

      {lastToken && (
        <div className="glass-card rounded-r2 p-5 border border-primary/20 mb-6 bg-primary/5">
          <div className="flex items-center gap-2 mb-3">
            <Key size={14} className="text-primary" />
            <span className="micro-label text-primary">TOKEN FOR {lastToken.name.toUpperCase()} — SAVE NOW</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex-1 bg-surface-dark rounded-full px-4 py-2.5 border border-white/5 font-mono text-[11px] text-primary truncate">
              {lastToken.token}
            </div>
            <button
              onClick={() => {
                copyTextToClipboardSafely(lastToken.token);
                setCopiedToken(true);
                setTimeout(() => setCopiedToken(false), 2000);
              }}
              aria-label="Copy bot token"
              className="p-2.5 rounded-full border border-primary/30 text-primary hover:bg-primary/10 transition-all"
            >
              {copiedToken ? <Check size={14} /> : <Copy size={14} />}
            </button>
          </div>
          <p className="mt-2.5 text-[10px] text-white/30">This token is shown only once. Store it securely.</p>
        </div>
      )}

      <div className="glass-card rounded-r2 p-5 border border-white/10 mb-6">
        <div className="micro-label text-white/30 mb-3">CREATE // NEW BOT</div>
        <div className="flex items-center gap-2.5">
          <input
            type="text"
            value={newBotName}
            onChange={(e) => setNewBotName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void handleCreate(); }}
            placeholder="Bot name"
            className="flex-1 bg-surface-dark border border-white/10 rounded-full px-4 py-2.5 text-xs text-white placeholder:text-white/25 focus-ring"
          />
          <button
            type="button"
            disabled={!newBotName.trim() || creating}
            onClick={() => void handleCreate()}
            className="px-4 py-2.5 rounded-full text-[11px] font-bold bg-primary text-bg-0 hover:shadow-glow-sm transition-all disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {creating ? 'Creating…' : 'Create Bot'}
          </button>
        </div>
      </div>

      <div className="micro-label text-white/30 mb-3">REGISTERED BOTS // {bots.length}</div>

      {bots.length === 0 ? (
        <div className="text-center py-12">
          <Bot size={32} className="mx-auto text-white/10 mb-3" />
          <p className="text-xs text-white/20">No bots yet. Create one above.</p>
        </div>
      ) : (
        <div className="space-y-2.5">
          {bots.map((bot) => (
            <div key={bot.id} className="glass-card rounded-r2 p-4 border border-white/8 flex items-center justify-between group hover:border-primary/20 transition-all">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center">
                  <Bot size={16} className="text-primary" />
                </div>
                <div>
                  <div className="text-white font-bold text-xs">{bot.name}</div>
                  <div className="text-[9px] font-mono text-white/30 mt-0.5">{bot.id}</div>
                </div>
              </div>
              <button
                onClick={() => void handleDelete(bot.id, bot.name)}
                aria-label={`Delete bot ${bot.name}`}
                className="p-1.5 rounded-full hover:bg-accent-danger/10 text-white/30 hover:text-accent-danger transition-all opacity-0 group-hover:opacity-100"
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  );
};
