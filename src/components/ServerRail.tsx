
import React from 'react';
import { motion } from 'framer-motion';
import { Channel, ConnectionState, Server } from '@/types';
import { resolveAvatarSrc } from '@/lib/avatar';
import { Plus, Compass, Home } from 'lucide-react';

interface ServerRailProps {
  servers: Server[];
  activeServerId: string | 'home' | 'explore';
  connectionState: ConnectionState;
  onSelectServer: (id: string | 'home' | 'explore') => void;
  onCreateServer: () => void;
  showExplore?: boolean;
  /** Count of pending incoming friend requests — badged on the Home button. */
  homeBadge?: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function normalizeServerText(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function normalizeServerRail(value: unknown): Server | null {
  if (!isPlainObject(value)) {
    return null;
  }

  const id = normalizeServerText(value.id, '');
  const name = normalizeServerText(value.name, id);
  if (!id || !name) {
    return null;
  }

  const seenChannelIds = new Set<string>();
  const categories = Array.isArray(value.categories)
    ? value.categories.flatMap((category) => {
        if (!isPlainObject(category)) {
          return [];
        }
        const categoryId = normalizeServerText(category.id, '');
        const categoryName = normalizeServerText(category.name, categoryId);
        if (!categoryId || !categoryName || !Array.isArray(category.channels)) {
          return [];
        }
        const channels: Channel[] = [];
        category.channels.flatMap((channel) => {
          if (!isPlainObject(channel)) {
            return [];
          }
          const channelId = normalizeServerText(channel.id, '');
          const channelName = normalizeServerText(channel.name, channelId);
          const channelType: Channel['type'] | null = channel.type === 'text' || channel.type === 'voice' || channel.type === 'forum' || channel.type === 'announcement'
            ? channel.type
            : null;
          if (!channelId || !channelName || !channelType) {
            return [];
          }
          if (seenChannelIds.has(channelId)) {
            return [];
          }
          seenChannelIds.add(channelId);
          channels.push({
            id: channelId,
            name: channelName,
            type: channelType,
            categoryId: categoryId,
            ...(typeof channel.unreadCount === 'number' && Number.isFinite(channel.unreadCount) ? { unreadCount: channel.unreadCount } : {}),
          });
          return [];
        });
        if (channels.length === 0) {
          return [];
        }
        return [{
          id: categoryId,
          name: categoryName,
          channels,
        }];
      })
    : [];

  const dedupedCategories: Server['categories'] = [];
  const seenCategoryIds = new Set<string>();
  for (const category of categories) {
    if (seenCategoryIds.has(category.id)) {
      continue;
    }
    seenCategoryIds.add(category.id);
    dedupedCategories.push(category);
  }

  return {
    id,
    name,
    icon: typeof value.icon === 'string' ? value.icon : '',
    ownerId: normalizeServerText(value.ownerId, ''),
    categories: dedupedCategories,
    members: Array.isArray(value.members) ? value.members.filter((member): member is Server['members'][number] => typeof member === 'object' && member !== null) : [],
    ...(typeof value.banner === 'string' && value.banner.trim() ? { banner: value.banner.trim() } : {}),
    ...(typeof value.region === 'string' && value.region.trim() ? { region: value.region.trim() } : {}),
    ...(typeof value.description === 'string' && value.description.trim() ? { description: value.description.trim() } : {}),
  };
}

export const ServerRail: React.FC<ServerRailProps> = ({ servers, activeServerId, connectionState, onSelectServer, onCreateServer, showExplore = true, homeBadge = 0 }) => {
  const connectivityEnabled = connectionState.canUseConnectivityActions;
  const normalizedServers = React.useMemo(() => {
    const normalized: Server[] = [];
    const seen = new Set<string>();
    for (const server of servers) {
      const normalizedServer = normalizeServerRail(server);
      if (!normalizedServer || seen.has(normalizedServer.id)) {
        continue;
      }
      seen.add(normalizedServer.id);
      normalized.push(normalizedServer);
    }
    return normalized;
  }, [servers]);

  return (
    <div className="w-[70px] bg-bg-0 flex flex-col items-center py-5 gap-3 overflow-y-auto overflow-x-hidden no-scrollbar border-r border-white/5 z-20 h-full" role="navigation" aria-label="Servers">
      {/* Home Button */}
      <div className="group relative flex flex-col items-center cursor-pointer">
          <motion.button 
             whileHover={{ scale: 1.1 }}
             whileTap={{ scale: 0.95 }}
             data-testid="server-rail-home"
             onClick={() => onSelectServer('home')}
            aria-label="Home"
            title="Home"
            className={`w-[44px] h-[44px] rounded-full group-hover:rounded-r1 transition-all duration-300 flex items-center justify-center bg-white/5 group-hover:bg-primary group-hover:text-bg-0 text-white/40 ${activeServerId === 'home' ? 'rounded-r1 bg-primary text-bg-0 ring-2 ring-primary/40 ring-offset-[3px] ring-offset-bg-0' : ''}`}>
           <Home size={20} />
         </motion.button>
         {activeServerId === 'home' && (
           <div className="absolute -left-5 top-1/2 -translate-y-1/2 w-1.5 h-5 bg-primary rounded-r-full shadow-[0_0_10px_#13DDEC]"></div>
         )}
         {/* Pending friend-request badge: the recipient sees this even before they
             open the Friends panel, so a request is never silently missed. */}
         {homeBadge > 0 && (
           <div className="absolute -bottom-0.5 -right-0.5 min-w-[15px] h-[15px] bg-accent-danger rounded-full flex items-center justify-center text-[8px] font-bold text-white border-2 border-bg-0 px-1 shadow-[0_0_6px_rgba(255,42,109,0.5)]" aria-label={`${homeBadge} pending friend requests`}>
             {homeBadge}
           </div>
         )}
      </div>

      <div className="w-8 h-[1px] bg-white/10"></div>

      {normalizedServers.map((server) => {
        const totalUnread = server.categories.flatMap(c => c.channels).reduce((sum, ch) => sum + (ch.unreadCount || 0), 0);
        return (
        <div key={server.id} className="group relative flex flex-col items-center cursor-pointer">
          <motion.button
             whileHover={{ scale: 1.1 }}
             whileTap={{ scale: 0.95 }}
             data-testid={`server-rail-server-${server.id}`}
            onClick={() => onSelectServer(server.id)}
            aria-label={`Server: ${server.name}`}
            title={server.name}
            className={`w-[44px] h-[44px] rounded-full group-hover:rounded-r1 transition-all duration-300 flex items-center justify-center overflow-hidden bg-white/5 ring-1 ring-white/10 group-hover:ring-primary ${activeServerId === server.id ? 'rounded-r1 ring-2 ring-primary ring-offset-[3px] ring-offset-bg-0' : ''}`}>
            <img referrerPolicy="no-referrer" src={resolveAvatarSrc(server.icon, server.name)} alt={server.name} className="w-full h-full object-cover grayscale-[0.5] group-hover:grayscale-0 transition-all duration-500" />
          </motion.button>
          {activeServerId === server.id && (
            <div className="absolute -left-5 top-1/2 -translate-y-1/2 w-1.5 h-5 bg-primary rounded-r-full shadow-[0_0_10px_#13DDEC]"></div>
          )}
          {/* Unread badge */}
          {totalUnread > 0 && activeServerId !== server.id && (
            <div className="absolute -bottom-0.5 -right-0.5 min-w-[15px] h-[15px] bg-accent-danger rounded-full flex items-center justify-center text-[8px] font-bold text-white border-2 border-bg-0 px-1 shadow-[0_0_6px_rgba(255,42,109,0.5)]">
              {totalUnread}
            </div>
          )}
          {/* Unread pip (no count, just indicator) */}
          {totalUnread === 0 && activeServerId !== server.id && server.categories.some(c => c.channels.some(ch => (ch.unreadCount || 0) > 0)) && (
            <div className="absolute -left-3 top-1/2 -translate-y-1/2 w-1.5 h-1.5 bg-white rounded-full"></div>
          )}
          {/* Tooltip */}
          <div className="absolute left-[56px] bg-bg-1 text-white text-[9px] font-bold px-2.5 py-1 rounded-full opacity-0 group-hover:opacity-100 hover:opacity-100 transition-all duration-200 delay-150 group-hover:delay-0 z-50 border border-primary/20 whitespace-nowrap tracking-widest translate-x-4 group-hover:translate-x-0 hover:translate-x-0">
            {server.name.toUpperCase()}
          </div>
        </div>
        );
      })}

      <motion.button 
        whileHover={{ scale: 1.1 }}
        whileTap={{ scale: 0.95 }}
        data-testid="server-rail-create"
        disabled={!connectivityEnabled}
        onClick={onCreateServer}
        aria-label="Create Server"
        title={!connectivityEnabled ? connectionState.detail : 'Create Server'}
        className="w-[44px] h-[44px] rounded-full bg-white/5 flex items-center justify-center text-accent-success/60 hover:text-accent-success hover:bg-accent-success/10 transition-all cursor-pointer border border-white/5 hover:border-accent-success/40 disabled:opacity-40 disabled:cursor-not-allowed">
        <Plus size={20} />
      </motion.button>

       {showExplore && (
       <motion.button
        whileHover={{ scale: 1.1 }}
        whileTap={{ scale: 0.95 }}
        data-testid="server-rail-explore"
        disabled={!connectivityEnabled}
        onClick={() => onSelectServer('explore')}
        aria-label="Explore Servers"
        title={!connectivityEnabled ? connectionState.detail : 'Explore Servers'}
        className={`w-[44px] h-[44px] rounded-full flex items-center justify-center transition-all cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${activeServerId === 'explore' ? 'bg-accent-purple text-bg-0' : 'bg-white/5 text-accent-purple/60 hover:text-accent-purple hover:bg-accent-purple/10'}`}>
        <Compass size={20} />
      </motion.button>
      )}

      <div
        className="mt-auto flex flex-col items-center gap-1.5 px-2 pt-3 text-center"
        role="status"
        aria-label={`Connection: ${connectionState.label}. ${connectionState.detail}`}
        title={connectionState.detail || connectionState.label}
      >
        <div className={`w-2 h-2 rounded-full ${statusColorClass(connectionState.status)}`} aria-hidden="true"></div>
        <div className="text-[8px] font-bold tracking-[0.24em] text-white/60">{connectionState.label}</div>
      </div>
    </div>
  );
};

function statusColorClass(status: ConnectionState['status']): string {
  switch (status) {
    case 'connected':
      return 'bg-accent-success shadow-[0_0_8px_rgba(5,255,161,0.75)]';
    case 'reconnecting':
      return 'bg-accent-warning shadow-[0_0_8px_rgba(255,176,32,0.75)]';
    case 'disconnected':
    case 'no-peer':
    case 'no-relay':
      return 'bg-accent-danger shadow-[0_0_8px_rgba(255,42,109,0.75)]';
  }
}
