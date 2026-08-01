import React, { useEffect, useMemo, useState } from 'react';
import { Compass, Search, Users, Shield, Zap, TrendingUp, ArrowRight, Link as LinkIcon } from 'lucide-react';
import type { Server, XoreinRuntimeSnapshot } from '@/types';
import { resolveAvatarSrc } from '@/lib/avatar';
import { useRuntimeMutations, type XoreinServerPreview } from '@/hooks/runtime/useRuntimeMutations';

interface ServerExplorerProps {
    servers: Server[];
    runtimeSnapshot: XoreinRuntimeSnapshot | null;
    onSelectServer: (id: string | 'home' | 'explore') => void;
    onOpenJoin: (initialValue?: string) => void;
}

export const ServerExplorer: React.FC<ServerExplorerProps> = ({ servers, onSelectServer, onOpenJoin }) => {
    const { previewServerInvite } = useRuntimeMutations();
    const previewServerInviteRef = React.useRef(previewServerInvite);
    previewServerInviteRef.current = previewServerInvite;
    const [query, setQuery] = useState('');
    const [discoveredServer, setDiscoveredServer] = useState<XoreinServerPreview | null>(null);
    const [discoveryLoading, setDiscoveryLoading] = useState(false);
    const [discoveryError, setDiscoveryError] = useState('');

    useEffect(() => {
        const trimmed = query.trim();
        if (!trimmed) {
            setDiscoveredServer(null);
            setDiscoveryLoading(false);
            setDiscoveryError('');
            return;
        }

        let cancelled = false;
        const timeoutId = window.setTimeout(async () => {
            setDiscoveryLoading(true);
            try {
                const nextPreview = await previewServerInviteRef.current(trimmed);
                if (cancelled) {
                    return;
                }
                setDiscoveredServer(normalizeServerPreview(nextPreview));
                setDiscoveryError('');
            } catch (error) {
                if (cancelled) {
                    return;
                }
                setDiscoveredServer(null);
                setDiscoveryError(error instanceof Error ? error.message : 'Unable to resolve invite.');
            } finally {
                if (!cancelled) {
                    setDiscoveryLoading(false);
                }
            }
        }, 250);

        return () => {
            cancelled = true;
            window.clearTimeout(timeoutId);
        };
    }, [query]);

    const trackedServers = useMemo(() => [...servers].sort((left, right) => left.name.localeCompare(right.name)), [servers]);
    const discoveredAlreadyJoined = discoveredServer ? trackedServers.some((server) => server.id === discoveredServer.manifest.server_id) : false;

    return (
        <div className="flex-1 bg-bg-0 overflow-y-auto h-full animate-in fade-in duration-500 no-scrollbar relative">
            <div className="relative h-[320px] flex items-center justify-center overflow-hidden border-b border-white/5">
                <div className="absolute inset-0 bg-gradient-to-b from-primary/10 to-bg-0 z-0"></div>
                <div className="absolute inset-0 bg-gradient-to-br from-primary/10 via-transparent to-accent/10 opacity-70 mix-blend-screen scale-110"></div>
                <div className="absolute inset-0 grid-overlay opacity-20"></div>

                <div className="relative z-10 text-center max-w-2xl px-5">
                    <div className="inline-flex items-center gap-1.5 micro-label text-primary bg-primary/10 px-3 py-1 rounded-full mb-5 border border-primary/20 shadow-glow">
                        <TrendingUp size={12} /> Global Stream Explorer
                    </div>
                    <h1 className="text-3xl md:text-4xl font-bold text-white mb-5 font-display text-glow leading-[1.1]">Join the Underground Network.</h1>
                    <p className="text-white/40 mb-8 text-base font-light tracking-tight">Paste a signed `xorein://join/...` or `xorein://invite/...` invite to inspect a Space before joining, or browse the Spaces already tracked by your local runtime.</p>

                    <div className="relative max-w-2xl mx-auto group">
                        <div className="absolute inset-0 bg-primary/20 rounded-full blur-xl group-focus-within:bg-primary/30 transition-all opacity-0 group-focus-within:opacity-100"></div>
                        <div className="relative glass-panel rounded-full p-1 border border-white/10 flex items-center focus-within:border-primary/50 transition-all">
                            <div className="pl-5 pr-2.5 text-white/30"><Search size={18} /></div>
                            <input
                                type="text"
                                value={query}
                                onChange={(event) => setQuery(event.target.value)}
                                placeholder="xorein://join/space-id?invite=..."
                                className="w-full bg-transparent py-2.5 text-white focus:outline-none text-base font-light placeholder-white/20"
                            />
                            <button onClick={() => onOpenJoin(query.trim())} className="bg-primary text-bg-0 px-6 py-2.5 rounded-full font-bold micro-label tracking-tight hover:shadow-glow hover:scale-[1.02] transition-all ml-1.5 disabled:opacity-50" disabled={!query.trim()}>
                                Join Invite
                            </button>
                        </div>
                    </div>

                    <div className="mt-5 flex items-center justify-center gap-3 text-[10px] text-white/35 tracking-[0.18em]">
                        <button onClick={() => onOpenJoin()} className="hover:text-primary transition-colors inline-flex items-center gap-2">
                            <LinkIcon size={12} /> OPEN JOIN MODAL
                        </button>
                        <span>•</span>
                        <span>NETWORK-BACKED RESULTS ONLY</span>
                    </div>
                </div>
            </div>

            <div className="max-w-6xl mx-auto px-6 py-12 space-y-10">
                <section>
                    <div className="flex items-center justify-between mb-6 gap-4 flex-wrap">
                        <h2 className="micro-label text-white tracking-[0.2em] flex items-center gap-2.5">
                            <div className="w-1.5 h-1.5 rounded-full bg-primary shadow-glow"></div>
                            Invite Discovery
                        </h2>
                        <div className="flex gap-1.5">
                            {['SIGNED', 'XOREIN', 'LOCAL CONTROL'].map(tag => (
                                <div key={tag} className="px-3 py-1 rounded-full glass-panel border border-white/10 micro-label text-[7px] text-white/40">
                                    {tag}
                                </div>
                            ))}
                        </div>
                    </div>

                    {discoveryLoading && (
                        <div className="glass-card rounded-r2 border border-white/10 px-6 py-8 text-center text-white/50 flex items-center justify-center gap-3">
                            <Zap size={16} className="text-primary animate-pulse" /> Resolving signed invite through the local xorein runtime...
                        </div>
                    )}

                    {!discoveryLoading && discoveredServer && (
                        <div className="glass-card rounded-r2 overflow-hidden border border-primary/20 shadow-xl">
                            <div className="p-6 flex flex-col lg:flex-row gap-6 lg:items-center lg:justify-between">
                                <div className="min-w-0">
                                    <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-primary/10 border border-primary/20 micro-label text-primary mb-4">
                                        <Shield size={12} /> VERIFIED INVITE
                                    </div>
                                    <h3 className="text-2xl font-bold text-white font-display mb-2">{discoveredServer.manifest.name}</h3>
                                    <p className="text-white/45 text-sm leading-relaxed max-w-2xl">{discoveredServer.manifest.description?.trim() || 'This invite resolved to a live xorein manifest.'}</p>
                                    <div className="mt-4 flex flex-wrap gap-4 text-[10px] uppercase tracking-[0.18em] text-white/35">
                                        <span className="inline-flex items-center gap-1.5"><Users size={12} /> {(discoveredServer.member_count ?? 0).toLocaleString()} members</span>
                                        <span className="inline-flex items-center gap-1.5"><Compass size={12} /> {discoveredServer.channels?.length ?? 0} channels</span>
                                        {discoveredServer.manifest.history_coverage ? <span>{discoveredServer.manifest.history_coverage}</span> : null}
                                        {discoveredServer.owner_role ? <span>{discoveredServer.owner_role}</span> : null}
                                    </div>
                                    {discoveredServer.safety_labels?.length ? (
                                        <div className="mt-4 flex flex-wrap gap-2">
                                            {discoveredServer.safety_labels.map((label) => (
                                                <span key={label} className="px-2.5 py-1 rounded-full border border-white/10 bg-white/5 text-[10px] uppercase tracking-[0.16em] text-white/45">
                                                    {label}
                                                </span>
                                            ))}
                                        </div>
                                    ) : null}
                                </div>
                                <div className="flex flex-col gap-3 shrink-0">
                                    {discoveredAlreadyJoined ? (
                                        <button onClick={() => onSelectServer(discoveredServer.manifest.server_id)} className="h-12 px-6 rounded-full bg-primary text-bg-0 font-bold text-body-strong flex items-center justify-center gap-2 hover:shadow-glow transition-all">
                                            <ArrowRight size={16} /> Open Joined Space
                                        </button>
                                    ) : (
                                        <button onClick={() => onOpenJoin(query.trim())} className="h-12 px-6 rounded-full bg-primary text-bg-0 font-bold text-body-strong flex items-center justify-center gap-2 hover:shadow-glow transition-all">
                                            <ArrowRight size={16} /> Join via Invite
                                        </button>
                                    )}
                                </div>
                            </div>
                        </div>
                    )}

                    {!discoveryLoading && !discoveredServer && query.trim() && discoveryError && (
                        <div className="glass-card rounded-r2 border border-accent-danger/20 bg-accent-danger/10 px-6 py-5 text-sm text-accent-danger">
                            {discoveryError}
                        </div>
                    )}

                    {!discoveryLoading && !discoveredServer && !query.trim() && (
                        <div className="glass-card rounded-r2 border border-white/10 px-6 py-5 text-sm text-white/40">
                            Paste a signed `aether://join/&lt;space-id&gt;?invite=...` or `xorein://invite/...` deeplink to inspect a Space through the local runtime without joining it yet.
                        </div>
                    )}
                </section>

                <section>
                    <div className="flex items-center justify-between mb-8 gap-4 flex-wrap">
                        <h2 className="micro-label text-white tracking-[0.2em] flex items-center gap-2.5">
                            <div className="w-1.5 h-1.5 rounded-full bg-primary shadow-glow"></div>
                            Joined Spaces
                        </h2>
                        <div className="text-[10px] tracking-[0.18em] text-white/30 uppercase">Backed by `GET /v1/state`</div>
                    </div>

                    {trackedServers.length === 0 ? (
                        <div className="glass-card rounded-r2 border border-white/10 px-8 py-12 text-center">
                            <div className="inline-flex items-center justify-center w-14 h-14 rounded-full bg-white/5 border border-white/10 text-primary mb-4">
                                <Compass size={22} />
                            </div>
                            <h3 className="text-white font-bold text-lg mb-2">No joined Spaces yet</h3>
                            <p className="text-white/40 max-w-xl mx-auto mb-6">You have not joined or created a Space yet. Use a signed invite or create a Space to populate the rail.</p>
                            <button onClick={() => onOpenJoin()} className="h-11 px-6 rounded-full border border-primary/30 text-primary hover:bg-primary/10 transition-all font-bold text-sm">
                                Open Join Flow
                            </button>
                        </div>
                    ) : (
                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
                            {trackedServers.map((server, idx) => (
                                <div key={server.id} className="glass-card rounded-r2 overflow-hidden hover:transform hover:-translate-y-2 transition-all duration-500 shadow-xl border border-white/10 group relative">
                                    <div className="h-32 bg-bg-1 relative overflow-hidden">
                                        {server.banner ? (
                                            <img referrerPolicy="no-referrer" src={resolveAvatarSrc(server.banner, server.name)} alt="" className="w-full h-full object-cover grayscale group-hover:grayscale-0 group-hover:scale-110 transition-all duration-700" />
                                        ) : (
                                            <div className="w-full h-full bg-[radial-gradient(circle_at_top_left,rgba(19,221,236,0.28),transparent_45%),linear-gradient(135deg,rgba(255,255,255,0.05),rgba(255,255,255,0.01))]"></div>
                                        )}
                                        <div className="absolute inset-0 bg-gradient-to-t from-bg-0 to-transparent"></div>
                                        <div className="absolute top-3 right-3 bg-bg-0/80 backdrop-blur-md px-2.5 py-0.5 rounded-full border border-white/10 micro-label text-[7px] text-primary flex items-center gap-1">
                                            <Zap size={8} /> Space {idx + 1}
                                        </div>
                                    </div>
                                    <div className="p-5 pt-0 relative">
                                        <div className="w-[52px] h-[52px] rounded-r2 bg-bg-1 absolute -top-8 left-5 border-[3px] border-bg-0 overflow-hidden shadow-2xl ring-1 ring-white/10 group-hover:ring-primary transition-all">
                                            <img referrerPolicy="no-referrer" src={resolveAvatarSrc(server.icon, server.name)} alt={server.name} className="w-full h-full object-cover" />
                                        </div>
                                        <div className="mt-8">
                                            <h3 className="text-base font-bold text-white mb-1.5 font-display flex items-center gap-1.5 group-hover:text-primary transition-colors">
                                                {server.name}
                                                <div className="w-2.5 h-2.5 rounded-full bg-accent-success shadow-glow-success" title="Reachable in local runtime"></div>
                                            </h3>
                                            <p className="text-white/40 text-xs font-light leading-relaxed line-clamp-2 mb-5 h-8">{server.description || 'Joined on this device.'}</p>

                                            <div className="flex items-center justify-between border-t border-white/5 pt-3">
                                                <div className="flex items-center gap-3 text-[9px] micro-label text-white/20">
                                                    <div className="flex items-center gap-1">
                                                        <div className="w-1.5 h-1.5 bg-accent-success rounded-full shadow-[0_0_5px_#05FFA1]"></div>
                                                        <span className="font-mono">{server.members.length}</span>
                                                    </div>
                                                    <div className="flex items-center gap-1">
                                                        <Users size={10} />
                                                        <span className="font-mono">{server.categories.flatMap(category => category.channels).length}</span>
                                                    </div>
                                                </div>
                                                <button onClick={() => onSelectServer(server.id)} className="h-8 px-3 rounded-full glass-panel flex items-center justify-center text-white/40 group-hover:text-primary group-hover:border-primary transition-all border border-white/5 text-[10px] font-bold tracking-[0.18em]">
                                                    OPEN
                                                </button>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </section>
            </div>
        </div>
    );
};

function normalizeServerPreview(value: unknown): XoreinServerPreview | null {
    if (!isPlainObject(value)) {
        return null;
    }

    const invite = isPlainObject(value.invite) ? value.invite : null;
    const manifest = isPlainObject(value.manifest) ? value.manifest : null;
    const serverId = normalizePreviewText(manifest?.server_id, '');
    const manifestName = normalizePreviewText(manifest?.name, '');
    const inviteServerId = normalizePreviewText(invite?.server_id, '');
    if (!serverId || !manifestName || inviteServerId !== serverId) {
        return null;
    }

    const channels = Array.isArray(value.channels)
        ? normalizePreviewChannels(value.channels, serverId)
        : undefined;
    const safetyLabels = Array.isArray(value.safety_labels)
        ? normalizePreviewSafetyLabels(value.safety_labels)
        : undefined;

    return {
        invite: {
            server_id: serverId,
            ...(typeof invite.expires_at === 'string' && invite.expires_at.trim() ? { expires_at: invite.expires_at.trim() } : {}),
            ...(typeof invite.has_signature === 'boolean' ? { has_signature: invite.has_signature } : {}),
            ...(typeof invite.owner_peer_id === 'string' && invite.owner_peer_id.trim() ? { owner_peer_id: invite.owner_peer_id.trim() } : {}),
        },
        manifest: {
            server_id: serverId,
            name: manifestName,
            ...(typeof manifest.description === 'string' && manifest.description.trim() ? { description: manifest.description.trim() } : {}),
            ...(typeof manifest.history_coverage === 'string' && manifest.history_coverage.trim() ? { history_coverage: manifest.history_coverage.trim() } : {}),
            ...(typeof manifest.security_mode === 'string' && manifest.security_mode.trim() ? { security_mode: manifest.security_mode.trim() } : {}),
        },
        ...(typeof value.owner_role === 'string' && value.owner_role.trim() ? { owner_role: value.owner_role.trim() } : {}),
        ...(typeof value.member_count === 'number' && Number.isFinite(value.member_count) ? { member_count: value.member_count } : {}),
        ...(channels !== undefined ? { channels } : {}),
        ...(safetyLabels !== undefined ? { safety_labels: safetyLabels } : {}),
    };
}

function normalizePreviewText(value: unknown, fallback: string): string {
    return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function normalizePreviewChannels(
    value: unknown[],
    serverId: string,
): { id: string; server_id: string; name: string; voice: boolean; created_at?: string }[] {
    const normalized: { id: string; server_id: string; name: string; voice: boolean; created_at?: string }[] = [];
    const seenIds = new Set<string>();
    for (const channel of value) {
        const normalizedChannel = normalizePreviewChannel(channel, serverId);
        if (!normalizedChannel || seenIds.has(normalizedChannel.id)) {
            continue;
        }
        seenIds.add(normalizedChannel.id);
        normalized.push(normalizedChannel);
    }
    return normalized;
}

function normalizePreviewSafetyLabels(value: unknown[]): string[] {
    const normalized: string[] = [];
    const seenLabels = new Set<string>();
    for (const label of value) {
        if (typeof label !== 'string') {
            continue;
        }
        const normalizedLabel = label.trim();
        if (!normalizedLabel || seenLabels.has(normalizedLabel)) {
            continue;
        }
        seenLabels.add(normalizedLabel);
        normalized.push(normalizedLabel);
    }
    return normalized;
}

function normalizePreviewChannel(value: unknown, serverId: string): { id: string; server_id: string; name: string; voice: boolean; created_at?: string } | null {
    if (!isPlainObject(value)) {
        return null;
    }

    const id = normalizePreviewText(value.id, '');
    const channelServerId = normalizePreviewText(value.server_id, '');
    const name = normalizePreviewText(value.name, '');
    if (!id || !channelServerId || channelServerId !== serverId || !name || typeof value.voice !== 'boolean') {
        return null;
    }

    return {
        id,
        server_id: channelServerId,
        name,
        voice: value.voice,
        ...(typeof value.created_at === 'string' && value.created_at.trim() ? { created_at: value.created_at.trim() } : {}),
    };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value)
        && typeof value === 'object'
        && !Array.isArray(value)
        && Object.getPrototypeOf(value) === Object.prototype;
}
