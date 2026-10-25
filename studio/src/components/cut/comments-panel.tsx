'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import Link from 'next/link';
import { Pause, Play, X } from 'lucide-react';
import { cn } from 'cn';
import {
  agentPresent,
  anchorPhrase,
  isClaimed,
  optionLabel,
  previewLabel,
  seconds,
  statusLine,
  timedLabel,
  type Message,
  type Suggestion,
  type Thread,
  type TimedRef,
} from 'mdmedia/threads';
import { conversation, type MessageView, type OptionView } from '@/lib/comments-view';
import { useMediaLinks } from '@/lib/use-media-links';
import { useNow } from '@/lib/use-now';
import { createComment, grabFrame, uploadFrame, replyTo, setOptionState, useComments, type CommentsData } from '@/lib/use-comments';
import { TONE_DOT, useCutViewer, type CommentPin, type CutViewerComments } from './cut-viewer-context';

/**
 * Review comments inside the cut viewer: a Comments panel beside Now and
 * Cut, and a pin on the timeline for each comment.
 *
 * The panel reads top to bottom: its title and Comment (C), one line when no
 * agent is listening, the threads with one status line each, then the
 * selected thread's conversation. Earlier rounds and turned-down options fold
 * away; previews play in place, each with its time and "Comment at this
 * time". The owner's actions are Comment, Reply, Accept and Reject.
 */

type Tone = CommentPin['tone'];
type Draft = { time: number; frame: Promise<Blob | null> } | null;
type ReplyAt = { at: Pick<TimedRef, 'video' | 'time'>; label: string } | null;

