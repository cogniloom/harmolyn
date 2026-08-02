import React, { useEffect, useMemo, useRef, useState } from 'react';
import { X, Link, ArrowRight, Shield, Loader2, AlertTriangle } from 'lucide-react';
import { useRuntimeMutations, type XoreinServerPreview } from '@/hooks/runtime/useRuntimeMutations';
import { parseInviteMetadata, type InviteMetadata } from '@/protocol/deeplink';
import { PendingButton } from '@/components/ui/PendingButton';
import { useEscapeKey } from '@/hooks/useEscapeKey';
import type { XoreinRuntimeSnapshot } from '@/types';

interface JoinServerModalProps {
  onClose: () => void;
  onJoin: (inviteCode: string) => Promise<void>;
  initialValue?: string;
  runtimeSnapshot?: XoreinRuntimeSnapshot | null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeDiscoveryPreview(value: unknown): {
  name: string;
  members: number;
  icon: string;
  description: string;
} | null {
  if (!isPlainObject(value) || !isPlainObject(value.manifest)) {
    return null;
  }

  const name = normalizeText(value.manifest.name);
  if (!name) {
    return null;
  }

  const description = normalizeText(value.manifest.description) || 'Signed xorein invite record.';
  const members = typeof value.member_count === 'number' && Number.isFinite(value.member_count)
    ? value.member_count
    : 0;

  return {
    name,
    members,
    icon: name.slice(0, 1).toUpperCase(),
    description,
  };
}

export const JoinServerModal: React.FC<JoinServerModalProps> = ({ onClose, onJoin, initialValue = '' }) => {
  // ZERO-TRUST: preview goes through the mutation facade. On the native path it is
  // a local no-op (the support node must not learn which server the user is about
  // to join before they join it); only the HTTP/legacy branch queries the node.
  // Held in a ref so the debounced discovery effect re-runs only when the INPUT
  // changes — the facade object's identity changes with every runtime-snapshot
  // publish, and keying the effect on it would re-fire discovery in a loop.
  const { previewServerInvite } = useRuntimeMutations();
  const previewServerInviteRef = useRef(previewServerInvite);
  previewServerInviteRef.current = previewServerInvite;
  const [inviteLink, setInviteLink] = useState(initialValue);
  const [discoveryLoading, setDiscoveryLoading] = useState(false);
  const [joining, setJoining] = useState(false);
  const [slowJoin, setSlowJoin] = useState(false);
  const [error, setError] = useState('');
  const [discovery, setDiscovery] = useState<XoreinServerPreview | null>(null);
  // Local parse of the invite — the source of truth for whether Join is allowed.
  // The actual join is P2P (dial the owner), so it must NOT depend on the support
  // node's HTTP discovery (which 401s on most origins).
  const [localMeta, setLocalMeta] = useState<InviteMetadata | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEscapeKey(onClose);

  // Auto-focus the invite input on mount so a pasted link lands immediately.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const discoverySummary = useMemo(() => {
    const remote = normalizeDiscoveryPreview(discovery);
    if (remote) return remote;
    if (!localMeta) return null;
    const name = localMeta.serverName || localMeta.serverId;
    return { name, members: 0, icon: name.slice(0, 1).toUpperCase(), description: 'P2P invite — joins by reaching the Space Owner or another authenticated member.' };
  }, [discovery, localMeta]);

  useEffect(() => {
    const trimmed = inviteLink.trim();
    if (!trimmed) {
      setDiscovery(null);
      setLocalMeta(null);
      setDiscoveryLoading(false);
      setError('');
      return;
    }

    // Validate + preview locally first (no network).
    let meta: InviteMetadata | null = null;
    try {
      meta = parseInviteMetadata(trimmed);
      setLocalMeta(meta);
      setError('');
    } catch (parseErr) {
      setLocalMeta(null);
      setDiscovery(null);
      setError(parseErr instanceof Error ? parseErr.message.replace(/^deeplink validation: /, '') : 'Invalid invite link.');
      return;
    }

    // Best-effort enrichment (optional; failure is non-fatal). Resolves locally
    // (null) on the native path; only the HTTP/legacy branch asks the support node.
    let cancelled = false;
    const timeoutId = window.setTimeout(async () => {
      setDiscoveryLoading(true);
      try {
        const nextDiscovery = await previewServerInviteRef.current(trimmed);
        if (!cancelled && nextDiscovery && normalizeDiscoveryPreview(nextDiscovery)) setDiscovery(nextDiscovery);
      } catch {
        /* support node optional — local preview already shown */
      } finally {
        if (!cancelled) setDiscoveryLoading(false);
      }
    }, 250);

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  // The facade fn is read through a ref (see above) so only the input re-arms the debounce.
  }, [inviteLink]);

  const handleJoin = async () => {
    if (!inviteLink.trim()) return;
    setJoining(true);
    setError('');
    setSlowJoin(false);
    // Joining dials the server owner over P2P and can take several seconds (or
    // time out if the owner is offline). Surface a reassuring note after 8s so
    // the wait never feels like a hang.
    const slowTimer = window.setTimeout(() => setSlowJoin(true), 8000);
    try {
      await onJoin(inviteLink.trim());
      onClose();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Failed to join Space.');
    } finally {
      window.clearTimeout(slowTimer);
      setJoining(false);
      setSlowJoin(false);
    }
  };

  return (
    <div className="responsive-overlay-scroll fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
      <div role="dialog" aria-modal="true" aria-labelledby="join-server-title" className="flex max-h-full w-full max-w-[480px] flex-col overflow-hidden rounded-r3 border border-stroke glass-card">
          {/* Header */}
          <div className="flex shrink-0 items-center justify-between gap-3 border-b border-white/5 px-4 py-4 sm:px-6">
            <div className="min-w-0">
              <h2 id="join-server-title" className="text-title font-semibold text-text-primary">Join a Space</h2>
              <p className="text-caption text-text-tertiary mt-1">Paste a signed invite link to request membership</p>
            </div>
            <button onClick={onClose} aria-label="Close" className="touch-target flex shrink-0 items-center justify-center rounded-full border border-stroke-subtle glass-panel text-text-secondary transition-all hover:border-primary hover:text-primary focus-ring">
              <X size={16} />
            </button>
          </div>

        <div className="min-h-0 overflow-y-auto overscroll-contain px-4 py-4 sm:px-6 sm:py-5">
          {/* Input */}
          <div className="space-y-1.5 mb-5">
            <label htmlFor="join-server-invite" className="micro-label text-text-tertiary">INVITE LINK</label>
            <div className="relative">
              <Link size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-primary/50" />
              <input
                id="join-server-invite"
                ref={inputRef}
                type="text"
                value={inviteLink}
                onChange={e => setInviteLink(e.target.value)}
                placeholder="xorein://join/space-id?invite=..."
                className="w-full h-14 pl-11 pr-5 rounded-full bg-surface-dark border border-stroke-subtle text-text-primary text-body placeholder:text-text-disabled focus:border-stroke-primary focus:outline-none transition-colors focus-ring"
              />
            </div>
          </div>

          {/* Discovery */}
          {discoveryLoading && !discovery && (
            <div className="flex items-center justify-center py-6">
              <Loader2 size={20} className="text-primary animate-spin" />
            </div>
          )}

          {discoverySummary && (
            <div className="glass-card rounded-r2 p-4 border border-stroke-primary mb-5 flex items-center gap-4 animate-in slide-in-from-bottom-2 duration-200">
              <div className="w-12 h-12 rounded-r2 bg-primary/10 border border-primary/20 flex items-center justify-center text-2xl">
                {discoverySummary.icon}
              </div>
              <div className="flex-1">
                <div className="text-body-strong text-text-primary">{discoverySummary.name}</div>
                <div className="flex items-center gap-1.5 mt-0.5">
                  <div className="w-2 h-2 rounded-full bg-accent-success" />
                  <span className="text-caption text-text-secondary">{discoverySummary.members.toLocaleString()} members</span>
                </div>
                <div className="text-caption text-text-tertiary mt-1">{discoverySummary.description}</div>
              </div>
              <Shield size={16} className="text-primary/40" />
            </div>
          )}

          {error && (
            <div className="mb-4 rounded-r2 border border-accent-danger/20 bg-accent-danger/10 px-3 py-2 text-caption text-accent-danger flex items-start gap-2" role="alert">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {joining && slowJoin && (
            <div className="mb-4 rounded-r2 border border-primary/20 bg-primary/10 px-3 py-2 text-caption text-primary flex items-start gap-2" role="status">
              <Loader2 size={14} className="mt-0.5 shrink-0 animate-spin" />
              <span>Still searching — this can take a moment while Harmolyn finds an authenticated Space member.</span>
            </div>
          )}

          {/* Examples */}
          <div className="mb-6">
            <div className="micro-label text-text-disabled mb-2">INVITE DISCOVERY</div>
            <div className="space-y-1 text-caption text-text-tertiary font-mono">
              <div>xorein://join/cyber-devs?invite=&lt;signed-payload&gt;</div>
              <div>xorein://invite/&lt;signed-payload&gt;</div>
            </div>
          </div>

        </div>

          {/* Actions */}
          <div className="flex shrink-0 justify-end gap-3 border-t border-white/5 px-4 py-3 sm:px-6 sm:py-4">
            <button onClick={onClose} className="touch-target px-5 rounded-full border border-stroke-subtle text-text-secondary text-body-strong hover:bg-white/5 transition-all">
              Cancel
            </button>
            <PendingButton
              onClick={() => void handleJoin()}
              pending={joining}
              pendingLabel="Finding Space…"
              disabled={!inviteLink.trim() || !localMeta}
              className="touch-target px-5 sm:px-6 rounded-full bg-primary text-bg-0 font-bold text-body-strong flex items-center justify-center gap-2 hover:shadow-glow transition-all disabled:opacity-40"
            >
              <ArrowRight size={16} />
              Join Space
            </PendingButton>
          </div>
      </div>
    </div>
  );
};
