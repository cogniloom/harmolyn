import React, { useEffect, useMemo, useState } from 'react';
import { Megaphone, Loader2, Plus, Send, Sparkles, ThumbsUp, X } from 'lucide-react';
import type { Channel } from '@/types';
import { addReaction, searchMessages, sendChannelMessage, type XoreinMessageRecord } from '@/lib/xoreinControl';
import { useRuntimeSnapshot } from '@/lib/xoreinRuntimeContext';

interface AnnouncementChannelProps {
  channel: Channel;
  headerControl?: React.ReactNode;
}

interface AnnouncementEntry {
  message: XoreinMessageRecord;
  title: string;
  content: string;
}

function isAnnouncementRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function normalizeAnnouncementText(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function normalizeAnnouncementMessage(value: unknown): XoreinMessageRecord | null {
  if (!isAnnouncementRecord(value)) {
    return null;
  }

  const id = normalizeAnnouncementText(value.id, '');
  const scopeType = normalizeAnnouncementText(value.scope_type, '');
  const scopeId = normalizeAnnouncementText(value.scope_id, '');
  const senderPeerId = normalizeAnnouncementText(value.sender_peer_id, '');
  const body = typeof value.body === 'string' ? value.body : '';
  if (!id || !scopeType || !scopeId || !senderPeerId || !body) {
    return null;
  }

  return {
    id,
    scope_type: scopeType,
    scope_id: scopeId,
    sender_peer_id: senderPeerId,
    body,
    ...(typeof value.server_id === 'string' && value.server_id.trim() ? { server_id: value.server_id.trim() } : {}),
    ...(typeof value.reply_to === 'string' && value.reply_to.trim() ? { reply_to: value.reply_to.trim() } : {}),
    ...(typeof value.forwarded_from === 'string' && value.forwarded_from.trim() ? { forwarded_from: value.forwarded_from.trim() } : {}),
    ...(typeof value.created_at === 'string' && value.created_at.trim() ? { created_at: value.created_at.trim() } : {}),
    ...(typeof value.updated_at === 'string' && value.updated_at.trim() ? { updated_at: value.updated_at.trim() } : {}),
    ...(typeof value.deleted === 'boolean' ? { deleted: value.deleted } : {}),
  };
}

function normalizeAnnouncementEntries(value: unknown): AnnouncementEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized: AnnouncementEntry[] = [];
  const seen = new Set<string>();

  for (const entry of value) {
    const message = normalizeAnnouncementMessage(entry);
    if (!message || seen.has(message.id)) {
      continue;
    }
    seen.add(message.id);
    const parsed = splitAnnouncementBody(message.body);
    normalized.push({ message, ...parsed });
  }

  return normalized;
}

function normalizeRuntimePeerId(value: unknown): string {
  if (!isAnnouncementRecord(value)) {
    return '';
  }
  const identity = isAnnouncementRecord(value.identity) ? value.identity : null;
  return normalizeAnnouncementText(identity?.peer_id, '') || normalizeAnnouncementText(value.peer_id, '');
}

function splitAnnouncementBody(body: string): { title: string; content: string } {
  const trimmed = body.trim();
  if (!trimmed) {
    return { title: 'Announcement', content: '' };
  }

  const [firstLine, ...rest] = trimmed.split('\n');
  const content = rest.join('\n').trim();
  return {
    title: firstLine.trim() || 'Announcement',
    content: content || '',
  };
}

