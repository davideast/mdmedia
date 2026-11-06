'use client';
import { Fragment, useMemo, type ReactNode } from 'react';
import { lexer, type Token, type Tokens } from 'marked';
import { cn } from 'cn';
import { CodeBlock } from '@/components/reader/code-block';
import { MermaidBlock } from '@/components/reader/mermaid-block';
import { normalizeAnalysisMarkdown, splitTimestamps } from '@/lib/analysis-draft';

// The tree reader's heading scale, so an answer reads like any other document.
const HEADINGS: Record<number, string> = {
  1: 't-h1', 2: 't-h2', 3: 'font-display text-[1.125rem] font-semibold leading-snug', 4: 'font-display text-[1rem] font-semibold leading-snug',
  5: 'font-display text-[0.9375rem] font-semibold leading-snug text-ink-muted', 6: 'font-display text-[0.875rem] font-semibold uppercase tracking-wider text-ink-muted',
};
const safeHref = (href: string) => /^(https?:|mailto:)/i.test(href.trim());

type Seek = ((seconds: number) => void) | null;

function text(value: string, seek: Seek, key: string): ReactNode {
  if (!seek) return value;
  return splitTimestamps(value).map((part, index) => typeof part === 'string' ? <Fragment key={`${key}_${index}`}>{part}</Fragment>
    : <button key={`${key}_${index}`} type="button" onClick={() => seek(part.seconds)} className="cursor-pointer rounded font-mono text-[0.92em] text-primary underline decoration-border-strong underline-offset-4 hover:decoration-primary">{part.label}</button>);
}

function inline(tokens: Token[] | undefined, seek: Seek, key: string): ReactNode[] {
  return (tokens ?? []).map((token, index) => {
    const id = `${key}_${index}`;
    switch (token.type) {
      case 'text': { const t = token as Tokens.Text; return <Fragment key={id}>{t.tokens ? inline(t.tokens, seek, id) : text(t.text, seek, id)}</Fragment>; }
      case 'escape': return <Fragment key={id}>{(token as Tokens.Escape).text}</Fragment>;
      case 'strong': return <strong key={id} className="font-semibold">{inline((token as Tokens.Strong).tokens, seek, id)}</strong>;
      case 'em': return <em key={id} className="italic">{inline((token as Tokens.Em).tokens, seek, id)}</em>;
      case 'del': return <del key={id} className="line-through text-ink-muted">{inline((token as Tokens.Del).tokens, seek, id)}</del>;
      case 'codespan': return <code key={id} className="rounded bg-surface-inset px-1.5 py-0.5 font-mono text-[0.88em]">{(token as Tokens.Codespan).text}</code>;
      case 'br': return <br key={id} />;
      case 'link': {
        const link = token as Tokens.Link;
        return safeHref(link.href)
          ? <a key={id} href={link.href} target="_blank" rel="noreferrer" className="underline decoration-border-strong underline-offset-4 transition-colors hover:text-primary">{inline(link.tokens, seek, id)}</a>
          : <Fragment key={id}>{inline(link.tokens, seek, id)}</Fragment>;
      }
      // Model output is shown, never executed: images and raw HTML stay text.
      default: return <Fragment key={id}>{'text' in token && typeof token.text === 'string' ? token.text : token.raw}</Fragment>;
    }
  });
}

