import React, { useState } from 'react';
import { QrCode, ArrowRight, Shield, Fingerprint, Upload, KeyRound } from 'lucide-react';
import { useFeature } from '@/hooks/useFeature';
import { useRestoreIdentity } from '@/hooks/runtime/mutations';
import { useRuntimeSnapshot } from '@/lib/xoreinRuntimeContext';
import { normalizeRuntimeIdentity } from '@/lib/authPreview';
import { SecurityNote } from '@/components/SecurityNote';

interface LoginScreenProps {
  onLogin: () => void;
  onSwitchToRegister: () => void;
}

export const LoginScreen: React.FC<LoginScreenProps> = ({ onLogin, onSwitchToRegister }) => {
  const snapshot = useRuntimeSnapshot();
  const qrLoginFeatureEnabled = useFeature('qrLogin');
  const hasQrLogin = qrLoginFeatureEnabled && import.meta.env.VITE_ENABLE_QR_PAIRING === 'true';
  const [tab, setTab] = useState<'restore' | 'qr'>('restore');
  const [backupText, setBackupText] = useState('');
  const [backupPassphrase, setBackupPassphrase] = useState('');
  const [feedback, setFeedback] = useState<{ tone: 'error' | 'info'; message: string } | null>(null);
  const restoreMutation = useRestoreIdentity();

  const existingIdentity = normalizeRuntimeIdentity(snapshot?.identity);
  const storedPeerId = existingIdentity?.peer_id ?? '';
  const runtimePeerId = snapshot?.peer_id?.trim() ?? existingIdentity?.peer_id ?? '';
  const storedDisplayName = existingIdentity?.profile?.display_name ?? '';
  const identityNeedsRestart = Boolean(storedPeerId && runtimePeerId && storedPeerId !== runtimePeerId);
  const hasIdentity = Boolean(storedPeerId);

  if (hasIdentity) {
    return (
      <div className="fixed inset-0 z-[200] bg-bg-0 flex items-center justify-center overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-b from-bg-0 via-bg-2 to-bg-0" />
        <div className="absolute inset-0" style={{ background: 'radial-gradient(circle at 50% 0%, rgba(19,221,236,0.08) 0%, transparent 60%)' }} />
        <div className="absolute inset-0 grid-overlay opacity-30" />
        <div className="relative z-10 w-full max-w-[440px] mx-6">
          <div className="text-center mb-10">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-r2 bg-primary/10 border border-primary/20 mb-5 shadow-glow">
              <Shield size={28} className="text-primary" />
            </div>
            <h1 className="text-display-l font-bold text-text-primary font-display tracking-tight">HARMOLYN</h1>
            <p className="micro-label text-text-tertiary mt-2">SECURE // DECENTRALIZED // ENCRYPTED</p>
          </div>
          <div className="glass-card rounded-r3 p-8 border border-stroke text-center space-y-5">
            <h2 className="text-title font-semibold text-text-primary">IDENTITY // ACTIVE</h2>
            <div className="rounded-r2 border border-primary/30 bg-primary/5 px-4 py-3">
              <p className="text-caption text-primary font-mono break-all">{runtimePeerId || storedPeerId}</p>
              {storedDisplayName && (
                <p className="text-body-strong text-text-primary mt-1">{storedDisplayName}</p>
              )}
            </div>
            {identityNeedsRestart && (
              <div className="rounded-r2 border border-accent-danger/30 bg-accent-danger/10 px-4 py-3 text-left">
                <p className="text-caption font-semibold uppercase tracking-widest text-accent-danger">Restart required</p>
                <p className="text-caption text-text-secondary mt-1">
                  This device still has the active peer {runtimePeerId}. Restart Harmolyn or the local xorein node before continuing so it can switch to {storedPeerId}.
                </p>
              </div>
            )}
            <button
              onClick={onLogin}
              disabled={identityNeedsRestart}
              className="w-full h-14 rounded-full bg-primary text-bg-0 font-bold text-body-strong flex items-center justify-center gap-2 hover:shadow-glow transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {identityNeedsRestart ? 'RESTART REQUIRED' : 'CONTINUE'}
              <ArrowRight size={18} />
            </button>
          </div>
        </div>
      </div>
    );
  }

  const handleRestore = async (e: React.FormEvent) => {
    e.preventDefault();
    setFeedback(null);
    const backup = backupText.trim();
    if (!backup) {
      setFeedback({ tone: 'error', message: 'Paste your encrypted identity backup to restore.' });
      return;
    }
    const passphrase = backupPassphrase.trim();
    if (!passphrase) {
      setFeedback({ tone: 'error', message: 'Enter the passphrase used to encrypt this identity backup.' });
      return;
    }
    try {
      const _restored = await restoreMutation.mutateAsync({ backup, passphrase });
      const restored = _restored as { peer_id?: string; active_peer_id?: string; restart_required?: boolean };
      const activePeerId = snapshot?.peer_id?.trim() || existingIdentity?.peer_id || restored.active_peer_id?.trim() || '';
      const restoredPeerId = restored.peer_id?.trim() || '';
      if (restored.restart_required || (activePeerId && restoredPeerId && activePeerId !== restoredPeerId)) {
        setFeedback({
          tone: 'info',
          message: `Identity ${restoredPeerId} was restored to this device. Restart Harmolyn or the local xorein node before continuing so the active peer changes from ${activePeerId} to the restored identity.`,
        });
        return;
      }
      onLogin();
    } catch (error) {
      setFeedback({ tone: 'error', message: error instanceof Error ? error.message : 'Failed to restore identity.' });
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.currentTarget.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => setBackupText(String(event.target?.result ?? ''));
    reader.readAsText(file);
  };

  return (
    <div className="fixed inset-0 z-[200] bg-bg-0 flex items-center justify-center overflow-hidden">
      <div className="absolute inset-0 bg-gradient-to-b from-bg-0 via-bg-2 to-bg-0" />
      <div className="absolute inset-0" style={{ background: 'radial-gradient(circle at 50% 0%, rgba(19,221,236,0.08) 0%, transparent 60%)' }} />
      <div className="absolute inset-0 grid-overlay opacity-30" />

      <div className="relative z-10 w-full max-w-[440px] mx-6">
        <div className="text-center mb-10">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-r2 bg-primary/10 border border-primary/20 mb-5 shadow-glow">
            <Shield size={28} className="text-primary" />
          </div>
          <h1 className="text-display-l font-bold text-text-primary font-display tracking-tight">HARMOLYN</h1>
          <p className="micro-label text-text-tertiary mt-2">SECURE // DECENTRALIZED // ENCRYPTED</p>
        </div>

        {hasQrLogin && (
          <div className="flex gap-2 mb-4">
            {(['restore', 'qr'] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`flex-1 h-10 rounded-full text-caption font-bold uppercase tracking-widest transition-all ${tab === t ? 'bg-primary text-bg-0 shadow-glow' : 'bg-surface-dark border border-stroke text-text-tertiary hover:text-text-secondary'}`}
              >
                {t === 'restore' ? 'Restore' : 'QR Auth'}
              </button>
            ))}
          </div>
        )}

        {tab === 'qr' ? (
          <div className="glass-card rounded-r3 p-8 border border-stroke text-center">
            <h2 className="text-title font-semibold text-text-primary mb-2">QR // AUTHENTICATION</h2>
            <p className="text-body text-text-secondary mb-6">Scan with your Harmolyn mobile app to authenticate.</p>
            <div className="w-48 h-48 mx-auto bg-surface-dark rounded-r2 border border-stroke-strong flex items-center justify-center mb-6 relative overflow-hidden">
              <QrCode size={120} className="text-primary/30" />
              <div className="absolute left-0 right-0 h-0.5 bg-primary/50 animate-pulse top-1/2" />
            </div>
            <div className="flex items-center gap-2 justify-center text-text-tertiary">
              <Fingerprint size={14} className="text-primary" />
              <span className="text-caption">Pairing endpoint pending in the local control API</span>
            </div>
          </div>
        ) : (
          <form noValidate onSubmit={handleRestore} className="glass-card rounded-r3 p-8 border border-stroke space-y-5">
            <div className="text-center mb-2">
              <h2 className="text-title font-semibold text-text-primary">RESTORE // IDENTITY</h2>
              <p className="text-caption text-text-tertiary mt-1">Paste your encrypted identity backup or upload the backup file</p>
            </div>

            {feedback && (
              <div
                role="alert"
                className={`rounded-r2 border px-4 py-3 text-caption ${feedback.tone === 'error' ? 'border-accent-danger/30 bg-accent-danger/10 text-accent-danger' : 'border-primary/30 bg-primary/10 text-primary'}`}
              >
                {feedback.message}
              </div>
            )}

            <div className="space-y-1.5">
              <label className="micro-label text-text-tertiary">ENCRYPTED BACKUP</label>
              <textarea
                value={backupText}
                onChange={(e) => setBackupText(e.target.value)}
                rows={5}
                placeholder="Paste your identity backup here…"
                className="w-full px-5 py-4 rounded-r2 bg-surface-dark border border-stroke-subtle text-text-primary text-caption font-mono placeholder:text-text-disabled focus:border-stroke-primary focus:outline-none transition-colors resize-none"
              />
            </div>

            <div className="space-y-1.5">
              <label className="micro-label text-text-tertiary">BACKUP PASSPHRASE</label>
              <input
                type="password"
                value={backupPassphrase}
                onChange={(e) => setBackupPassphrase(e.target.value)}
                placeholder="Passphrase used when this backup was created"
                className="w-full h-12 px-5 rounded-full bg-surface-dark border border-stroke-subtle text-text-primary text-caption placeholder:text-text-disabled focus:border-stroke-primary focus:outline-none transition-colors"
              />
            </div>

            <label className="flex items-center gap-3 cursor-pointer px-1 py-2 rounded-r2 border border-dashed border-stroke hover:border-primary/40 transition-colors">
              <Upload size={16} className="text-primary flex-shrink-0" />
              <span className="text-caption text-text-secondary">Upload backup file</span>
              <input type="file" accept=".json,.txt,.bak" className="sr-only" onChange={handleFileUpload} />
            </label>

            <SecurityNote>
              Your backup and passphrase together grant full access to this identity. Anyone who has both
              can sign in as you — keep them private.
            </SecurityNote>

            <button
              type="submit"
              disabled={restoreMutation.isPending}
              className="w-full h-14 rounded-full bg-primary text-bg-0 font-bold text-body-strong flex items-center justify-center gap-2 hover:shadow-glow transition-all disabled:opacity-50"
            >
              {restoreMutation.isPending ? (
                <div className="w-5 h-5 border-2 border-bg-0/30 border-t-bg-0 rounded-full animate-spin" />
              ) : (
                <>
                  <KeyRound size={18} />
                  RESTORE IDENTITY
                </>
              )}
            </button>

            <p className="text-center text-caption text-text-tertiary mt-4">
              No backup?{' '}
              <button type="button" onClick={onSwitchToRegister} className="text-primary hover:underline font-semibold">
                Create new identity
              </button>
            </p>
          </form>
        )}
      </div>
    </div>
  );
};
