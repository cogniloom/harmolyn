import React from 'react';
import { Spoiler } from '@/components/Spoiler';
import { safeParseUrl } from '@/lib/browserLocation';

/**
 * Lightweight markdown renderer for chat messages.
 * Supports: **bold**, *italic*, `inline code`, ```code blocks```, and [links](url)
 */
export function renderMarkdown(text: string): React.ReactNode {
  // First, extract code blocks (```)
  const codeBlockRegex = /```(?:\w*\n)?([\s\S]*?)```/g;
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  const textStr = String(text);

  while ((match = codeBlockRegex.exec(textStr)) !== null) {
    if (match.index > lastIndex) {
      parts.push(...renderInline(textStr.slice(lastIndex, match.index)));
    }
    parts.push(
      <pre key={`cb-${match.index}`} className="bg-white/5 border border-white/10 rounded-r1 px-4 py-3 my-2 font-mono text-sm text-primary/90 overflow-x-auto whitespace-pre-wrap">
        <code>{match[1].trim()}</code>
      </pre>
    );
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < textStr.length) {
    parts.push(...renderInline(textStr.slice(lastIndex)));
  }

  return parts.length === 1 ? parts[0] : <>{parts}</>;
}

function normalizeSafeUrl(url: string): string | null {
  try {
    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url)) {
      return null;
    }
    const parsed = safeParseUrl(url);
    if (!parsed || !['http:', 'https:'].includes(parsed.protocol)) {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function renderInline(text: string): React.ReactNode[] {
  // Process inline patterns: bold, italic, inline code, links, spoilers
  const inlineRegex = /(\|\|(.+?)\|\|)|(\*\*(.+?)\*\*)|(\*(.+?)\*)|(`([^`]+?)`)|(\[([^\]]+?)\]\(([^)]+?)\))|([Hh][Tt][Tt][Pp][Ss]?:\/\/[^\s<]+)/g;
  const nodes: React.ReactNode[] = [];
  let lastIdx = 0;
  let m: RegExpExecArray | null;

  while ((m = inlineRegex.exec(text)) !== null) {
    if (m.index > lastIdx) {
      nodes.push(text.slice(lastIdx, m.index));
    }

    if (m[1]) {
      // ||spoiler||
      nodes.push(<Spoiler key={`sp-${m.index}`}>{m[2]}</Spoiler>);
    } else if (m[3]) {
      // **bold**
      nodes.push(<strong key={`b-${m.index}`} className="font-bold text-foreground">{m[4]}</strong>);
    } else if (m[5]) {
      // *italic*
      nodes.push(<em key={`i-${m.index}`} className="italic text-white/80">{m[6]}</em>);
    } else if (m[7]) {
      // `inline code`
      nodes.push(
        <code key={`c-${m.index}`} className="bg-white/10 border border-white/10 rounded px-1.5 py-0.5 font-mono text-[0.85em] text-primary/80">{m[8]}</code>
      );
    } else if (m[9]) {
      // [link](url) — validate protocol
      const safeHref = normalizeSafeUrl(m[11]);
      if (safeHref) {
        nodes.push(
          <a key={`l-${m.index}`} href={safeHref} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline hover:brightness-125 transition-all">{m[10]}</a>
        );
      } else {
        nodes.push(<span key={`l-${m.index}`} className="text-accent-danger opacity-70">[unsafe link: {m[10]}]</span>);
      }
    } else if (m[12]) {
      // bare URL — already matched https?:// so safe by regex
      const safeHref = normalizeSafeUrl(m[12]);
      if (!safeHref) {
        continue;
      }
      nodes.push(
        <a key={`u-${m.index}`} href={safeHref} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline hover:brightness-125 transition-all">{m[12]}</a>
      );
    }

    lastIdx = m.index + m[0].length;
  }

  if (lastIdx < text.length) {
    nodes.push(text.slice(lastIdx));
  }

  return nodes;
}
