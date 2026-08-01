import React, { useState, useCallback, useEffect } from 'react';
import { Paperclip, Download } from 'lucide-react';
import type { XoreinAttachment } from '@/types';
import { downloadDecryptedAttachment } from '@/native/blobs/blobs';
import { Spinner } from '@/components/ui/Spinner';

const isImage = (ct: string) => /^image\//i.test(ct);

/**
 * Renders an end-to-end encrypted attachment. Opaque ciphertext is fetched from
 * authenticated Xorein nodes when available, otherwise from scope peers. Nothing
 * is fetched until the user clicks "decrypt". The client verifies, decrypts, and
 * exposes the file locally; providers never receive its key or plaintext.
 */
export const AttachmentView: React.FC<{ attachment: XoreinAttachment }> = ({ attachment }) => {
  const [state, setState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);

  const load = useCallback(async () => {
    setState('loading');
    setError(null);
    try {
      const bytes = await downloadDecryptedAttachment(attachment);
      const blob = new Blob([bytes as BlobPart], { type: attachment.content_type || 'application/octet-stream' });
      setUrl(URL.createObjectURL(blob));
      setState('ready');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to decrypt attachment');
      setState('error');
    }
  }, [attachment]);

  const sizeKb = Math.max(1, Math.round(attachment.size / 1024));

  if (state === 'ready' && url) {
    return (
      <div className="mt-2 max-w-sm">
        {isImage(attachment.content_type) && (
          <img data-context-image src={url} alt={attachment.name} className="rounded-lg max-h-80 border border-white/10" />
        )}
        <a
          href={url}
          download={attachment.name}
          className="mt-1 inline-flex items-center gap-1 text-xs text-primary hover:underline"
        >
          <Download size={12} /> {attachment.name} <span className="text-white/40">({sizeKb} KB)</span>
        </a>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={load}
      disabled={state === 'loading'}
      aria-busy={state === 'loading'}
      className="mt-2 inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm hover:bg-white/10 disabled:opacity-60 disabled:cursor-wait focus-ring"
      title="End-to-end encrypted — click to download and decrypt locally"
    >
      {state === 'loading'
        ? <Spinner size={16} className="text-primary" />
        : <Paperclip size={16} className="text-primary" />}
      <span className="truncate max-w-[14rem]">{attachment.name}</span>
      <span className="text-white/40">({sizeKb} KB)</span>
      {state === 'error'
        ? <span className="text-red-400 text-xs">{error}</span>
        : <span className="text-white/30 text-xs">{state === 'loading' ? 'decrypting…' : '🔒 decrypt'}</span>}
    </button>
  );
};
