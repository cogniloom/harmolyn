import React, { useEffect, useRef, useState } from 'react';
import { X, Upload, Globe, Loader2, Link as LinkIcon } from 'lucide-react';
import { useEscapeKey } from '@/hooks/useEscapeKey';

interface CreateServerModalProps {
    onClose: () => void;
    onCreate: (input: { name: string; description?: string }) => Promise<void>;
    onOpenJoin: () => void;
}

const NAME_MAX_LENGTH = 64;

export const CreateServerModal: React.FC<CreateServerModalProps> = ({ onClose, onCreate, onOpenJoin }) => {
    const [name, setName] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState('');
    const nameInputRef = useRef<HTMLInputElement>(null);

    useEscapeKey(onClose);

    // Auto-focus and select-all on mount so the user can immediately type or
    // overwrite without reaching for the mouse.
    useEffect(() => {
        nameInputRef.current?.focus();
        nameInputRef.current?.select();
    }, []);

    const canCreate = name.trim().length > 0;

    const handleCreate = async () => {
        const trimmed = name.trim();
        if (!trimmed) {
            setError('Space name is required.');
            return;
        }

        setSubmitting(true);
        setError('');
        try {
            await onCreate({
                name: trimmed,
                description: '',
            });
        } catch (nextError) {
            setError(nextError instanceof Error ? nextError.message : 'Failed to create the Space.');
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <div className="fixed inset-0 z-[120] flex items-center justify-center p-3 md:p-6 animate-in fade-in duration-300">
            <div className="absolute inset-0 bg-bg-0/90 backdrop-blur-md" onClick={onClose}></div>
            
            <div role="dialog" aria-modal="true" aria-labelledby="create-server-title" className="w-full max-w-[420px] glass-panel rounded-[52px] overflow-hidden relative shadow-[0_0_80px_rgba(0,0,0,0.8)] border border-white/10 animate-in zoom-in-95 slide-in-from-bottom-10 duration-500">
                <button onClick={onClose} aria-label="Close" className="absolute top-5 right-5 text-white/20 hover:text-white transition-colors z-10 focus-ring rounded-full"><X size={20} /></button>
                
                <div className="p-8 pt-10">
                    <header className="text-center mb-8">
                        <div className="inline-block p-3 rounded-2xl bg-primary/10 border border-primary/20 text-primary mb-5 shadow-glow">
                            <Globe size={32} />
                        </div>
                        <h2 id="create-server-title" className="text-2xl font-bold text-white mb-2.5 font-display tracking-tight uppercase">Create Space</h2>
                        <p className="text-white/40 text-xs font-light leading-relaxed max-w-sm mx-auto">Start an encrypted community for friends, a team, or anyone you invite.</p>
                    </header>
                    
                    <div className="flex flex-col items-center mb-8">
                        <div className="w-[90px] h-[90px] rounded-2xl border-2 border-dashed border-white/10 flex flex-col items-center justify-center text-white/20 hover:border-primary hover:text-primary cursor-pointer transition-all hover:bg-primary/5 group relative overflow-hidden">
                            <Upload size={26} className="mb-1.5 transition-transform group-hover:-translate-y-1" />
                            <span className="micro-label text-[7px] font-bold">Upload // Icon</span>
                            <div className="absolute inset-0 grid-overlay opacity-0 group-hover:opacity-20"></div>
                        </div>
                    </div>
                    
                    <div className="space-y-5 mb-8">
                        <div className="text-left">
                            <div className="flex items-center justify-between mb-1.5">
                                <label htmlFor="create-server-name" className="micro-label text-white/20">Space Name</label>
                                <span className="text-[9px] tabular-nums text-white/20" aria-hidden="true">{name.length}/{NAME_MAX_LENGTH}</span>
                            </div>
                            <input
                                id="create-server-name"
                                ref={nameInputRef}
                                type="text"
                                value={name}
                                maxLength={NAME_MAX_LENGTH}
                                onChange={(event) => {
                                    setName(event.target.value);
                                    if (error) {
                                        setError('');
                                    }
                                }}
                                onKeyDown={(event) => {
                                    if (event.key === 'Enter' && !submitting && canCreate) {
                                        event.preventDefault();
                                        void handleCreate();
                                    }
                                }}
                                placeholder="THE // HUB"
                                disabled={submitting}
                                className="w-full bg-bg-0/50 border border-white/10 rounded-full px-5 py-3 text-sm text-white focus:outline-none focus:border-primary focus:shadow-glow transition-all font-mono placeholder-white/10 focus-ring"
                            />
                        </div>

                        <div className="glass-card rounded-r2 border border-white/10 p-3 text-[10px] text-white/40 leading-relaxed">
                            Spaces are invite-gated. Only people with a valid signed invite can request membership;
                            each conversation displays its active encryption mode.
                        </div>

                        {error && (
                            <div className="rounded-r2 border border-accent-danger/20 bg-accent-danger/10 px-4 py-3 text-[11px] text-accent-danger" role="alert">
                                {error}
                            </div>
                        )}
                    </div>
                    
                    <div className="text-[9px] text-white/20 text-center font-light px-3">
                        By creating this Space, you become its Space Owner and accept responsibility for its rules, members, and content.
                    </div>
                    <button
                        type="button"
                        onClick={onOpenJoin}
                        disabled={submitting}
                        className="mt-5 w-full flex items-center justify-center gap-2 text-[10px] font-bold tracking-[0.22em] text-white/40 hover:text-primary transition-colors disabled:opacity-60"
                    >
                        <LinkIcon size={12} /> HAVE AN INVITE ALREADY?
                    </button>
                </div>
                
                <div className="bg-white/5 px-8 py-5 flex justify-between items-center border-t border-white/5 backdrop-blur-xl">
                    <button onClick={onClose} disabled={submitting} className="text-white/40 hover:text-white micro-label transition-all disabled:opacity-60">Cancel</button>
                    <button onClick={() => void handleCreate()} disabled={submitting || !canCreate} className="bg-primary hover:bg-primary/90 text-bg-0 font-bold py-2.5 px-8 rounded-full micro-label tracking-tight shadow-glow hover:scale-105 transition-all btn-press disabled:opacity-60 disabled:hover:scale-100 disabled:cursor-not-allowed flex items-center gap-2">
                        {submitting ? <Loader2 size={14} className="animate-spin" /> : null}
                        Create Space
                    </button>
                </div>
            </div>
        </div>
    )
}
