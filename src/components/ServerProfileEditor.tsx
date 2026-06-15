import React, { useMemo, useState } from 'react';
import { X, Camera, Save } from 'lucide-react';
import { User, Server } from '@/types';
import { resolveAvatarSrc } from '@/lib/avatar';

interface ServerProfileEditorProps {
  user: User;
  server: Server;
  onClose: () => void;
  onSave: (nickname: string) => void;
}

function isProfileRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function normalizeProfileText(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function normalizeProfileStatus(value: unknown): User['status'] {
  return value === 'online' || value === 'idle' || value === 'dnd' || value === 'offline' ? value : 'offline';
}

function normalizeProfileUser(value: unknown, fallbackId: string): User {
  if (!isProfileRecord(value)) {
    return { id: fallbackId, username: fallbackId, avatar: '', status: 'offline' };
  }

  const id = normalizeProfileText(value.id, fallbackId);
  return {
    id,
    username: normalizeProfileText(value.username, id),
    avatar: typeof value.avatar === 'string' ? value.avatar : '',
    status: normalizeProfileStatus(value.status),
    ...(typeof value.role === 'string' && value.role.trim() ? { role: value.role.trim() } : {}),
    ...(typeof value.color === 'string' && value.color.trim() ? { color: value.color.trim() } : {}),
    ...(typeof value.bio === 'string' && value.bio.trim() ? { bio: value.bio.trim() } : {}),
  };
}

export const ServerProfileEditor: React.FC<ServerProfileEditorProps> = ({ user, server, onClose, onSave }) => {
  const normalizedUser = useMemo(() => normalizeProfileUser(user, 'me'), [user]);
  const [nickname, setNickname] = useState(normalizedUser.username);
  const [avatarHover, setAvatarHover] = useState(false);

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="w-full max-w-[480px] mx-6 glass-card rounded-r3 border border-stroke overflow-hidden">
        {/* Banner */}
        <div className="h-24 bg-gradient-to-r from-primary/15 via-primary/5 to-accent-purple/10 relative">
          <div className="absolute inset-0 grid-overlay opacity-20" />
          <button
            onClick={onClose}
            className="absolute top-3 right-3 w-8 h-8 rounded-full glass-panel border border-stroke-subtle flex items-center justify-center text-text-secondary hover:text-primary hover:border-primary transition-all"
          >
            <X size={16} />
          </button>
        </div>

        <div className="px-6 pb-6 -mt-10">
          {/* Avatar */}
          <div
            className="w-20 h-20 rounded-r2 border-4 border-bg-2 bg-bg-1 overflow-hidden relative cursor-pointer group mb-5"
            onMouseEnter={() => setAvatarHover(true)}
            onMouseLeave={() => setAvatarHover(false)}
          >
            <img src={resolveAvatarSrc(normalizedUser.avatar, normalizedUser.username)} className="w-full h-full object-cover group-hover:opacity-30 transition-all" alt="" />
            {avatarHover && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-1">
                <Camera size={16} className="text-primary" />
                <span className="micro-label text-[7px]">CHANGE</span>
              </div>
            )}
          </div>

          <div className="mb-6">
            <h2 className="text-title font-semibold text-text-primary mb-1">SERVER // PROFILE</h2>
            <p className="text-caption text-text-tertiary">Customize your identity for <span className="text-primary">{server.name}</span></p>
          </div>

          <div className="space-y-4">
            <div className="space-y-1.5">
              <label className="micro-label text-text-tertiary">SERVER NICKNAME</label>
              <input
                type="text"
                value={nickname}
                onChange={e => setNickname(e.target.value)}
                placeholder={normalizedUser.username}
                className="w-full h-12 px-5 rounded-full bg-surface-dark border border-stroke-subtle text-text-primary text-body placeholder:text-text-disabled focus:border-stroke-primary focus:outline-none transition-colors"
              />
              <p className="text-[10px] text-text-disabled px-3">This overrides your global display name in this server only.</p>
            </div>

            <div className="space-y-1.5">
              <label className="micro-label text-text-tertiary">SERVER BIO</label>
              <textarea
                placeholder="Tell members about yourself in this server..."
                rows={3}
                className="w-full px-5 py-3 rounded-r2 bg-surface-dark border border-stroke-subtle text-text-primary text-body placeholder:text-text-disabled focus:border-stroke-primary focus:outline-none transition-colors resize-none"
              />
            </div>
          </div>

          <div className="flex justify-end gap-3 mt-6">
            <button
              onClick={onClose}
              className="h-10 px-5 rounded-full border border-stroke-subtle text-text-secondary text-body-strong hover:bg-white/5 transition-all"
            >
              Cancel
            </button>
            <button
              onClick={() => onSave(nickname)}
              className="h-10 px-5 rounded-full bg-primary text-bg-0 font-bold text-body-strong flex items-center gap-2 hover:shadow-glow transition-all"
            >
              <Save size={14} />
              Save Profile
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
