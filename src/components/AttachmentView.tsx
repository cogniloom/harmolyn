import React, { useState, useMemo, useEffect, useCallback } from 'react';
import { Paperclip, Download, X, RotateCcw } from 'lucide-react';
import type { XoreinAttachment } from '@/types';
import { downloadDecryptedAttachment } from '@/native/blobs/blobs';
import { Spinner } from '@/components/ui/Spinner';
import { createObjectUrlLease, safeDownloadName, safePreviewMime } from '@/lib/stabilization/previews';

type PreviewState = { lease: ReturnType<typeof createObjectUrlLease>; status: 'loading' | 'ready' | 'error'; url?: string; imageFailed?: boolean } | null;

/** Only explicit user actions fetch ciphertext; stale completions never expose plaintext. */
export const AttachmentView: React.FC<{ attachment: XoreinAttachment }> = ({ attachment }) => {
  // Includes the authenticated manifest, not just the reusable display name/id.
  // This identity stays in memory; it is never a DOM key, attribute or log value.
  const identity = JSON.stringify(attachment);
  const lease = useMemo(() => createObjectUrlLease(), [identity]);
  const [preview, setPreview] = useState<PreviewState>(null);
  const current = preview?.lease === lease ? preview : null;
  const name = safeDownloadName(attachment.name);
  const mime = safePreviewMime(attachment.content_type || '');
  const image = mime.startsWith('image/');
  const size = Number.isFinite(attachment.size) && attachment.size >= 0 ? `${Math.max(1, Math.round(attachment.size / 1024))} KB` : 'Unknown size';

  useEffect(() => {
    lease.activate();
    return () => lease.dispose();
  }, [lease]);

  const load = useCallback(async () => {
    const token = lease.begin();
    if (token === null) return;
    setPreview({ lease, status: 'loading' });
    try {
      const bytes = await downloadDecryptedAttachment(attachment);
      if (!lease.isCurrent(token)) return;
      const blob = new Blob([bytes as BlobPart], { type: safePreviewMime(attachment.content_type || '') });
      const url = lease.complete(token, blob);
      if (url) setPreview({ lease, status: 'ready', url });
    } catch {
      if (lease.fail(token)) setPreview({ lease, status: 'error' });
    }
  }, [attachment, lease]);

  const clear = () => { lease.release(); setPreview(null); };
  return (
    <div className="attachment-card mt-2 w-full max-w-sm rounded-lg border border-white/10 bg-white/5 p-3">
      <div className="flex min-w-0 items-start gap-2">
        <Paperclip size={18} aria-hidden="true" className="mt-0.5 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <p className="break-words text-sm text-white/90">{name}</p>
          <p className="text-xs text-white/60">{size} · End-to-end encrypted</p>
        </div>
      </div>
      {current?.status === 'ready' && current.url ? (
        <>
          {image && (current.imageFailed ? <p role="status" className="mt-3 text-sm text-white/70">This file cannot be previewed as an image. You can still save it.</p> : <img data-context-image src={current.url} alt={name} decoding="async" onError={() => setPreview(value => value?.lease === lease ? { ...value, imageFailed: true } : value)} className="mt-3 max-h-80 max-w-full rounded-lg object-contain" />)}
          <div className="mt-2 flex flex-wrap gap-2">
            <a href={current.url} download={name} className="touch-target inline-flex items-center gap-2 rounded-lg px-3 text-sm text-primary focus-ring"><Download size={16} />Save file</a>
            <button type="button" onClick={clear} className="touch-target inline-flex items-center gap-2 rounded-lg px-3 text-sm text-white/70 focus-ring"><X size={16} />Close preview</button>
          </div>
        </>
      ) : (
        <>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => void load()} disabled={current?.status === 'loading'} aria-busy={current?.status === 'loading'} className="touch-target inline-flex items-center gap-2 rounded-lg bg-white/5 px-3 text-sm text-primary hover:bg-white/10 disabled:cursor-wait disabled:opacity-60 focus-ring">
              {current?.status === 'loading' ? <Spinner size={16} /> : current?.status === 'error' ? <RotateCcw size={16} /> : <Download size={16} />}
              {current?.status === 'loading' ? 'Downloading and decrypting…' : current?.status === 'error' ? 'Retry download' : 'Download and decrypt'}
            </button>
            {current?.status === 'loading' && <button type="button" onClick={clear} className="touch-target rounded-lg px-3 text-sm text-white/70 focus-ring">Dismiss</button>}
          </div>
          {current?.status === 'error' && <p role="status" className="mt-2 text-sm text-red-300">The attachment could not be verified or downloaded. Check your connection and try again.</p>}
        </>
      )}
    </div>
  );
};
