import React from 'react';
import { X, FileText } from 'lucide-react';
import { useEscapeKey } from '@/hooks/useEscapeKey';
import { getLegalDoc, type LegalDoc } from './legalDocs';

interface LegalDocViewerProps {
  docId: LegalDoc['id'];
  onClose: () => void;
}

/** Read-only, scrollable in-app viewer for a legal document (Terms/Privacy/Guidelines). */
export const LegalDocViewer: React.FC<LegalDocViewerProps> = ({ docId, onClose }) => {
  useEscapeKey(onClose);
  const doc = getLegalDoc(docId);
  if (!doc) return null;

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={doc.title}
        className="relative w-full max-w-[640px] max-h-[85vh] flex flex-col glass-card bg-bg-0 border border-white/10 rounded-r2 shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-3 p-5 border-b border-white/8">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center text-primary">
              <FileText size={18} />
            </div>
            <div>
              <h2 className="text-base font-bold text-white font-display">{doc.title}</h2>
              <p className="text-[11px] text-white/40">{doc.subtitle} · Updated {doc.updated}</p>
            </div>
          </div>
          <button onClick={onClose} aria-label="Close" className="focus-ring rounded-full p-1.5 text-white/40 hover:text-white hover:bg-white/5">
            <X size={16} />
          </button>
        </header>

        <div className="overflow-y-auto p-6 space-y-6 text-white/70">
          {doc.sections.map((section) => (
            <section key={section.heading}>
              <h3 className="text-sm font-bold text-white mb-2">{section.heading}</h3>
              {section.body.map((p, i) => (
                <p key={i} className="text-[13px] leading-relaxed text-white/60 mb-2">{p}</p>
              ))}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
};