export const AnnouncementChannel: React.FC<AnnouncementChannelProps> = ({ channel, headerControl }) => {
  const runtimeSnapshot = useRuntimeSnapshot();
  const [entries, setEntries] = useState<AnnouncementEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [composing, setComposing] = useState(false);
  const [draftTitle, setDraftTitle] = useState('');
  const [draftContent, setDraftContent] = useState('');
  const [feedback, setFeedback] = useState<string | null>(null);
  const currentPeerId = normalizeRuntimePeerId(runtimeSnapshot);

  const loadAnnouncements = useMemo(() => async () => {
    if (!runtimeSnapshot) {
      setEntries([]);
      setFeedback('Start the local xorein runtime to load announcements.');
      return;
    }

    setLoading(true);
    setFeedback(null);
    try {
      const result = await searchMessages(runtimeSnapshot, {
        scope_type: 'channel',
        scope_id: channel.id,
        limit: 50,
      });
      setEntries(normalizeAnnouncementEntries(result.results));
    } catch (error) {
      setEntries([]);
      setFeedback(error instanceof Error ? error.message : 'Unable to load announcements from xorein.');
    } finally {
      setLoading(false);
    }
  }, [channel.id, runtimeSnapshot]);

  useEffect(() => {
    void loadAnnouncements();
  }, [loadAnnouncements]);

  const handlePublish = async () => {
    const title = draftTitle.trim();
    const content = draftContent.trim();
    if (!title && !content) {
      setFeedback('Enter a title or message before publishing.');
      return;
    }
    if (!runtimeSnapshot) {
      setFeedback('Start the local xorein runtime before publishing announcements.');
      return;
    }

    try {
      const body = [title || 'Announcement', content].filter(Boolean).join('\n\n');
      await sendChannelMessage(runtimeSnapshot, channel.id, body);
      setDraftTitle('');
      setDraftContent('');
      setComposing(false);
      setFeedback('Announcement published through xorein.');
      await loadAnnouncements();
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : 'Unable to publish announcement.');
    }
  };

  const handleReaction = async (messageId: string) => {
    if (!runtimeSnapshot) {
      setFeedback('Start the local xorein runtime before reacting to announcements.');
      return;
    }

    try {
      await addReaction(runtimeSnapshot, messageId, '👍');
      setFeedback('Reaction sent through xorein.');
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : 'Unable to react to this announcement.');
    }
  };

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden">
      <div className="px-6 py-4 border-b border-white/5 glass-realistic flex items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <Megaphone size={18} className="text-primary" />
          <div>
            <h2 className="font-bold text-white font-display text-base uppercase tracking-wide">{channel.name}</h2>
            <span className="micro-label text-white/40 tracking-widest">BROADCAST // CHANNEL</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {headerControl}
          <button onClick={() => setComposing((current) => !current)} className="flex items-center gap-1.5 px-3 py-2 rounded-full text-[10px] font-bold uppercase tracking-wider border border-primary/30 bg-primary/10 text-primary hover:bg-primary/20 transition-all">
            <Plus size={12} /> New
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4 no-scrollbar">
        {feedback && (
          <div role="status" className="glass-card rounded-r2 border border-accent-warning/20 bg-accent-warning/10 px-4 py-3 text-xs text-accent-warning">
            {feedback}
          </div>
        )}

        {composing && (
          <div className="glass-card rounded-r2 p-4 border border-primary/15 bg-primary/5 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div className="micro-label text-text-tertiary">COMPOSE // ANNOUNCEMENT</div>
              <button onClick={() => setComposing(false)} className="text-text-tertiary hover:text-primary transition-colors">
                <X size={14} />
              </button>
            </div>
            <input
              value={draftTitle}
              onChange={(e) => setDraftTitle(e.target.value)}
              placeholder="Announcement title"
              className="w-full h-12 px-4 rounded-full bg-surface-dark border border-stroke-subtle text-text-primary text-caption placeholder:text-text-disabled focus:border-stroke-primary focus:outline-none"
            />
            <textarea
              value={draftContent}
              onChange={(e) => setDraftContent(e.target.value)}
              rows={5}
              placeholder="Write the announcement body..."
              className="w-full px-4 py-3 rounded-r2 bg-surface-dark border border-stroke-subtle text-text-primary text-caption placeholder:text-text-disabled focus:border-stroke-primary focus:outline-none resize-none"
            />
            <button
              onClick={() => void handlePublish()}
              className="w-full h-12 rounded-full bg-primary text-bg-0 font-bold text-caption flex items-center justify-center gap-2 hover:shadow-glow transition-all"
            >
              <Send size={14} />
              PUBLISH THROUGH XOREIN
            </button>
          </div>
        )}

        {loading ? (
          <div className="flex flex-col items-center justify-center py-16 text-center text-text-tertiary gap-3">
            <Loader2 size={24} className="animate-spin text-primary/50" />
            <p className="text-body text-text-secondary">Loading live announcements</p>
          </div>
        ) : entries.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center text-text-tertiary gap-3">
            <Sparkles size={28} className="text-white/20" />
            <p className="text-body text-text-secondary">No announcements yet</p>
            <p className="text-caption text-text-disabled max-w-sm">Publish the first message from xorein to populate this channel.</p>
          </div>
        ) : (
          entries.map((entry) => {
            const isLocalAuthor = entry.message.sender_peer_id === currentPeerId;
            return (
              <div key={entry.message.id} className="glass-card rounded-r2 p-4 border border-primary/20 border-l-4 border-l-primary bg-primary/5 hover:border-primary/40 transition-all">
                <div className="flex items-start justify-between gap-3 mb-2">
                  <div>
                    <div className="flex items-center gap-1.5 mb-1">
                      <Megaphone size={11} className="text-primary flex-shrink-0" aria-hidden="true" />
                      <span className="micro-label text-primary tracking-widest">ANNOUNCEMENT</span>
                    </div>
                    <h3 className="text-sm font-bold text-white">{entry.title}</h3>
                    <div className="text-[10px] uppercase tracking-wider text-white/35 font-mono">
                      {isLocalAuthor ? 'You' : entry.message.sender_peer_id}
                      {entry.message.created_at ? ` // ${entry.message.created_at}` : ''}
                    </div>
                  </div>
                  <button
                    onClick={() => void handleReaction(entry.message.id)}
                    className="px-3 py-1.5 rounded-full bg-white/5 border border-white/10 text-[10px] font-bold uppercase tracking-wider text-white/50 hover:text-primary hover:border-primary/30 transition-all flex items-center gap-1.5"
                  >
                    <ThumbsUp size={12} />
                    React
                  </button>
                </div>
                {entry.content && (
                  <p className="text-[12px] text-white/70 leading-relaxed whitespace-pre-line">{entry.content}</p>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};
