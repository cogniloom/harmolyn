import React, { useEffect, useMemo, useState } from 'react';
import { MessageSquare, Eye, ArrowUp, ArrowDown, Plus, Pin, Search, X, ArrowLeft } from 'lucide-react';
import { USERS, CURRENT_USER } from '@/data';
import type { Channel } from '@/types';
import { usePersistentState } from '@/hooks/usePersistentState';
import { useRuntimeSnapshot } from '@/lib/xoreinRuntimeContext';
import { PREVIEW_STORAGE_KEYS } from '@/config/storageKeys';
import { resolveAvatarSrc } from '@/lib/avatar';
import { createCollisionResistantId } from '@/lib/localIds';
import { searchMessages, sendChannelMessage, type XoreinMessageRecord } from '@/lib/xoreinControl';

interface ForumPostData {
  id: string;
  title: string;
  authorId: string;
  content: string;
  tags: string[];
  timestamp: string;
  replies: number;
  views: number;
  upvotes: number;
  pinned?: boolean;
  solved?: boolean;
}

const TAG_COLORS: Record<string, string> = {
  encryption: 'bg-primary/15 text-primary border-primary/30',
  help: 'bg-accent-warning/15 text-accent-warning border-accent-warning/30',
  rfc: 'bg-accent-purple/15 text-accent-purple border-accent-purple/30',
  protocol: 'bg-primary/15 text-primary border-primary/30',
  bug: 'bg-accent-danger/15 text-accent-danger border-accent-danger/30',
  voice: 'bg-accent-warning/15 text-accent-warning border-accent-warning/30',
  showcase: 'bg-accent-success/15 text-accent-success border-accent-success/30',
  themes: 'bg-accent-purple/15 text-accent-purple border-accent-purple/30',
  discussion: 'bg-primary/15 text-primary border-primary/30',
};

type SortMode = 'latest' | 'hot' | 'top';

interface ForumChannelProps {
  channel: Channel;
  headerControl?: React.ReactNode;
}

function formatForumTimestamp(raw?: string): string {
  if (!raw) {
    return 'just now';
  }
  try {
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) {
      return raw;
    }
    return date.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  } catch {
    return raw;
  }
}

