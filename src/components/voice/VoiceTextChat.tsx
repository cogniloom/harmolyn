
import React, { useState, useRef, useEffect, useMemo } from 'react';
import { Send, Hash, ChevronDown, ChevronUp } from 'lucide-react';
import { usePersistentState } from '@/hooks/usePersistentState';
import { resolveAvatarSrc } from '@/lib/avatar';
import { PREVIEW_STORAGE_KEYS } from '@/config/storageKeys';
import { createCollisionResistantId } from '@/lib/localIds';
import { useRuntimeMutations } from '@/hooks/runtime/useRuntimeMutations';

interface VoiceTextMessage {
  id: string;
  username: string;
  avatar: string;
  content: string;
  timestamp: string;
}

interface VoiceTextChatProps {
  channelId: string;
  channelName: string;
  disabledReason?: string;
}

export const VoiceTextChat: React.FC<VoiceTextChatProps> = ({ channelId, channelName, disabledReason }) => {
  const [storedMessages, setMessages] = usePersistentState<VoiceTextMessage[]>(PREVIEW_STORAGE_KEYS.voiceText(channelId), []);
  const [input, setInput] = useState('');
  const [collapsed, setCollapsed] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const messages = useMemo(() => normalizeVoiceTextMessages(storedMessages), [storedMessages]);
  const runtimeMutations = useRuntimeMutations();

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const handleSend = () => {
    if (!input.trim()) return;
    const content = input;
    // Optimistic local append so the message appears immediately.
    setMessages(prev => [...prev, {
      id: createCollisionResistantId('vt'),
      username: 'You',
      avatar: 'https://api.dicebear.com/7.x/avataaars/svg?seed=me',
      content,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    }]);
    setInput('');
    // Fire the real mutation so the message is delivered over the P2P network.
    runtimeMutations.sendChannelMessage(channelId, content).catch(() => {
      // Best-effort — the optimistic local entry already shows the message.
    });
  };

  return (
    <div className="border-t border-white/5 bg-bg-0/60 backdrop-blur-sm">
      {/* Header */}
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="w-full flex items-center justify-between px-4 py-2.5 hover:bg-white/3 transition-colors"
      >
        <div className="flex items-center gap-2">
          <Hash size={12} className="text-primary" />
          <span className="text-[10px] font-bold text-white/60 tracking-wide uppercase">{channelName} // TEXT</span>
        </div>
        {collapsed ? <ChevronUp size={14} className="text-white/30" /> : <ChevronDown size={14} className="text-white/30" />}
      </button>

      {!collapsed && (
        <>
          {disabledReason && (
            <div className="mx-3 mt-2 rounded-r1 border border-accent-warning/20 bg-accent-warning/10 px-3 py-2 text-[9px] font-mono text-accent-warning">
              {disabledReason}
            </div>
          )}

          {/* Messages */}
          <div ref={scrollRef} className="max-h-[200px] overflow-y-auto px-3 py-2 space-y-2 no-scrollbar">
            {messages.map(msg => (
              <div key={msg.id} className="flex items-start gap-2 group">
                <img src={resolveAvatarSrc(msg.avatar, msg.username)} className="w-5 h-5 rounded-full border border-white/10 mt-0.5 flex-shrink-0" alt="" />
                <div className="min-w-0">
                  <div className="flex items-baseline gap-1.5">
                    <span className="text-[10px] font-bold text-white/80">{msg.username}</span>
                    <span className="text-[8px] font-mono text-white/20">{msg.timestamp}</span>
                  </div>
                  <p className="text-[11px] text-white/60 break-words">{msg.content}</p>
                </div>
              </div>
            ))}
          </div>

          {/* Input */}
          <div className="px-3 pb-2.5 pt-1">
            <div className="flex items-center gap-2 bg-surface-dark rounded-full border border-white/5 px-3 py-1.5">
                <input
                  type="text"
                  value={input}
                  onChange={e => setInput(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleSend()}
                  placeholder={disabledReason ? 'Join voice to chat' : 'Message voice chat...'}
                  disabled={Boolean(disabledReason)}
                  className="flex-1 bg-transparent text-[11px] text-white placeholder-white/25 focus:outline-none disabled:cursor-not-allowed disabled:opacity-40"
                />
                <button
                  onClick={handleSend}
                  disabled={!input.trim() || Boolean(disabledReason)}
                  className="p-1 text-primary/50 hover:text-primary disabled:text-white/15 transition-colors"
                  aria-label="Send"
                >
                  <Send size={12} />
                </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
};

function normalizeVoiceTextMessages(value: unknown): VoiceTextMessage[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const messages: VoiceTextMessage[] = [];
  const seen = new Set<string>();

  value.forEach((entry, index) => {
    const message = normalizeVoiceTextMessage(entry, index);
    if (seen.has(message.id)) {
      return;
    }
    seen.add(message.id);
    messages.push(message);
  });

  return messages;
}

function normalizeVoiceTextMessage(value: unknown, index: number): VoiceTextMessage {
  if (!isPlainObject(value)) {
    return {
      id: `vt-${index}`,
      username: 'Unknown User',
      avatar: '',
      content: '',
      timestamp: '',
    };
  }

  return {
    id: typeof value.id === 'string' && value.id.trim() ? value.id.trim() : `vt-${index}`,
    username: typeof value.username === 'string' && value.username.trim() ? value.username.trim() : 'Unknown User',
    avatar: typeof value.avatar === 'string' ? value.avatar : '',
    content: typeof value.content === 'string' ? value.content : '',
    timestamp: typeof value.timestamp === 'string' ? value.timestamp : '',
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}