function blocks(tokens: Token[], seek: Seek, key: string): ReactNode[] {
  return tokens.map((token, index) => {
    const id = `${key}_${index}`;
    switch (token.type) {
      case 'space': return null;
      case 'heading': { const h = token as Tokens.Heading; const Tag = `h${Math.min(6, Math.max(1, h.depth))}` as 'h1'; return <Tag key={id} className={cn('min-w-0', HEADINGS[h.depth] ?? HEADINGS[6])}>{inline(h.tokens, seek, id)}</Tag>; }
      case 'paragraph': return <p key={id} className="min-w-0">{inline((token as Tokens.Paragraph).tokens, seek, id)}</p>;
      case 'text': { const t = token as Tokens.Text; return <p key={id} className="min-w-0">{t.tokens ? inline(t.tokens, seek, id) : text(t.text, seek, id)}</p>; }
      case 'list': {
        const list = token as Tokens.List; const Tag = list.ordered ? 'ol' : 'ul'; const start = typeof list.start === 'number' ? list.start : 1;
        return <Tag key={id} className="grid w-full min-w-0 list-none gap-2">{list.items.map((item, i) => <li key={`${id}_${i}`} className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-baseline gap-2.5">
          <span aria-hidden="true" className="select-none font-mono text-xs text-ink-muted">{item.task ? (item.checked ? '☑' : '☐') : list.ordered ? `${start + i}.` : '•'}</span>
          <div className="grid min-w-0 gap-1.5">{blocks(item.tokens, seek, `${id}_${i}`)}</div>
        </li>)}</Tag>;
      }
      case 'blockquote': return <blockquote key={id} className="grid grid-cols-[2px_minmax(0,1fr)] gap-3 italic text-ink-muted"><span aria-hidden="true" className="rounded-full bg-border" /><div className="grid min-w-0 gap-3">{blocks((token as Tokens.Blockquote).tokens, seek, id)}</div></blockquote>;
      case 'code': { const code = token as Tokens.Code; return code.lang?.trim().toLowerCase() === 'mermaid' ? <MermaidBlock key={id} code={code.text} /> : <div key={id} className="grid min-w-0"><CodeBlock code={code.text} lang={code.lang} /></div>; }
      case 'table': {
        const table = token as Tokens.Table;
        return <div key={id} className="grid w-full overflow-x-auto rounded-lg border border-border"><table className="w-full border-collapse text-left text-sm">
          <thead className="border-b border-border bg-surface-inset"><tr>{table.header.map((cell, c) => <th key={c} className="p-2.5 font-semibold">{inline(cell.tokens, seek, `${id}_h${c}`)}</th>)}</tr></thead>
          <tbody>{table.rows.map((row, r) => <tr key={r} className="border-b border-border last:border-b-0">{row.map((cell, c) => <td key={c} className="p-2.5">{inline(cell.tokens, seek, `${id}_${r}_${c}`)}</td>)}</tr>)}</tbody>
        </table></div>;
      }
      case 'hr': return <hr key={id} className="border-t border-border" />;
      default: return <p key={id} className="min-w-0 whitespace-pre-wrap">{token.raw}</p>;
    }
  });
}

/** Pretty-printed when it parses; shown as sent when it does not. */
const prettyJson = (text: string) => { try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; } };

/**
 * An analysis answer as a document. `MM:SS` and `H:MM:SS` timestamps become
 * buttons that seek the source video when `onSeek` is given. A `json` answer
 * (one asked for with a schema) is shown as code instead.
 */
export function AnalysisAnswer({ markdown, json = false, onSeek }: { markdown: string; json?: boolean; onSeek?: (seconds: number) => void }) {
  const normalized = useMemo(() => json ? markdown : normalizeAnalysisMarkdown(markdown), [markdown, json]);
  const tokens = useMemo(() => { if (json) return null; try { return lexer(normalized, { gfm: true }); } catch { return null; } }, [normalized, json]);
  const code = useMemo(() => json ? prettyJson(markdown) : '', [markdown, json]);
  if (json) return <div className="grid w-full min-w-0 max-w-[68ch]"><CodeBlock code={code} lang="json" /></div>;
  return <article className="grid w-full min-w-0 max-w-[68ch] gap-5 text-[1.0625rem] leading-[1.68] text-foreground [overflow-wrap:anywhere]">
    {tokens ? blocks(tokens, onSeek ?? null, 'answer') : <p className="whitespace-pre-wrap">{normalized}</p>}
  </article>;
}
