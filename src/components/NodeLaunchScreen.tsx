import React from 'react';
import { AlertTriangle, ArrowRight, CheckCircle2, CircleOff, Eye, Globe, RotateCw, Server, Shield, ShieldCheck, X } from 'lucide-react';
import type { ControlEndpointTestResult } from '@/lib/xoreinControl';
import { isPrivateNetworkHostname } from '@/lib/trustedOrigin';
import { SecurityNote } from './SecurityNote';

interface NodeLaunchScreenProps {
  endpoint: string;
  feedback?: string | null;
  busy?: boolean;
  testBusy?: boolean;
  testResult?: ControlEndpointTestResult | null;
  currentNodeLabel?: string;
  onEndpointChange: (value: string) => void;
  onTest: () => void;
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

function isPrivateNetworkEndpoint(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`);
    return isPrivateNetworkHostname(url.hostname);
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
  testBusy = false,
  testResult = null,
  currentNodeLabel,
  onEndpointChange,
  onTest,
  onConnect,
  onUseDefault,
  onContinueOffline,
}) => {
  const endpointLooksValid = isLikelyValidEndpoint(endpoint);
  const loopbackEndpoint = isLoopbackEndpoint(endpoint);
  const privateNetworkEndpoint = isPrivateNetworkEndpoint(endpoint);
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
            <h1 className="text-display-l font-bold text-text-primary font-display tracking-tight">CHOOSE A NODE</h1>
            <p className="micro-label text-text-tertiary mt-2">NETWORK // CONNECTION</p>
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
                    Enter an IP address or hostname and port. Harmolyn checks the node,
                    learns its current network address, and reconnects automatically.
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
                  Current preferred node: <span className="font-mono text-white/85 break-all">{currentNodeLabel}</span>
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
                    ? 'For example: 192.168.0.1:7711, localhost:7711, or https://node.example.com.'
                    : 'That doesn’t look like a valid address. Enter an IP or hostname and port.'}
                </p>
              </div>

              {loopbackEndpoint ? (
                <SecurityNote tone="info" icon={<ShieldCheck size={13} />}>
                  This support node runs on your machine. Message contents stay end-to-end encrypted,
                  and the metadata visible to the node remains under your control.
                </SecurityNote>
              ) : privateNetworkEndpoint ? (
                <SecurityNote tone="info" icon={<ShieldCheck size={13} />}>
                  This node is on your private network. Message contents remain end-to-end encrypted
                  and signed; the node can observe connection metadata but cannot alter accepted data.
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
                      read what you say, and signatures prevent it from silently changing accepted data,
                      but the operator could log who is talking to whom. A self-hosted node reduces that
                      metadata exposure.
                    </>
                  }
                >
                  Remote nodes are untrusted helpers, not data authorities. They can observe connection
                  metadata, but message contents remain end-to-end encrypted and signed.
                </SecurityNote>
              )}

              {testResult && (
                <div
                  data-testid="node-test-result"
                  role="status"
                  aria-live="polite"
                  className={`flex items-start gap-3 rounded-r2 border px-4 py-3 text-sm ${
                    testResult.status === 'reachable'
                      ? 'border-accent-success/25 bg-accent-success/10 text-accent-success'
                      : 'border-accent-danger/25 bg-accent-danger/10 text-accent-danger'
                  }`}
                >
                  {testResult.status === 'reachable' ? <CheckCircle2 size={17} className="mt-0.5 shrink-0" /> : <AlertTriangle size={17} className="mt-0.5 shrink-0" />}
                  <div className="min-w-0">
                    <div className="font-semibold">{testResult.status === 'reachable' ? 'Node reachable' : 'Node test failed'}</div>
                    <div className="mt-1 text-xs leading-relaxed opacity-85">{testResult.detail}</div>
                    {testResult.endpoint && <div className="mt-1 break-all font-mono text-[10px] opacity-70">{testResult.endpoint}</div>}
                  </div>
                </div>
              )}

              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
                <button
                  type="button"
                  data-testid="test-node-button"
                  onClick={onTest}
                  disabled={busy || testBusy || !endpoint.trim() || !endpointLooksValid}
                  className="focus-ring self-center h-12 rounded-full border border-primary/30 bg-primary/10 text-primary font-bold text-sm flex items-center justify-center gap-2 hover:bg-primary/15 transition-all disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  {testBusy ? <RotateCw size={16} className="animate-spin" /> : <CheckCircle2 size={16} />}
                  {testBusy ? 'Testing…' : 'Test Node'}
                </button>
                <button
                  type="button"
                  onClick={onConnect}
                  disabled={busy || testBusy || !endpoint.trim() || !endpointLooksValid}
                  className="focus-ring self-center h-12 rounded-full bg-primary text-bg-0 font-bold text-sm flex items-center justify-center gap-2 hover:shadow-glow transition-all disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  {busy ? <RotateCw size={16} className="animate-spin" /> : <ArrowRight size={16} />}
                  Connect
                </button>
                <div className="flex flex-col items-center gap-1">
                  <button
                    type="button"
                    onClick={onUseDefault}
                    disabled={busy || testBusy}
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
                  disabled={busy || testBusy}
                  className="focus-ring self-center h-12 rounded-full border border-white/10 bg-transparent text-white/60 font-bold text-sm flex items-center justify-center gap-2 hover:border-white/20 hover:text-white transition-all disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  <CircleOff size={16} />
                  Continue P2P
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