const date = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const firstWords = (text: string, max = 64) => { const line = text.replace(/\s+/g, ' ').trim(); return line.length > max ? `${line.slice(0, max - 1)}…` : line; };
const ignoredKey = (target: EventTarget | null) =>
  target instanceof HTMLElement && Boolean(target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"], [role="listbox"]'));

const BUTTON = 'inline-flex h-7 flex-none items-center rounded-full px-3 text-[12px] font-medium transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden disabled:opacity-50';
const PRIMARY = `${BUTTON} bg-foreground text-background hover:opacity-90`;
const QUIET = `${BUTTON} bg-foreground/[0.07] text-foreground hover:bg-foreground/[0.12]`;
const TEXT_ACTION = 'inline-flex h-7 items-center rounded-[4px] text-[12px] text-ink-muted transition-colors hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-hidden';
const FIELD = 'block w-full resize-none rounded-[8px] border border-border bg-background/50 px-3 py-2 text-[13px] leading-[19px] text-foreground placeholder:text-ink-faint focus-visible:border-foreground/30 focus-visible:outline-hidden';

function Dot({ tone, className }: { tone: Tone; className?: string }) {
  return <span aria-hidden className={cn('inline-block size-2 flex-none rounded-full', TONE_DOT[tone], className)} />;
}

/**
 * Everything the cut viewer needs for comments on one cut: the panel, the
 * pins, and which thread is selected.
 */
export function useCutComments({ productionId, cutId, cutLabel, cutHref }: {
  productionId: string;
  cutId: string;
  /** A cut's plain label, "Take 6", by id. */
  cutLabel: (cutId: string) => string;
  cutHref: (cutId: string) => string;
}): CutViewerComments {
  const data = useComments(productionId, cutId);
  const now = useNow(15_000);
  const [picked, setPicked] = useState<string | null>(null);
  // Counts the owner's own picks, so only a pick (never a live update) brings the conversation into view.
  const [reveal, setReveal] = useState(0);
  const pick = useCallback((id: string) => { setPicked(id); setReveal((n) => n + 1); }, []);
  const [draft, setDraft] = useState<Draft>(null);

  const status = useCallback((thread: Thread) => statusLine(thread, data.suggestions[thread.id] ?? [], cutLabel, now), [cutLabel, data.suggestions, now]);
  // Until the owner picks one, the first thread that needs them is open.
  const selected = picked && data.threads.some((t) => t.id === picked)
    ? picked
    : data.threads.find((t) => status(t).tone === 'needs-you')?.id ?? null;
  const pins = useMemo<CommentPin[]>(
    () => data.threads.map((t) => { const line = status(t); return { id: t.id, time: t.anchor.time, tone: line.tone, label: `${line.text} · ${firstWords(t.text, 48)}` }; }),
    [data.threads, status],
  );

  return {
    panel: (
      <CommentsPanel
        productionId={productionId}
        cutId={cutId}
        data={data}
        now={now}
        selected={selected}
        onSelect={pick}
        reveal={reveal}
        draft={draft}
        onDraft={setDraft}
        status={status}
        cutLabel={cutLabel}
        cutHref={cutHref}
      />
    ),
    pins,
    selected,
    onPin: pick,
    draft: draft?.time ?? null,
  };
}

function CommentsPanel({ productionId, cutId, data, now, selected, onSelect, reveal, draft, onDraft, status, cutLabel, cutHref }: {
  productionId: string;
  cutId: string;
  data: CommentsData;
  now: number;
  selected: string | null;
  onSelect: (id: string) => void;
  reveal: number;
  draft: Draft;
  onDraft: (draft: Draft) => void;
  status: (thread: Thread) => { tone: Tone; text: string };
  cutLabel: (cutId: string) => string;
  cutHref: (cutId: string) => string;
}) {
  const viewer = useCutViewer();
  const [showResolved, setShowResolved] = useState(false);

  const startComment = useCallback(() => {
    viewer.pause();
    const time = Math.round(viewer.currentTime() * 1000) / 1000;
    const video = viewer.video.current;
    onDraft({ time, frame: video ? grabFrame(video, viewer.frame === 'tv' ? '4:3' : '16:9') : Promise.resolve(null) });
  }, [onDraft, viewer]);

  // C comments at the playhead, as Space plays.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.repeat || ignoredKey(event.target)) return;
      if (event.key === 'c' || event.key === 'C') {
        event.preventDefault();
        startComment();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [startComment]);

  const open = data.threads.filter((t) => t.status !== 'resolved');
  const resolved = data.threads.filter((t) => t.status === 'resolved');
  const thread = data.threads.find((t) => t.id === selected) ?? null;
  const select = (t: Thread) => { onSelect(t.id); viewer.seek(t.anchor.time); };

  return (
    <section aria-label="Comments" className="min-w-0">
      <div className="flex h-8 flex-none items-center justify-between">
        <h3 className="text-[13px] font-semibold text-foreground">Comments</h3>
        <button type="button" onClick={startComment} className={cn(TEXT_ACTION, 'gap-1.5')}>
          Comment
          <kbd className="hidden h-[18px] min-w-[18px] items-center justify-center rounded-[4px] border border-border bg-foreground/[0.04] px-1 font-mono text-[10.5px] lg:inline-flex">C</kbd>
        </button>
      </div>
      <div>
        {!agentPresent(data.heartbeats, productionId, now) ? (
          <p className="flex h-7 items-center gap-2 text-[12px] text-ink-muted"><Dot tone="waiting" />Comments wait for an agent</p>
        ) : null}
        {draft ? (
          <NewComment
            key={draft.time}
            productionId={productionId}
            cutId={cutId}
            draft={draft}
            cutLabel={cutLabel}
            onDone={(created) => { onDraft(null); if (created) onSelect(created); }}
          />
        ) : null}
        {data.error ? <p role="alert" className="py-1 text-[12px] text-destructive">{data.error}</p> : null}
        {data.ready && data.threads.length === 0 && !draft ? (
          <p className="py-1 text-[13px] leading-[19px] text-ink-muted">No comments on this version. Press C at a moment to leave one.</p>
        ) : null}
        <ul className="grid gap-0.5 py-1">
          {(showResolved ? data.threads : open).map((t) => (
            <li key={t.id}><ThreadRow thread={t} status={status(t)} selected={t.id === selected} onSelect={() => select(t)} /></li>
          ))}
        </ul>
        {resolved.length ? (
          <button type="button" onClick={() => setShowResolved((v) => !v)} className={TEXT_ACTION}>
            {showResolved ? 'Hide resolved' : `${resolved.length} resolved`}
          </button>
        ) : null}
        {thread ? (
          <Conversation
            key={thread.id}
            productionId={productionId}
            thread={thread}
            messages={data.messages[thread.id] ?? []}
            suggestions={data.suggestions[thread.id] ?? []}
            claimed={isClaimed(thread, now)}
            reveal={reveal}
            cutLabel={cutLabel}
            cutHref={cutHref}
          />
        ) : null}
      </div>
    </section>
  );
}

function ThreadRow({ thread, status, selected, onSelect }: { thread: Thread; status: { tone: Tone; text: string }; selected: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className="-mx-2 grid w-[calc(100%+1rem)] grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2.5 rounded-[6px] px-2 py-1.5 text-left transition-colors hover:bg-foreground/[0.05] focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-hidden aria-pressed:bg-foreground/[0.08]"
    >
      <Dot tone={status.tone} />
      <span className="truncate text-[13px] leading-[19px] text-foreground">{status.text}</span>
      <span className="font-mono text-[12px] text-ink-faint tabular-nums">{seconds(thread.anchor.time).replace(' s', '')}</span>
      <span className="col-start-2 col-end-4 truncate text-[12.5px] leading-[18px] text-ink-muted">{firstWords(thread.text, 90)}</span>
    </button>
  );
}

function NewComment({ productionId, cutId, draft, cutLabel, onDone }: {
  productionId: string;
  cutId: string;
  draft: NonNullable<Draft>;
  cutLabel: (cutId: string) => string;
  onDone: (created: string | null) => void;
}) {
  const viewer = useCutViewer();
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const where = anchorPhrase(viewer.timeline, [], draft.time);

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!text.trim() || sending) return;
    setSending(true);
    setError('');
    try {
      // The still was taken when C was pressed; it goes up now, and a comment waits for it a moment at most.
      const frameAssetId = await Promise.race([draft.frame.then(uploadFrame), new Promise<null>((resolve) => setTimeout(() => resolve(null), 4000))]);
      const thread = await createComment(productionId, { cutId, time: draft.time, text: text.trim(), view: viewer.frame === 'tv' ? '4:3' : '16:9', frameAssetId });
      onDone(thread.id);
    } catch (e) {
      setError((e as Error).message);
      setSending(false);
    }
  };

  return (
    <form onSubmit={submit} className="grid gap-2 py-2" aria-label="New comment">
      <p className="text-[12px] leading-[17px] text-ink-muted">
        <span className="text-foreground">{cutLabel(cutId)} · {seconds(draft.time)}</span>
        {where ? ` · ${where}` : ''}
      </p>
      <textarea
        autoFocus
        rows={3}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { e.preventDefault(); onDone(null); }
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit();
        }}
        placeholder="What should change here?"
        aria-label="Comment"
        className={FIELD}
      />
      {error ? <p role="alert" className="text-[12px] text-destructive">{error}</p> : null}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={() => onDone(null)} className={QUIET}>Cancel</button>
        <button type="submit" disabled={!text.trim() || sending} className={PRIMARY}>Comment</button>
      </div>
    </form>
  );
}