function parseForumMessage(record: Pick<XoreinMessageRecord, 'id' | 'body' | 'created_at' | 'sender_peer_id' | 'reply_to'>): ForumPostData {
  const parts = record.body.split(/\n\n+/).map((part) => part.trim()).filter(Boolean);
  const title = parts[0] || 'Untitled post';
  const tagMatches = record.body.match(/#[\w-]+/g) ?? [];
  const content = parts.slice(1).join(' ').replace(/#[\w-]+/g, '').trim();
  return {
    id: record.id,
    title,
    authorId: record.sender_peer_id,
    content,
    tags: tagMatches.map((tag) => tag.slice(1).toLowerCase()),
    timestamp: formatForumTimestamp(record.created_at),
    replies: record.reply_to ? 0 : 1,
    views: 0,
    upvotes: 1,
  };
}

function normalizeForumText(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function normalizeForumUsers(value: unknown): typeof USERS {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized: typeof USERS = [];
  const seen = new Set<string>();
  value.forEach((user, index) => {
    if (!user || typeof user !== 'object' || Array.isArray(user) || Object.getPrototypeOf(user) !== Object.prototype) {
      return;
    }
    const record = user as typeof USERS[number];
    const id = normalizeForumText(record.id, `member-${index}`);
    if (seen.has(id)) {
      return;
    }
    seen.add(id);
    normalized.push({
      ...record,
      id,
      username: normalizeForumText(record.username, id),
      avatar: typeof record.avatar === 'string' ? record.avatar : '',
      status: record.status === 'online' || record.status === 'idle' || record.status === 'dnd' || record.status === 'offline'
        ? record.status
        : 'offline',
    });
  });

  return normalized;
}

export const ForumChannel: React.FC<ForumChannelProps> = ({ channel, headerControl }) => {
  const runtimeSnapshot = useRuntimeSnapshot();
  const [storedPosts, setPosts] = usePersistentState<ForumPostData[]>(PREVIEW_STORAGE_KEYS.forum(channel.id), []);
  const [sortMode, setSortMode] = useState<SortMode>('latest');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const [draftTitle, setDraftTitle] = useState('');
  const [draftContent, setDraftContent] = useState('');
  const [draftTags, setDraftTags] = useState('');
  const [activeThread, setActiveThread] = useState<ForumPostData | null>(null);
  const [threadReply, setThreadReply] = useState('');
  const posts = useMemo(() => normalizeForumPosts(storedPosts), [storedPosts]);
  const normalizedUsers = useMemo(() => normalizeForumUsers(USERS), []);

  useEffect(() => {
    if (!runtimeSnapshot) {
      return;
    }

    void (async () => {
      const result = await searchMessages(runtimeSnapshot, {
        scope_type: 'channel',
        scope_id: channel.id,
        limit: 200,
      });
      const livePosts = result.results.map((record) => parseForumMessage(record));
      if (livePosts.length > 0) {
        setPosts(livePosts);
      }
    })();
  }, [channel.id, runtimeSnapshot, setPosts]);

  const allTags = useMemo(() => [...new Set(posts.flatMap((post) => post.tags))], [posts]);

  const filteredPosts = useMemo(() => posts
    .filter((post) => !selectedTag || post.tags.includes(selectedTag))
    .filter((post) => !searchQuery || post.title.toLowerCase().includes(searchQuery.toLowerCase()))
    .sort((a, b) => {
      if (a.pinned && !b.pinned) return -1;
      if (!a.pinned && b.pinned) return 1;
      if (sortMode === 'hot') return b.replies - a.replies;
      if (sortMode === 'top') return b.upvotes - a.upvotes;
      return 0;
    }), [posts, searchQuery, selectedTag, sortMode]);

  const vote = (id: string, delta: number) => {
    setPosts((prev) => prev.map((post) => (post.id === id ? { ...post, upvotes: Math.max(0, post.upvotes + delta) } : post)));
  };

  const submitPost = async () => {
    const title = draftTitle.trim();
    if (!title) {
      return;
    }
    const content = draftContent.trim();
    const tags = draftTags.split(',').map((tag) => tag.trim().toLowerCase()).filter(Boolean);
    const body = [title, content, tags.map((tag) => `#${tag}`).join(' ')].filter(Boolean).join('\n\n');

    if (runtimeSnapshot) {
      const record = await sendChannelMessage(runtimeSnapshot, channel.id, body);
      const livePost = parseForumMessage(record);
      setPosts((prev) => [livePost, ...prev]);
    } else {
      const post: ForumPostData = {
        id: createCollisionResistantId('fp'),
        title,
        authorId: CURRENT_USER.id,
        content,
        tags,
        timestamp: 'just now',
        replies: 0,
        views: 0,
        upvotes: 1,
      };
      setPosts((prev) => [post, ...prev]);
    }

    setDraftTitle('');
    setDraftContent('');
    setDraftTags('');
    setComposing(false);
  };

  const submitReply = async () => {
    if (!activeThread) {
      return;
    }
    const replyBody = threadReply.trim();
    if (!replyBody) {
      return;
    }

    if (runtimeSnapshot) {
      await sendChannelMessage(runtimeSnapshot, channel.id, replyBody, { reply_to: activeThread.id });
    }
    setThreadReply('');
  };

  if (activeThread) {
    const author = normalizedUsers.find((user) => user.id === activeThread.authorId);
    return (
      <div className="flex-1 flex flex-col h-full overflow-hidden">
        <div className="p-4 border-b border-white/5 flex items-center justify-between gap-2 flex-shrink-0">
          <button onClick={() => setActiveThread(null)} className="inline-flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-text-secondary hover:text-text-primary">
            <ArrowLeft size={14} />
            Back to forum
          </button>
          {headerControl}
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          <article className="glass-card rounded-r2 p-4 border border-stroke-subtle space-y-3">
            <div className="flex items-center gap-2 flex-wrap">
              {activeThread.pinned && <Pin size={10} className="text-accent-warning" />}
              <h3 className="text-body-strong text-text-primary">{activeThread.title}</h3>
              {activeThread.solved && <span className="text-[8px] font-bold px-1.5 py-0.5 rounded-full bg-accent-success/15 text-accent-success border border-accent-success/20">SOLVED</span>}
            </div>
            {activeThread.content && <p className="text-caption text-text-secondary whitespace-pre-wrap">{activeThread.content}</p>}
            <div className="flex items-center gap-3 text-text-disabled text-[10px] flex-wrap">
              {author && (
                <span className="flex items-center gap-1">
                  <img src={resolveAvatarSrc(author.avatar, author.username)} className="w-3.5 h-3.5 rounded-full" alt="" />
                  {author.username}
                </span>
              )}
              <span>{activeThread.timestamp}</span>
              <span className="flex items-center gap-0.5"><MessageSquare size={9} /> {activeThread.replies}</span>
              <span className="flex items-center gap-0.5"><Eye size={9} /> {activeThread.views}</span>
            </div>
          </article>
          <div className="glass-card rounded-r2 p-3 border border-primary/20 space-y-2">
            <textarea
              value={threadReply}
              onChange={(event) => setThreadReply(event.target.value)}
              placeholder="Reply // thread"
              aria-label="Reply // thread"
              rows={3}
              className="w-full bg-surface-dark border border-white/5 rounded-r1 px-3 py-2 text-xs text-white placeholder:text-white/25 focus:border-primary/50 focus:outline-none resize-none"
            />
            <div className="flex justify-end gap-2">
              <button onClick={() => setActiveThread(null)} className="px-4 py-1.5 rounded-full border border-stroke-subtle text-[10px] font-bold uppercase tracking-wider text-text-secondary hover:text-text-primary">
                Cancel
              </button>
              <button onClick={() => void submitReply()} className="px-4 py-1.5 rounded-full bg-primary text-bg-0 text-[10px] font-bold uppercase tracking-wider hover:shadow-glow transition-all">
                Send Reply
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden">
      <div className="p-4 border-b border-white/5 space-y-3 flex-shrink-0">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-title font-semibold text-text-primary flex items-center gap-2">
            <MessageSquare size={18} className="text-primary" />
            {channel.name.toUpperCase()} // FORUM
          </h2>
          <div className="flex items-center gap-2">
            {headerControl}
            <button onClick={() => setComposing((c) => !c)} className="h-10 px-4 rounded-full bg-primary text-bg-0 font-bold text-xs flex items-center gap-2 hover:shadow-glow transition-all">
              <Plus size={14} />
              New Post
            </button>
          </div>
        </div>

        {composing && (
          <div className="glass-card rounded-r2 p-3 border border-primary/20 space-y-2">
            <input
              value={draftTitle}
              onChange={(event) => setDraftTitle(event.target.value)}
              placeholder="Post title"
              aria-label="Post title"
              className="w-full bg-surface-dark border border-white/5 rounded-r1 px-3 py-2 text-sm text-white placeholder:text-white/25 focus:border-primary/50 focus:outline-none"
            />
            <textarea
              value={draftContent}
              onChange={(event) => setDraftContent(event.target.value)}
              placeholder="What's on your mind?"
              aria-label="Post content"
              rows={2}
              className="w-full bg-surface-dark border border-white/5 rounded-r1 px-3 py-2 text-xs text-white placeholder:text-white/25 focus:border-primary/50 focus:outline-none resize-none"
            />
            <div className="flex items-center gap-2">
              <input
                value={draftTags}
                onChange={(event) => setDraftTags(event.target.value)}
                placeholder="tags, comma, separated"
                aria-label="Post tags"
                className="flex-1 bg-surface-dark border border-white/5 rounded-full px-3 py-1.5 text-[10px] text-white placeholder:text-white/25 focus:border-primary/50 focus:outline-none"
              />
              <button onClick={() => void submitPost()} className="px-4 py-1.5 rounded-full bg-primary text-bg-0 text-[10px] font-bold hover:shadow-glow transition-all">Publish</button>
              <button onClick={() => setComposing(false)} aria-label="Cancel" className="p-1.5 rounded-full text-white/40 hover:text-white"><X size={14} /></button>
            </div>
          </div>
        )}

        <div className="flex items-center gap-3">
          <div className="relative flex-1">
            <Search size={14} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-text-disabled" />
            <input
              type="text"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Search posts..."
              aria-label="Search posts"
              className="w-full h-10 pl-9 pr-4 rounded-full bg-surface-dark border border-stroke-subtle text-text-primary text-body placeholder:text-text-disabled focus:border-stroke-primary focus:outline-none transition-colors"
            />
          </div>
          <div className="flex gap-1 bg-glass-overlay rounded-full border border-stroke-subtle p-0.5">
            {(['latest', 'hot', 'top'] as SortMode[]).map((mode) => (
              <button
                key={mode}
                onClick={() => setSortMode(mode)}
                className={`px-3 py-1.5 rounded-full text-xs font-bold uppercase tracking-wider transition-all ${
                  sortMode === mode ? 'bg-primary text-bg-0' : 'text-text-secondary hover:text-text-primary'
                }`}
              >
                {mode}
              </button>
            ))}
          </div>
        </div>

        {allTags.length > 0 && (
          <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar">
            <button
              onClick={() => setSelectedTag(null)}
              className={`px-3 py-1 rounded-full text-[10px] font-bold border transition-all flex-shrink-0 ${
                !selectedTag ? 'bg-primary/15 text-primary border-primary/30' : 'text-text-secondary border-stroke-subtle hover:bg-white/5'
              }`}
            >
              ALL
            </button>
            {allTags.map((tag) => (
              <button
                key={tag}
                onClick={() => setSelectedTag(selectedTag === tag ? null : tag)}
                className={`px-3 py-1 rounded-full text-[10px] font-bold border transition-all flex-shrink-0 ${
                  selectedTag === tag ? (TAG_COLORS[tag] || 'bg-primary/15 text-primary border-primary/30') : 'text-text-secondary border-stroke-subtle hover:bg-white/5'
                }`}
              >
                {tag.toUpperCase()}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-2">
        {filteredPosts.length === 0 && (
          <div className="text-center py-16 text-xs text-white/25">No posts yet — start the conversation.</div>
        )}
        {filteredPosts.map((post) => {
          const author = normalizedUsers.find((user) => user.id === post.authorId);
          return (
            <div key={post.id} className="w-full text-left glass-card rounded-r2 p-4 border border-stroke hover:border-stroke-strong transition-all group">
              <div className="flex items-start gap-3">
                <div className="flex flex-col items-center gap-0.5 pt-1 flex-shrink-0">
                  <button onClick={(event) => { event.stopPropagation(); vote(post.id, 1); }} aria-label="Upvote post" className="text-text-tertiary hover:text-primary transition-colors"><ArrowUp size={14} /></button>
                  <span className="text-xs font-bold text-text-secondary font-mono">{post.upvotes}</span>
                  <button onClick={(event) => { event.stopPropagation(); vote(post.id, -1); }} aria-label="Downvote post" className="text-text-tertiary hover:text-accent-danger transition-colors"><ArrowDown size={14} /></button>
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    {post.pinned && <Pin size={10} className="text-accent-warning" />}
                    {post.solved && <span className="text-[8px] font-bold px-1.5 py-0.5 rounded-full bg-accent-success/15 text-accent-success border border-accent-success/20">SOLVED</span>}
                  </div>

                  <button type="button" onClick={() => setActiveThread(post)} className="text-left">
                    <h3 className="text-body-strong text-text-primary group-hover:text-primary transition-colors mb-1.5 leading-snug">{post.title}</h3>
                  </button>
                  {post.content && <p className="text-caption text-text-secondary line-clamp-1 mb-2">{post.content}</p>}

                  <div className="flex items-center gap-3 flex-wrap">
                    {post.tags.map((tag) => (
                      <span key={tag} className={`px-2 py-0.5 rounded-full text-[9px] font-bold border ${TAG_COLORS[tag] || 'bg-white/5 text-text-secondary border-stroke-subtle'}`}>
                        {tag}
                      </span>
                    ))}
                    <div className="flex items-center gap-3 text-text-disabled text-[10px] ml-auto">
                      {author && (
                        <span className="flex items-center gap-1">
                          <img src={resolveAvatarSrc(author.avatar, author.username)} className="w-3.5 h-3.5 rounded-full" alt="" />
                          {author.username}
                        </span>
                      )}
                      <span>{post.timestamp}</span>
                      <span className="flex items-center gap-0.5"><MessageSquare size={9} /> {post.replies}</span>
                      <span className="flex items-center gap-0.5"><Eye size={9} /> {post.views}</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

function normalizeForumPosts(value: unknown): ForumPostData[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => normalizeForumPost(entry))
    .filter((post): post is ForumPostData => Boolean(post));
}

function normalizeForumPost(value: unknown): ForumPostData | null {
  if (!isPlainObject(value)) {
    return null;
  }

  const id = typeof value.id === 'string' && value.id.trim() ? value.id.trim() : '';
  const title = typeof value.title === 'string' && value.title.trim() ? value.title.trim() : '';
  const authorId = typeof value.authorId === 'string' && value.authorId.trim() ? value.authorId.trim() : '';
  const content = typeof value.content === 'string' ? value.content : '';
  const timestamp = typeof value.timestamp === 'string' ? value.timestamp : '';
  const replies = typeof value.replies === 'number' && Number.isFinite(value.replies) ? value.replies : 0;
  const views = typeof value.views === 'number' && Number.isFinite(value.views) ? value.views : 0;
  const upvotes = typeof value.upvotes === 'number' && Number.isFinite(value.upvotes) ? value.upvotes : 0;
  const tags = Array.isArray(value.tags)
    ? normalizeForumTags(value.tags)
    : [];
  const pinned = typeof value.pinned === 'boolean' ? value.pinned : undefined;
  const solved = typeof value.solved === 'boolean' ? value.solved : undefined;

  if (!id || !title || !authorId) {
    return null;
  }

  return {
    id,
    title,
    authorId,
    content,
    tags,
    timestamp,
    replies,
    views,
    upvotes,
    ...(typeof pinned === 'boolean' ? { pinned } : {}),
    ...(typeof solved === 'boolean' ? { solved } : {}),
  };
}

function normalizeForumTags(value: unknown[]): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string') {
      continue;
    }
    const tag = entry.trim().toLowerCase();
    if (!tag || seen.has(tag)) {
      continue;
    }
    seen.add(tag);
    normalized.push(tag);
  }
  return normalized;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}
