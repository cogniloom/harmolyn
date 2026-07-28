import React from 'react';
import QRCode from 'qrcode';
import { ShieldCheck, ShieldAlert, Shield, X } from 'lucide-react';
import { useEscapeKey } from '@/hooks/useEscapeKey';
import {
  computeSafetyNumber, formatSafetyNumber, parseIdentityKeyBlob,
} from '@/native/identity/safetyNumber';

interface KeyVerificationProps {
  /** Display name of the peer being verified. */
  peerName: string;
  localPeerId: string;
  localIdentityKey?: string;   // b64(ed ‖ mldsa) of the local identity
  remotePeerId: string;
  remoteIdentityKey?: string;  // b64(ed ‖ mldsa) pinned for the peer
  verified?: boolean;
  changed?: boolean;
  onSetVerified: (verified: boolean) => void;
  onClose: () => void;
}

/**
 * Safety-number verification screen. Two people compare this 60-digit number over a
 * trusted channel (in person, a phone call) to confirm no relay has swapped
 * identities. It commits to both peers' hybrid (Ed25519 + ML-DSA-65) identity, so a
 * match rules out a classical OR post-quantum impersonation.
 */
export const KeyVerification: React.FC<KeyVerificationProps> = ({
  peerName, localPeerId, localIdentityKey, remotePeerId, remoteIdentityKey,
  verified, changed, onSetVerified, onClose,
}) => {
  useEscapeKey(onClose);
  const [qr, setQr] = React.useState<string | null>(null);

  const safetyNumber = React.useMemo(() => {
    const local = localIdentityKey ? parseIdentityKeyBlob(localIdentityKey) : null;
    const remote = remoteIdentityKey ? parseIdentityKeyBlob(remoteIdentityKey) : null;
    if (!local || !remote) return null;
    return computeSafetyNumber(local, localPeerId, remote, remotePeerId);
  }, [localIdentityKey, remoteIdentityKey, localPeerId, remotePeerId]);

  React.useEffect(() => {
    if (!safetyNumber) { setQr(null); return; }
    QRCode.toDataURL(safetyNumber, { width: 200, margin: 2, color: { dark: '#0d1a1b', light: '#FFFFFF' } })
      .then(setQr)
      .catch(() => setQr(null));
  }, [safetyNumber]);

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Verify safety number with ${peerName}`}
        className="relative w-full max-w-[420px] mx-4 glass-card bg-bg-0 border border-white/10 rounded-r2 shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-200"
        onClick={e => e.stopPropagation()}
      >
        <div className="p-6">
          <div className="flex items-start justify-between mb-4">
            <div className="flex items-center gap-3">
              <div className={`w-10 h-10 rounded-full flex items-center justify-center ${
                changed ? 'bg-accent-danger/15' : verified ? 'bg-accent-success/15' : 'bg-white/5'
              }`}>
                {changed
                  ? <ShieldAlert size={20} className="text-accent-danger" />
                  : verified
                    ? <ShieldCheck size={20} className="text-accent-success" />
                    : <Shield size={20} className="text-white/60" />}
              </div>
              <div>
                <h2 className="text-sm font-bold text-white font-display">Verify {peerName}</h2>
                <span className="text-[11px] text-white/40">Safety number</span>
              </div>
            </div>
            <button onClick={onClose} aria-label="Close" className="focus-ring rounded-full p-1 text-white/40 hover:text-white hover:bg-white/5">
              <X size={16} />
            </button>
          </div>

          {changed && (
            <div className="mb-4 p-3 rounded-r1 bg-accent-danger/10 border border-accent-danger/30">
              <p className="text-xs text-accent-danger font-semibold">This contact's safety number changed.</p>
              <p className="text-[11px] text-white/60 mt-1">
                Their identity keys are different from the ones you verified before. This can happen
                if they reinstalled or switched devices — but it can also mean someone is intercepting
                your messages. Compare the number below with them before trusting it again.
              </p>
            </div>
          )}

          {safetyNumber ? (
            <>
              <p className="text-xs text-white/50 mb-3">
                Compare this number with {peerName} in person or over a call you trust. If it matches
                on both screens, your conversation is private end to end.
              </p>
              {qr && (
                <div className="flex justify-center mb-3">
                  <img src={qr} alt="Safety number QR code" className="rounded-r1" width={160} height={160} />
                </div>
              )}
              <div className="p-3 rounded-r1 bg-white/5 border border-white/5 mb-5">
                <code className="block text-center text-sm text-white/80 font-mono tracking-widest leading-6 break-words">
                  {formatSafetyNumber(safetyNumber)}
                </code>
              </div>
              <button
                onClick={() => onSetVerified(!verified)}
                className={`focus-ring w-full px-5 py-2.5 rounded-full text-xs font-bold transition-all ${
                  verified
                    ? 'border border-white/10 text-white/60 hover:bg-white/5'
                    : 'bg-accent-success text-black hover:brightness-110'
                }`}
              >
                {verified ? 'Mark as unverified' : 'Mark as verified'}
              </button>
            </>
          ) : (
            <p className="text-xs text-white/50">
              A safety number appears once you and {peerName} have exchanged an encrypted message,
              which is when their identity keys are confirmed. Send a message first, then come back.
            </p>
          )}
        </div>
      </div>
    </div>
  );
};