function Conversation({ productionId, thread, messages, suggestions, claimed, reveal, cutLabel, cutHref }: {
  productionId: string;
  thread: Thread;
  messages: Message[];
  suggestions: Suggestion[];
  claimed: boolean;
  reveal: number;
  cutLabel: (cutId: string) => string;
  cutHref: (cutId: string) => string;
}) {
  const viewer = useCutViewer();
  const articleRef = useRef<HTMLElement>(null);
  // When the owner picks a comment, scroll the side panel to its conversation. On a phone the page
  // itself scrolls, and moving it away from the timeline they just tapped would lose their place.
  useEffect(() => {
    const article = articleRef.current;
    const scroller = article?.closest<HTMLElement>('[data-comments-scroll]');
    if (!reveal || !article || !scroller || scroller.scrollHeight <= scroller.clientHeight) return;
    const top = scroller.scrollTop + article.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 4;
    scroller.scrollTo({ top, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }, [reveal]);
  const [showEarlier, setShowEarlier] = useState(false);
  const [replyAt, setReplyAt] = useState<ReplyAt>(null);
  const replyRef = useRef<HTMLTextAreaElement>(null);
  const view = useMemo(() => conversation(messages, suggestions), [messages, suggestions]);
  const byId = useCallback((id: string) => suggestions.find((s) => s.id === id), [suggestions]);
  const previewIds = useMemo(() => suggestions.flatMap((s) => s.previews.map((p) => p.assetId)), [suggestions]);
  const { links, refresh } = useMediaLinks(previewIds);
  const timeLabel = useCallback((at: TimedRef) => timedLabel(at, cutLabel, byId), [byId, cutLabel]);

  const commentAt = useCallback((at: Pick<TimedRef, 'video' | 'time'>) => {
    setReplyAt({ at, label: timeLabel(at) });
    requestAnimationFrame(() => { replyRef.current?.focus(); replyRef.current?.scrollIntoView({ block: 'nearest' }); });
  }, [timeLabel]);

  const context = { productionId, thread, cutLabel, cutHref, links, refresh, timeLabel, onCommentAt: commentAt };
  const where = anchorPhrase(viewer.timeline, thread.anchor.items, thread.anchor.time);

  return (
    <article ref={articleRef} aria-label="Selected comment" className="mt-2 border-t border-border pt-3">
      <p className="text-[12px] leading-[17px] text-ink-muted">
        <button type="button" onClick={() => viewer.seek(thread.anchor.time)} className="text-foreground underline-offset-2 hover:underline focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-hidden">
          {cutLabel(thread.version.cutId)} · {seconds(thread.anchor.time)}
        </button>
        {where ? ` · ${where}` : ''}
      </p>
      <Byline author={thread.author} at={thread.createdAt} />
      <p className="mt-1 text-[13px] leading-[20px] whitespace-pre-wrap text-foreground/90">{thread.text}</p>

      {view.earlier.length ? (
        <button type="button" onClick={() => setShowEarlier((v) => !v)} className={cn(TEXT_ACTION, 'mt-2')} aria-expanded={showEarlier}>
          {showEarlier ? 'Hide earlier rounds' : view.earlierRounds === 1 ? 'Show the earlier round' : `Show ${view.earlierRounds} earlier rounds`}
        </button>
      ) : null}
      {showEarlier ? view.earlier.map((item) => <MessageItem key={item.message.id} item={item} {...context} />) : null}
      {view.shown.map((item) => <MessageItem key={item.message.id} item={item} {...context} />)}

      {claimed ? <p className="mt-4 flex h-6 items-center gap-2 text-[12px] text-ink-muted"><Dot tone="working" />Agent working</p> : null}
      <Reply productionId={productionId} threadId={thread.id} at={replyAt} onClearAt={() => setReplyAt(null)} inputRef={replyRef} />
    </article>
  );
}

function Byline({ author, at, children }: { author: string; at: number; children?: ReactNode }) {
  return (
    <p className="mt-1 flex flex-wrap items-baseline gap-x-2 text-[12px] leading-[18px]">
      <span className="font-medium text-foreground">{author === 'owner' ? 'You' : 'Agent'}</span>
      <span className="text-ink-faint">{date.format(at)}</span>
      {children}
    </p>
  );
}

interface ItemContext {
  productionId: string;
  thread: Thread;
  cutLabel: (cutId: string) => string;
  cutHref: (cutId: string) => string;
  links: Record<string, { content: string }>;
  refresh: () => Promise<void>;
  timeLabel: (at: TimedRef) => string;
  onCommentAt: (at: Pick<TimedRef, 'video' | 'time'>) => void;
}

function MessageItem({ item, ...context }: { item: MessageView } & ItemContext) {
  const { message, options, folded } = item;
  const [showFolded, setShowFolded] = useState(false);
  return (
    <div className="mt-4 border-t border-border pt-3">
      <MessageBody message={message} {...context} />
      {options.map((option) => <OptionBlock key={option.suggestion.id} option={option} {...context} />)}
      {folded.length ? (
        <>
          <button type="button" onClick={() => setShowFolded((v) => !v)} className={cn(TEXT_ACTION, 'mt-2')} aria-expanded={showFolded}>
            {showFolded ? 'Hide' : folded.every((s) => s.state === 'rejected') ? `${folded.length} turned down` : `${folded.length} other option${folded.length === 1 ? '' : 's'}`}
          </button>
          {showFolded ? folded.map((s) => <OptionBlock key={s.id} option={{ suggestion: s, replies: [] }} {...context} />) : null}
        </>
      ) : null}
    </div>
  );
}

/** A message: who and when, the video and time it is about, the version it presents, its words. */
function MessageBody({ message, cutLabel, cutHref, timeLabel, nested = false }: { message: Message; nested?: boolean } & Pick<ItemContext, 'cutLabel' | 'cutHref' | 'timeLabel'>) {
  const viewer = useCutViewer();
  const at = message.at;
  return (
    <>
      <Byline author={message.author} at={message.createdAt}>
        {at ? (
          at.video.kind === 'cut' && !nested ? (
            <button type="button" onClick={() => viewer.seek(at.time)} className="text-ink-muted underline-offset-2 hover:text-foreground hover:underline">at {timeLabel(at)}</button>
          ) : <span className="text-ink-muted">at {timeLabel(at)}</span>
        ) : null}
      </Byline>
      <p className="mt-1 text-[13px] leading-[20px] whitespace-pre-wrap text-foreground/90">{message.text}</p>
      {message.version ? (
        <p className="mt-2 text-[13px]">
          <Link href={cutHref(message.version.cutId)} className="font-medium text-foreground underline underline-offset-2 hover:opacity-80">Open {cutLabel(message.version.cutId)}</Link>
        </p>
      ) : null}
    </>
  );
}

function OptionBlock({ option, ...context }: { option: OptionView } & ItemContext) {
  const { suggestion: s, replies } = option;
  const { productionId, thread, cutLabel, cutHref } = context;
  const [confirm, setConfirm] = useState<'accepted' | 'rejected' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState(0);
  const label = optionLabel(s);
  const cost = [s.cost.generations === 1 ? '1 generation' : `${s.cost.generations} generations`, s.cost.minutes ? `about ${s.cost.minutes} min` : ''].filter(Boolean).join(' · ');
  const current = s.previews[preview];

  const decide = async () => {
    if (!confirm) return;
    setBusy(true);
    setError('');
    try {
      await setOptionState(productionId, thread.id, s.id, confirm);
      setConfirm(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-3" aria-label={label}>
      <p className="text-[12px] leading-[18px]">
        <span className="font-semibold text-foreground">{label}</span>
        {cost ? <span className="text-ink-muted"> · {cost}</span> : null}
      </p>
      <p className="text-[13px] leading-[19px] text-foreground/90">{s.title}</p>
      {s.previews.length > 1 ? (
        <div role="group" aria-label={`${label} previews`} className="mt-2 flex flex-wrap gap-1">
          {s.previews.map((p, i) => (
            <button
              key={p.assetId}
              type="button"
              aria-pressed={i === preview}
              onClick={() => setPreview(i)}
              className={cn('h-6 rounded-full px-2.5 text-[11.5px] transition-colors', i === preview ? 'bg-foreground/[0.14] text-foreground' : 'text-ink-muted hover:text-foreground')}
            >
              {i === 0 && !p.label ? 'This option' : p.label ?? `Preview ${i + 1}`}
            </button>
          ))}
        </div>
      ) : null}
      {current ? (
        <PreviewPlayer
          key={current.assetId}
          src={context.links[current.assetId]?.content}
          label={previewLabel(s, current.assetId)}
          durationMs={current.durationMs}
          onError={() => void context.refresh()}
          onCommentAt={(time) => context.onCommentAt({ video: { kind: 'preview', suggestionId: s.id, assetId: current.assetId }, time })}
        />
      ) : null}
      {replies.map((reply) => (
        <div key={reply.id} className="mt-3 pl-3">
          <MessageBody message={reply} nested {...context} />
        </div>
      ))}
      <Details suggestion={s} />
      {s.state === 'proposed' ? (
        confirm ? (
          <div className="mt-2 grid gap-2">
            <p className="text-[12.5px] leading-[18px] text-foreground">
              {confirm === 'accepted' ? `Accept ${label}? An agent will make it.` : `Turn down ${label}?`}
            </p>
            {error ? <p role="alert" className="text-[12px] text-destructive">{error}</p> : null}
            <div className="flex gap-2">
              <button type="button" disabled={busy} onClick={() => void decide()} className={PRIMARY}>{confirm === 'accepted' ? 'Accept' : 'Reject'}</button>
              <button type="button" disabled={busy} onClick={() => setConfirm(null)} className={QUIET}>Cancel</button>
            </div>
          </div>
        ) : (
          <div className="mt-2 flex gap-2">
            <button type="button" onClick={() => setConfirm('accepted')} className={QUIET}>Accept</button>
            <button type="button" onClick={() => setConfirm('rejected')} className={QUIET}>Reject</button>
          </div>
        )
      ) : (
        <p className="mt-2 text-[12px] text-ink-muted">
          {s.state === 'applied' && s.appliedAs ? (
            <>Made as <Link href={cutHref(s.appliedAs)} className="text-foreground underline underline-offset-2 hover:opacity-80">{cutLabel(s.appliedAs)}</Link></>
          ) : s.state === 'accepted' ? 'You accepted this' : 'Turned down'}
        </p>
      )}
    </div>
  );
}

/** The option's steps, risks and checks, folded: an agent's working, there when the owner wants it. */
function Details({ suggestion: s }: { suggestion: Suggestion }) {
  const checks = s.checks.filter((c) => c.notes || c.measured || c.verdicts?.length);
  if (!s.approach && !s.steps.length && !s.risks.length && !checks.length) return null;
  const list = 'mt-1 grid gap-1 pl-4 text-[12.5px] leading-[18px] text-foreground/85';
  return (
    <details className="group mt-1">
      <summary className={cn(TEXT_ACTION, 'cursor-pointer list-none [&::-webkit-details-marker]:hidden')}>
        <span className="group-open:hidden">How, risks and checks</span>
        <span className="hidden group-open:inline">Hide how, risks and checks</span>
      </summary>
      <div className="grid gap-3 pb-1">
        {s.approach ? <p className="text-[12.5px] leading-[18px] text-foreground/85">{s.approach}</p> : null}
        {s.steps.length ? <div><p className="text-[12px] font-medium text-ink-muted">Steps</p><ol className={cn(list, 'list-decimal')}>{s.steps.map((step, i) => <li key={i}>{step}</li>)}</ol></div> : null}
        {s.risks.length ? <div><p className="text-[12px] font-medium text-ink-muted">Risks</p><ul className={cn(list, 'list-disc')}>{s.risks.map((risk, i) => <li key={i}>{risk}</li>)}</ul></div> : null}
        {checks.length ? (
          <div>
            <p className="text-[12px] font-medium text-ink-muted">Checks</p>
            <ul className={cn(list, 'list-disc')}>
              {checks.map((c, i) => (
                <li key={i}>
                  {c.passed === undefined ? '' : c.passed ? 'Passed. ' : 'Failed. '}
                  {c.notes ?? ''}
                  {c.measured ? ` Measured: ${c.measured}.` : ''}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {s.keeps.length || s.overturns.length ? (
          <p className="text-[12px] leading-[18px] text-ink-muted">
            {[s.keeps.length ? `Keeps ${s.keeps.join(', ')}` : '', s.overturns.length ? `overturns ${s.overturns.join(', ')}` : ''].filter(Boolean).join('; ')}
          </p>
        ) : null}
      </div>
    </details>
  );
}

/** A preview, framed as the TV shows it, with its time and "Comment at this time". */
function PreviewPlayer({ src, label, durationMs, onError, onCommentAt }: { src: string | undefined; label: string; durationMs?: number; onError: () => void; onCommentAt: (time: number) => void }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [length, setLength] = useState((durationMs ?? 0) / 1000);

  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    const tick = () => { setTime(ref.current?.currentTime ?? 0); frame = requestAnimationFrame(tick); };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing]);

  const toggle = () => {
    const video = ref.current;
    if (!video) return;
    if (video.paused) void video.play().catch(() => setPlaying(false));
    else video.pause();
  };
  const seekTo = (clientX: number, bar: HTMLElement) => {
    const video = ref.current;
    if (!video || !length) return;
    const rect = bar.getBoundingClientRect();
    video.currentTime = Math.min(length, Math.max(0, ((clientX - rect.left) / rect.width) * length));
    setTime(video.currentTime);
  };

  return (
    <div className="mt-2">
      <div className="relative aspect-[4/3] overflow-hidden rounded-[8px] bg-black ring-1 ring-white/[0.08]">
        <video
          ref={ref}
          src={src}
          preload="metadata"
          playsInline
          aria-label={label}
          onClick={toggle}
          onPlay={() => setPlaying(true)}
          onPause={() => { setPlaying(false); setTime(ref.current?.currentTime ?? 0); }}
          onEnded={() => setPlaying(false)}
          onSeeked={() => setTime(ref.current?.currentTime ?? 0)}
          onLoadedMetadata={(e) => setLength(e.currentTarget.duration || length)}
          onError={onError}
          className="absolute inset-0 h-full w-full cursor-pointer object-cover"
        />
        {!src ? <p role="status" className="absolute inset-0 grid place-content-center text-[12px] text-ink-muted">Loading preview…</p> : null}
      </div>
      <div
        role="slider"
        tabIndex={0}
        aria-label={`${label} position`}
        aria-valuemin={0}
        aria-valuemax={Math.round(length * 10) / 10}
        aria-valuenow={Math.round(time * 10) / 10}
        onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); seekTo(e.clientX, e.currentTarget); }}
        onPointerMove={(e) => { if (e.currentTarget.hasPointerCapture(e.pointerId)) seekTo(e.clientX, e.currentTarget); }}
        onKeyDown={(e) => {
          const video = ref.current;
          if (!video || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
          e.preventDefault();
          e.stopPropagation();
          video.currentTime = Math.min(length, Math.max(0, video.currentTime + (e.key === 'ArrowRight' ? 0.1 : -0.1)));
        }}
        className="group relative mt-1.5 h-3 cursor-pointer touch-none outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <span className="absolute inset-x-0 top-1/2 h-[3px] -translate-y-1/2 rounded-full bg-foreground/[0.12]" />
        <span className="absolute top-1/2 left-0 h-[3px] -translate-y-1/2 rounded-full bg-foreground/70" style={{ width: `${length ? (time / length) * 100 : 0}%` }} />
      </div>
      <div className="flex h-8 items-center gap-2">
        <button
          type="button"
          onClick={toggle}
          aria-label={playing ? `Pause ${label}` : `Play ${label}`}
          className="inline-flex size-7 flex-none items-center justify-center rounded-full bg-foreground/[0.1] text-foreground transition-colors hover:bg-foreground/[0.16] focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden"
        >
          {playing ? <Pause size={13} strokeWidth={2.25} className="fill-current" /> : <Play size={13} strokeWidth={2.25} className="ml-px fill-current" />}
        </button>
        <span className="font-mono text-[12px] text-ink-muted tabular-nums">
          <span className="text-foreground">{(Math.round(time * 10) / 10).toFixed(1)}</span> / {(Math.round(length * 10) / 10).toFixed(1)}
        </span>
        <button
          type="button"
          onClick={() => { ref.current?.pause(); onCommentAt(Math.round((ref.current?.currentTime ?? time) * 1000) / 1000); }}
          className={cn(TEXT_ACTION, 'ml-auto')}
        >
          Comment at this time
        </button>
      </div>
    </div>
  );
}

function Reply({ productionId, threadId, at, onClearAt, inputRef }: {
  productionId: string;
  threadId: string;
  at: ReplyAt;
  onClearAt: () => void;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
}) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!text.trim() || sending) return;
    setSending(true);
    setError('');
    try {
      await replyTo(productionId, threadId, { text: text.trim(), ...(at ? { at: at.at } : {}) });
      setText('');
      onClearAt();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  };
  return (
    <form onSubmit={submit} className="mt-4 grid gap-2 border-t border-border pt-3" aria-label="Reply">
      {at ? (
        <p className="flex items-center gap-1 text-[12px] text-ink-muted">
          <span>At <span className="text-foreground">{at.label}</span></span>
          <button type="button" onClick={onClearAt} aria-label="Reply without a time" className="inline-flex size-5 items-center justify-center rounded-full hover:bg-foreground/[0.08] hover:text-foreground">
            <X size={12} strokeWidth={2} />
          </button>
        </p>
      ) : null}
      <textarea
        ref={inputRef}
        rows={2}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit(); }}
        placeholder="Reply"
        aria-label="Reply"
        className={FIELD}
      />
      {error ? <p role="alert" className="text-[12px] text-destructive">{error}</p> : null}
      <div className="flex justify-end">
        <button type="submit" disabled={!text.trim() || sending} className={PRIMARY}>Reply</button>
      </div>
    </form>
  );
}
