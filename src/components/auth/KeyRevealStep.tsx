import React, { useState } from 'react';
import { CheckCircle2, Copy, Download, KeyRound, ArrowRight, Check } from 'lucide-react';
import { useRuntimeSnapshot } from '@/lib/xoreinRuntimeContext';
import { canCopyTextToClipboardSafely, copyTextToClipboardSafely } from '@/components/contextMenuUtils';
import { downloadActiveIdentityBackup } from '@/lib/identitySwitch';
import { shortFingerprint } from '@/lib/peerLabel';
import { SecurityNote } from '@/components/SecurityNote';

interface KeyRevealStepProps {
  /** peer_id captured from the create mutation (falls back to the live snapshot). */
  peerId: string;
  displayName: string;
  /** Finish onboarding and close the auth flow. */
  onDone: () => void;
}

/**
 * Shown immediately after creating an account. Surfaces the public key (the thing
 * that actually identifies you on the network) and offers an encrypted backup
 * download. The backup is encouraged but skippable — "Continue" is always enabled.
 */
export const KeyRevealStep: React.FC<KeyRevealStepProps> = ({ peerId, displayName, onDone }) => {
  const snapshot = useRuntimeSnapshot();
  const resolvedPeerId = (peerId || snapshot?.identity?.peer_id || snapshot?.peer_id || '').trim();
  const [copied, setCopied] = useState(false);
  const [downloaded, setDownloaded] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const handleCopy = async () => {
    if (!resolvedPeerId) return;
    const ok = await copyTextToClipboardSafely(resolvedPeerId);
    if (ok) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    }
  };

  const handleDownload = async () => {
    setDownloadError(null);
    try {
      const ok = await downloadActiveIdentityBackup(resolvedPeerId);
      if (ok) setDownloaded(true);
      else setDownloadError('No saved account was found to back up.');
    } catch {
      setDownloadError('Could not create the backup file. Try again from Settings.');
    }
  };

  return (
    <div className="fixed inset-0 z-[200] bg-bg-0 flex items-center justify-center overflow-auto">
      <div className="absolute inset-0 bg-gradient-to-b from-bg-0 via-bg-2 to-bg-0" />
      <div className="absolute inset-0" style={{ background: 'radial-gradient(circle at 50% 0%, rgba(19,221,236,0.08) 0%, transparent 60%)' }} />
      <div className="absolute inset-0 grid-overlay opacity-30" />

      <div className="relative z-10 w-full max-w-[460px] mx-6 my-10">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-r2 bg-primary/10 border border-primary/20 mb-5 shadow-glow">
            <CheckCircle2 size={28} className="text-primary" />
          </div>
          <h1 className="text-display-l font-bold text-text-primary font-display tracking-tight">
            You’re all set{displayName ? `, ${displayName}` : ''}
          </h1>
          <p className="text-body text-text-secondary mt-2">Here’s your account. Save it somewhere safe.</p>
        </div>

        <div className="glass-card rounded-r3 p-8 border border-stroke space-y-6">
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <KeyRound size={14} className="text-primary" />
              <span className="micro-label text-text-tertiary">Your public key — this is your name on the network</span>
            </div>
            <div className="rounded-r2 border border-primary/30 bg-primary/5 px-4 py-3">
              <p className="text-caption text-primary font-mono break-all select-all">{resolvedPeerId || 'unavailable'}</p>
              {resolvedPeerId && (
                <p className="text-[10px] text-text-tertiary font-mono mt-1.5">{shortFingerprint(resolvedPeerId)}</p>
              )}
            </div>
            {canCopyTextToClipboardSafely() && resolvedPeerId && (
              <button
                type="button"
                onClick={() => void handleCopy()}
                className="inline-flex items-center gap-1.5 text-caption text-text-secondary hover:text-primary transition-colors"
              >
                {copied ? <Check size={13} className="text-primary" /> : <Copy size={13} />}
                {copied ? 'Copied' : 'Copy public key'}
              </button>
            )}
          </div>

          <div className="rounded-r2 border border-stroke bg-surface-dark/60 p-4 space-y-3">
            <div>
              <div className="text-body-strong text-text-primary">Save a backup of your account</div>
              <p className="text-caption text-text-tertiary leading-relaxed mt-1">
                This file is encrypted with your password. Without it, a lost device means a lost account —
                there is no reset.
              </p>
            </div>
            <button
              type="button"
              onClick={() => void handleDownload()}
              className={`w-full h-12 rounded-full font-bold text-body flex items-center justify-center gap-2 transition-all ${
                downloaded
                  ? 'bg-primary/10 border border-primary/30 text-primary'
                  : 'bg-surface-dark border border-stroke text-text-primary hover:border-stroke-primary'
              }`}
            >
              {downloaded ? <Check size={16} /> : <Download size={16} />}
              {downloaded ? 'Backup downloaded' : 'Download encrypted backup'}
            </button>
            {downloadError && (
              <p role="alert" className="text-caption text-accent-danger">{downloadError}</p>
            )}
          </div>

          <SecurityNote tone="caution" icon={<KeyRound size={13} />}>
            Your password encrypts this key on this device and can’t be reset or recovered — there is no server
            that holds it. You can always download a backup later from Settings.
          </SecurityNote>

          <button
            type="button"
            onClick={onDone}
            className="w-full h-14 rounded-full bg-primary text-bg-0 font-bold text-body-strong flex items-center justify-center gap-2 hover:shadow-glow transition-all"
          >
            {downloaded ? 'Continue' : 'Continue without a backup'}
            <ArrowRight size={18} />
          </button>
        </div>
      </div>
    </div>
  );
};
