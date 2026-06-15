import React from 'react';
import { ArrowRight, Globe, RotateCw, Shield, Server, CircleOff, Eye, ShieldCheck, X } from 'lucide-react';
import { SecurityNote } from './SecurityNote';

interface NodeLaunchScreenProps {
  endpoint: string;
  feedback?: string | null;
  busy?: boolean;
  currentNodeLabel?: string;
  onEndpointChange: (value: string) => void;
  onConnect: () => void;
  onUseDefault: () => void;
  onContinueOffline: () => void;
}

/** Whether the entered endpoint points at a node running on this machine. */
function isLoopbackEndpoint(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`);
    const host = url.hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
    return host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host);
  } catch {
    return false;
  }
}

/**
 * Light, non-blocking format check for the address field. Mirrors the parsing
 * the backend will attempt (a bare host:port is auto-prefixed with http://) so
 * we only flag input that genuinely cannot resolve to an HTTP(S) URL. Returns
 * `true` for empty input so the field starts in a neutral state.
 */
function isLikelyValidEndpoint(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return true;
  }
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`);
    return (url.protocol === 'http:' || url.protocol === 'https:') && Boolean(url.hostname);
  } catch {
    return false;
  }
}

export const NodeLaunchScreen: React.FC<NodeLaunchScreenProps> = ({
  endpoint,
  feedback,
  busy = false,
  currentNodeLabel,
  onEndpointChange,
  onConnect,
  onUseDefault,
  onContinueOffline,
}) => {
  const endpointLooksValid = isLikelyValidEndpoint(endpoint);
  return (
    <div className="fixed inset-0 z-[260] bg-bg-0 overflow-hidden">
      <div className="absolute inset-0 bg-gradient-to-b from-bg-0 via-bg-2 to-bg-0" />
      <div className="absolute inset-0 grid-overlay opacity-25" />
      <div className="absolute inset-0 pointer-events-none" style={{ background: 'radial-gradient(circle at 50% 0%, rgba(19,221,236,0.12) 0%, transparent 55%)' }} />

      <div className="relative z-10 flex min-h-full items-center justify-center px-6 py-10">
        <div className="w-full max-w-[620px]">
          <div className="text-center mb-8">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-r3 bg-primary/10 border border-primary/20 mb-5 shadow-glow">
              <Shield size={30} className="text-primary" />
            </div>
            <h1 className="text-display-l font-bold text-text-primary font-display tracking-tight">SELECT NODE</h1>
            <p className="micro-label text-text-tertiary mt-2">CONTROL // ENDPOINT // LAUNCH</p>
          </div>

          <div className="glass-card rounded-r3 border border-white/10 shadow-2xl overflow-hidden">
            <div className="p-6 md:p-8 border-b border-white/5 bg-gradient-to-b from-white/5 to-transparent">
              <div className="flex items-start gap-4">
                <div className="w-12 h-12 rounded-r2 bg-primary/10 border border-primary/20 flex items-center justify-center text-primary shrink-0">
                  <Server size={22} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="micro-label text-white/30">LAUNCH TARGET</div>
                  <h2 className="mt-1 text-xl md:text-2xl font-bold text-white font-display tracking-tight">Choose the xorein node to connect to.</h2>
                  <p className="mt-2 text-sm text-white/50 leading-relaxed">
                    Most users should never need this screen. If the default node is unavailable, enter any HTTP or HTTPS node such as <span className="font-mono text-white/70">127.0.0.1:7711</span>. No token is needed.
                  </p>
                </div>
              </div>
            </div>

            <div className="p-6 md:p-8 space-y-5">
              {feedback && (
                <div role="alert" className="rounded-r2 border border-accent-danger/20 bg-accent-danger/10 px-4 py-3 text-sm text-accent-danger">
                  {feedback}
                </div>
              )}

              {currentNodeLabel && (
                <div className="rounded-r2 border border-white/10 bg-white/5 px-4 py-3 text-xs text-white/70">
                  Currently connected to: <span className="font-mono text-white/85 break-all">{currentNodeLabel}</span>
                </div>
              )}

              <div className="space-y-2">
                <label htmlFor="node-address" className="micro-label text-white/35 block">Node address</label>
                <div className="relative">
                  <input
                    id="node-address"
                    type="text"
                    value={endpoint}
                    onChange={(event) => onEndpointChange(event.target.value)}
                    placeholder="http://127.0.0.1:7711"
                    autoFocus
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    aria-invalid={!endpointLooksValid}
                    aria-describedby="node-address-help"
                    className={`w-full h-12 pl-4 pr-10 rounded-full bg-surface-dark border text-white text-sm font-mono placeholder:text-white/25 focus:outline-none transition-colors ${
                      endpointLooksValid ? 'border-white/10 focus:border-primary/40' : 'border-accent-danger/50 focus:border-accent-danger/70'
                    }`}
                  />
                  {endpoint && (
                    <button
                      type="button"
                      onClick={() => onEndpointChange('')}
                      aria-label="Clear node address"
                      className="focus-ring absolute right-1.5 top-1/2 -translate-y-1/2 flex h-8 w-8 items-center justify-center rounded-full text-white/40 hover:text-white hover:bg-white/10 transition-colors"
                    >
                      <X size={15} />
                    </button>
                  )}
                </div>
                <p
                  id="node-address-help"
                  className={`text-[11px] leading-relaxed ${endpointLooksValid ? 'text-white/35' : 'text-accent-danger'}`}
                >
                  {endpointLooksValid
                    ? 'Any HTTP or HTTPS node is accepted. No token is required.'
                    : 'That doesn’t look like a valid address. Try a host like 127.0.0.1:7711 or https://node.example.com.'}
                </p>
              </div>

              {isLoopbackEndpoint(endpoint) ? (
                <SecurityNote tone="info" icon={<ShieldCheck size={13} />}>
                  This node runs on your own machine, so your traffic and metadata stay on this device.
                </SecurityNote>
              ) : (
                <SecurityNote
                  tone="caution"
                  icon={<Eye size={13} />}
                  details={
                    <>
                      Metadata means the patterns around your messages — your account identifier, which
                      peers you exchange with, and the timing and size of that traffic — not the messages
                      themselves. Harmolyn still encrypts contents end-to-end, so a node operator cannot
                      read what you say, but they could log who is talking to whom. Use a node you run
                      yourself, or one operated by someone you trust, when this matters to you.
                    </>
                  }
                >
                  A remote node relays your traffic, so whoever operates it can observe metadata — which
                  accounts you contact and when — even though message contents stay end-to-end encrypted.
                  Only connect to a node you trust.
                </SecurityNote>
              )}

              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <button
                  type="button"
                  onClick={onConnect}
                  disabled={busy || !endpoint.trim() || !endpointLooksValid}
                  className="focus-ring self-center h-12 rounded-full bg-primary text-bg-0 font-bold text-sm flex items-center justify-center gap-2 hover:shadow-glow transition-all disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  {busy ? <RotateCw size={16} className="animate-spin" /> : <ArrowRight size={16} />}
                  Connect
                </button>
                <div className="flex flex-col items-center gap-1">
                  <button
                    type="button"
                    onClick={onUseDefault}
                    disabled={busy}
                    className="focus-ring h-12 w-full rounded-full border border-white/10 bg-white/5 text-white/80 font-bold text-sm flex items-center justify-center gap-2 hover:border-primary/30 hover:text-white transition-all disabled:opacity-60 disabled:cursor-not-allowed"
                  >
                    <Globe size={16} />
                    Use Default
                  </button>
                  <span className="text-[10px] text-white/40">(recommended)</span>
                </div>
                <button
                  type="button"
                  onClick={onContinueOffline}
                  disabled={busy}
                  className="focus-ring self-center h-12 rounded-full border border-white/10 bg-transparent text-white/60 font-bold text-sm flex items-center justify-center gap-2 hover:border-white/20 hover:text-white transition-all disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  <CircleOff size={16} />
                  Offline
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
