'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { ArrowDown, ArrowUp, BookOpen, LayoutGrid, Plus, Play, Pause, Square, Save, Trash2, Undo2 } from 'lucide-react';
import styles from './storyboard-page.module.css';
import { InspectorContent } from '@/components/shell/inspector-slot';
import { useNarration } from '@/components/shell/narration-provider';
import { useOptionalShell } from '@/components/shell/shell-context';
import { HeaderActionButton, type HeaderAction, type HeaderActions } from '@/components/shell/header-action';
import { beatReadingText } from '@/lib/storyboard-playback';
import { useStoryboardNarration } from '@/lib/use-storyboard-narration';
import { VoicePicker } from '@/components/studio/voice-picker';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { WorkbenchPanel } from '@/components/shell/workbench-panel';
import { useWorkspace } from '@/components/shell/workspace-provider';
import { studioJson } from '@/lib/media-client';
import { primeStudioResource, useStudioResource } from '@/lib/use-studio-resource';
import { emptyStoryboard, moveBeat, newBeat, parseStoryboard, restoreStoryboardDraft, storyboardHref, storyboardPath, storyboardView, type StoryBeat, type StoryboardDocument, type StoryboardResource } from '@/lib/storyboard';

const DRAFT_FIELD = 'storyboardDraft';

export function StoryboardPage({ id }: { id: string }) {
  const path = `/api/v1/storyboards/${encodeURIComponent(id)}`;
  const { data, error, reload, update } = useStudioResource<StoryboardResource>(path);
  if (data) return <StoryboardEditor key={id} resource={data} path={path} onSaved={update} />;
  return <WorkbenchPanel workspacePage title="Storyboard" icon={<LayoutGrid size={13} />}>
    <div className="grid gap-4 p-6">
      <Link href="/storyboards" className="text-sm underline">Back to storyboards</Link>
      {error ? <><p role="alert" className="text-sm text-destructive">{error}</p><Button className="justify-self-start" variant="outline" onClick={reload}>Try again</Button></> : <p role="status" className="text-sm text-ink-muted">Loading storyboard…</p>}
    </div>
  </WorkbenchPanel>;
}

function StoryboardEditor({ resource, path, onSaved }: { resource: StoryboardResource; path: string; onSaved: (resource: StoryboardResource) => void }) {
  const { store, storageUnavailable } = useWorkspace();
  const search = useSearchParams();
  const shell = useOptionalShell();
  const { draft, setDraft } = useNarration();
  const id = resource.id;
  const view = storyboardView(search.get('view'));
  const [base, setBase] = useState(resource.storyboard);
  const [title, setTitle] = useState(() => {
    const saved = store.getSnapshot().tabs.find(tab => tab.key === storyboardPath(id))?.fields[DRAFT_FIELD];
    try { return typeof saved === 'string' ? JSON.parse(saved).title ?? resource.title : resource.title; } catch { return resource.title; }
  });
  const [baseTitle, setBaseTitle] = useState(resource.title);
  const [document, setDocument] = useState<StoryboardDocument>(() => {
    const draft = store.getSnapshot().tabs.find(tab => tab.key === storyboardPath(id))?.fields[DRAFT_FIELD];
    if (typeof draft === 'string') {
      try { return restoreStoryboardDraft(JSON.parse(draft).document); } catch { /* Keep the saved version if the local draft is malformed. */ }
    }
    return resource.storyboard?.document ?? emptyStoryboard();
  });
  const [expectedRevision, setExpectedRevision] = useState(() => {
    const draft = store.getSnapshot().tabs.find(tab => tab.key === storyboardPath(id))?.fields[DRAFT_FIELD];
    if (typeof draft === 'string') {
      try { const parsed = JSON.parse(draft); restoreStoryboardDraft(parsed.document); if (Number.isSafeInteger(parsed.expectedRevision)) return parsed.expectedRevision as number; } catch { /* Use the server revision. */ }
    }
    return resource.storyboard?.revision ?? 0;
  });
  const [history, setHistory] = useState<StoryboardDocument[]>([]);
  const [saving, setSaving] = useState(false);
  const [deleteBeatId, setDeleteBeatId] = useState<string | null>(null);
  const deletingBeat = document.beats.find(beat => beat.id === deleteBeatId);
  const [error, setError] = useState('');
  const { reading, read, stop } = useStoryboardNarration(id);
  useEffect(() => () => stop(), [stop, view]);
  useEffect(() => {
    if (reading.beatId) window.document.getElementById(`beat-${reading.beatId}`)?.scrollIntoView({ block: 'nearest' });
  }, [reading.beatId]);
  const dirty = title !== baseTitle || JSON.stringify(document) !== JSON.stringify(base?.document ?? emptyStoryboard()) || expectedRevision !== (base?.revision ?? 0);
  useEffect(() => {
    // Revalidation may arrive after a cached board has already mounted. Never
    // replace a dirty draft or reset its revision to hide a concurrent edit.
    if (dirty || saving || (resource.storyboard?.revision ?? 0) <= (base?.revision ?? 0)) return;
    stop();
    setTitle(resource.title); setBaseTitle(resource.title);
    setDocument(resource.storyboard?.document ?? emptyStoryboard());
    setBase(resource.storyboard); setExpectedRevision(resource.storyboard?.revision ?? 0);
    setHistory([]);
    const tab = store.getSnapshot().tabs.find(tab => tab.key === storyboardPath(id));
    if (tab) store.setField(tab.id, DRAFT_FIELD, null);
  }, [resource, dirty, saving, base, stop, store, id]);
  const selected = document.beats.find(beat => beat.id === search.get('beat'));
  const index = selected ? document.beats.indexOf(selected) : -1;
  const estimated = document.beats.reduce((total, beat) => total + (beat.estimatedSeconds ?? 0), 0);
  const untimed = document.beats.filter(beat => beat.estimatedSeconds === null).length;

  function remember(next: StoryboardDocument, revision = expectedRevision, clear = false, nextTitle = title) {
    const tab = store.getSnapshot().tabs.find(tab => tab.key === storyboardPath(id));
    if (tab) store.setField(tab.id, DRAFT_FIELD, clear ? null : JSON.stringify({ expectedRevision: revision, title: nextTitle, document: next }));
  }

  function change(next: StoryboardDocument, checkpoint = true) {
    stop();
    if (checkpoint) setHistory(previous => [...previous.slice(-29), document]);
    setDocument(next); remember(next); setError('');
  }

  function select(beat: string | null) {
    if (beat) shell?.openContext();
    window.history.pushState(null, '', storyboardHref(id, view, beat));
  }

  // A selected beat survives switching views. Focus its story row, not an unrelated page position.
  useEffect(() => {
    if (search.get('beat')) window.document.getElementById(`beat-${search.get('beat')}`)?.scrollIntoView({ block: 'nearest' });
  }, [view, search]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  async function save() {
    setSaving(true); setError('');
    try {
      const next = await studioJson<StoryboardResource>(path, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision, title, document: parseStoryboard(document) }) });
      setBaseTitle(next.title); setBase(next.storyboard); setExpectedRevision(next.storyboard!.revision); remember(document, next.storyboard!.revision, true); onSaved(next);
      primeStudioResource('/api/v1/storyboards', null);
    } catch (e) { setError((e as Error).message); }
    finally { setSaving(false); }
  }

  async function reloadSaved() {
    stop();
    if (dirty && !window.confirm('Discard your unsaved edits and load the saved storyboard? Your current edits will be discarded.')) return;
    setSaving(true);
    try {
      const next = await studioJson<StoryboardResource>(path);
      const nextDocument = next.storyboard?.document ?? emptyStoryboard();
      setTitle(next.title); setBaseTitle(next.title); setDocument(nextDocument); setBase(next.storyboard); setExpectedRevision(next.storyboard?.revision ?? 0); setHistory([]); setError('');
      remember(nextDocument, next.storyboard?.revision ?? 0, true); onSaved(next);
    } catch (e) { setError((e as Error).message); }
    finally { setSaving(false); }
  }

  function editBeat(patch: Partial<StoryBeat>) {
    if (selected) change({ ...document, beats: document.beats.map(beat => beat.id === selected.id ? { ...beat, ...patch } : beat) });
  }

  const source = `${view}:all`;
  const allSegments = document.beats.map(beat => ({ id: beat.id, text: beatReadingText(beat, view) })).filter(segment => segment.text);
  const pauseAll = reading.source === source && reading.status === 'playing';
  const playAction: HeaderAction = {
    icon: pauseAll ? Pause : Play,
    label: pauseAll ? 'Pause reading' : reading.source === source && reading.status === 'paused' ? 'Resume reading' : view === 'script' ? 'Play script' : 'Play walkthrough',
    emphasis: 'primary', disabled: !allSegments.length || reading.status === 'loading',
    onClick: () => read(source, allSegments),
  };
  const actions: HeaderActions = reading.status === 'idle' ? [playAction] : [{ icon: Square, label: 'Stop reading', onClick: () => stop() }, playAction];

  return <WorkbenchPanel workspacePage title={`${title || 'Untitled storyboard'} · Storyboard`} icon={<LayoutGrid size={13} />} actions={actions} bodyClassName="overflow-hidden">
    <div className={styles.workspace}>
    <header className={styles.heading}>
      <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-2 text-[13px] text-ink-muted">
        <Link href="/storyboards" className="hover:underline">Storyboards</Link><span aria-hidden>/</span>
        <span aria-current="page" className="text-foreground">{title || 'Untitled storyboard'}</span>
      </nav>
      <h1 className="t-h2">{title || 'Untitled storyboard'}</h1>
    </header>

    <div className={styles.toolbar}>
      <nav aria-label="Storyboard view" className="inline-flex gap-1 rounded-lg bg-muted p-1">
        {(['board', 'script'] as const).map(mode => <Link key={mode} scroll={false} href={storyboardHref(id, mode, search.get('beat'))} aria-current={view === mode ? 'page' : undefined} className={`inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm ${view === mode ? 'bg-background font-semibold shadow-sm' : 'text-ink-muted hover:text-foreground'}`}>
          {mode === 'board' ? <LayoutGrid size={15} /> : <BookOpen size={15} />}{mode === 'board' ? 'Board' : 'Script'}
        </Link>)}
      </nav>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="ghost" disabled={saving || !history.length} onClick={() => { const previous = history.at(-1)!; setHistory(history.slice(0, -1)); change(previous, false); }}><Undo2 size={14} />Undo</Button>
        <Button size="sm" variant="outline" disabled={saving || document.beats.length >= 100} onClick={() => { const beat = newBeat(crypto.randomUUID()); change({ ...document, beats: [...document.beats, beat] }); select(beat.id); }}><Plus size={14} />Add beat</Button>
        <Button size="sm" disabled={saving || (!dirty && base !== null)} onClick={() => void save()}><Save size={14} />{saving ? 'Saving…' : 'Save'}</Button>
      </div>
    </div>

    <div className={`${styles.status} flex flex-wrap justify-between gap-2 text-xs text-ink-muted`}>
      <p>{document.beats.length} beats{estimated > 0 ? ` · ${estimated}s estimated${untimed ? ` + ${untimed} untimed` : ''}` : ' · Timing open'}</p>
      <p role="status">{dirty ? storageUnavailable ? 'Unsaved changes · browser recovery unavailable' : 'Unsaved changes · kept in this browser' : base ? `Saved · revision ${base.revision}` : 'Not saved yet'}</p>
    </div>
    {reading.error ? <p role="alert" className="px-6 py-2 text-sm text-destructive">{reading.error}</p> : null}
    {error ? <div role="alert" className="grid gap-2 rounded-md border border-destructive/40 p-3 text-sm"><p>{error}</p><div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={saving} onClick={() => void reloadSaved()}>Reload saved version</Button></div></div> : null}

    {search.get('beat') && !selected ? <p role="status" className="text-sm text-ink-muted">That beat is no longer in this storyboard. <button className="underline" onClick={() => select(null)}>Show the whole story</button></p> : null}

    <div className={styles.panels}>
      <main className={styles.canvas}>
        {!document.beats.length ? <div className="rounded-xl border border-dashed border-border p-10 text-center"><p className="font-medium">Start with the shape of the story</p><p className="mt-2 text-sm text-ink-muted">Add a beat to begin.</p></div> :
          <ol aria-label={view === 'board' ? 'Story beats' : 'Script'} className={view === 'board' ? styles.board : styles.script}>
            {document.beats.map((beat, position) => <li key={beat.id} id={`beat-${beat.id}`}>
              <article className={`${view === 'board' ? styles.card : styles.scriptSection} ${selected?.id === beat.id ? styles.selected : ''} ${reading.beatId === beat.id ? styles.reading : ''}`} aria-current={reading.beatId === beat.id ? 'step' : undefined}>
                {view === 'board' && beat.image ? <div className={styles.image}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={beat.image} alt={beat.visual || beat.title} loading="lazy" />
                </div> : null}
                <div className={styles.cardBody}>
                  <div className="flex items-center justify-between gap-2 text-xs text-ink-muted"><span className={styles.beatNumber}>{String(position + 1).padStart(2, '0')}{beat.estimatedSeconds ? ` · ~${beat.estimatedSeconds}s` : ''}</span>
                    <div className="flex items-center gap-2">
                    <HeaderActionButton action={{
                      icon: reading.source === `${view}:${beat.id}` && reading.status === 'playing' ? Pause : Play,
                      label: `${reading.source === `${view}:${beat.id}` && reading.status === 'playing' ? 'Pause' : reading.source === `${view}:${beat.id}` && reading.status === 'paused' ? 'Resume' : 'Play'} beat ${position + 1}`,
                      disabled: !beatReadingText(beat, view) || reading.status === 'loading',
                      onClick: () => read(`${view}:${beat.id}`, [{ id: beat.id, text: beatReadingText(beat, view) }]),
                    }} />
                    <button className="rounded px-2 py-1 text-xs hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring" aria-label={`Edit beat ${position + 1}: ${beat.title}`} onClick={() => select(beat.id)}>Edit</button></div>
                  </div>
                  <h2 className="text-base font-semibold leading-snug">{beat.title || 'Untitled beat'}</h2>
                  {view === 'board' ? <p className={styles.summary}>{beat.summary || beat.script || beat.visual}</p> : <>
                    {beat.visual ? <p className="text-sm italic leading-relaxed text-ink-muted">{beat.visual}</p> : null}
                    {beat.script ? <p className="whitespace-pre-wrap text-[15px] leading-7">{beat.script}</p> : <p className="text-sm text-ink-muted">Narration open</p>}
                  </>}
                </div>
              </article>
            </li>)}
          </ol>}
      </main>
      <InspectorContent><aside id="beat-details" aria-label="Beat details" className="grid gap-6">
        <div className="grid gap-2"><Label htmlFor="storyboard-reader" className="t-label">Reader</Label><VoicePicker id="storyboard-reader" value={draft.voice} onChange={voice => { stop(); setDraft({ voice }); }} /></div>
        {selected ? <>
          {selected.image ? <div className="overflow-hidden border border-border">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="w-full" src={selected.image} alt={`${selected.title} concept preview`} />
          </div> : null}
          <div className="flex items-center justify-between gap-2"><h2 className="t-label">Beat {index + 1}</h2><Button size="sm" variant="ghost" onClick={() => select(null)}>Close</Button></div>
          <fieldset disabled={saving} className="grid min-w-0 gap-6">
            <div className="grid gap-2"><Label htmlFor="beat-title" className="t-label">Title</Label><Input id="beat-title" aria-label="Beat title" maxLength={200} value={selected.title} onChange={event => editBeat({ title: event.target.value })} /></div>
            {(['summary', 'script', 'visual', 'notes'] as const).map(field => <div key={field} className="grid gap-2">
              <Label htmlFor={`beat-${field}`} className="t-label">{{ summary: 'Walkthrough', script: 'Narration', visual: 'Visual direction', notes: 'Open questions / notes' }[field]}</Label>
              <Textarea id={`beat-${field}`} aria-label={field} rows={field === 'script' ? 9 : 3} maxLength={field === 'script' ? 8000 : field === 'summary' ? 1200 : 4000} value={selected[field] ?? ''} onChange={event => editBeat({ [field]: event.target.value })} />
            </div>)}
            <div className="grid gap-2"><Label htmlFor="beat-duration" className="t-label">Estimate (seconds)</Label><Input id="beat-duration" aria-label="Estimated seconds" type="number" min={1} max={3600} step="any" value={selected.estimatedSeconds ?? ''} placeholder="Open" onChange={event => editBeat({ estimatedSeconds: Number(event.target.value) > 0 ? Math.min(3600, Number(event.target.value)) : null })} /></div>
            <div className="grid gap-2"><Label htmlFor="beat-decision" className="t-label">Story decision</Label>
              <Select disabled={saving} value={selected.status} onValueChange={value => editBeat({ status: value as StoryBeat['status'] })}>
                <SelectTrigger id="beat-decision" aria-label="Story decision" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="draft">To explore</SelectItem><SelectItem value="decided">Decided</SelectItem></SelectContent>
              </Select>
            </div>
            <div className="grid gap-2"><Label className="t-label">Order</Label><div className="grid grid-cols-2 gap-2">
              <Button size="sm" variant="outline" disabled={index === 0} onClick={() => change(moveBeat(document, selected.id, -1))}><ArrowUp size={13} />Earlier</Button>
              <Button size="sm" variant="outline" disabled={index === document.beats.length - 1} onClick={() => change(moveBeat(document, selected.id, 1))}><ArrowDown size={13} />Later</Button>
            </div></div>
            <div className="grid gap-2 border-t border-border py-2">
              <Button type="button" size="sm" variant="outline" onClick={() => setDeleteBeatId(selected.id)} className="w-full justify-center text-destructive hover:border-destructive/30 hover:bg-destructive/10 hover:text-destructive"><Trash2 size={13} strokeWidth={2} /><span>Delete beat</span></Button>
            </div>
          </fieldset>
        </> : <div className="grid gap-6">
          <h2 className="t-label">Story brief</h2>
          <div className="grid gap-2"><Label htmlFor="storyboard-title" className="t-label">Title</Label><Input id="storyboard-title" aria-label="Storyboard title" maxLength={200} disabled={saving} value={title} onChange={event => { setTitle(event.target.value); remember(document, expectedRevision, false, event.target.value); }} /></div>
          <div className="grid gap-2"><Label htmlFor="storyboard-premise" className="t-label">Premise</Label><Textarea id="storyboard-premise" aria-label="Premise" rows={9} maxLength={4000} disabled={saving} value={document.premise} onChange={event => change({ ...document, premise: event.target.value })} /></div>
        </div>}
        <Dialog open={Boolean(deletingBeat)} onOpenChange={open => { if (!open) setDeleteBeatId(null); }}>
          <DialogContent>
            <DialogHeader><DialogTitle>Delete beat?</DialogTitle><DialogDescription>Delete “{deletingBeat?.title}” from this storyboard? You can undo this change before leaving.</DialogDescription></DialogHeader>
            <DialogFooter className="gap-2 sm:gap-2.5">
              <Button variant="outline" onClick={() => setDeleteBeatId(null)}>Cancel</Button>
              <Button variant="destructive" disabled={saving} onClick={() => {
                if (!deletingBeat) return;
                change({ ...document, beats: document.beats.filter(beat => beat.id !== deletingBeat.id) });
                setDeleteBeatId(null);
                if (selected?.id === deletingBeat.id) select(null);
              }}><Trash2 size={13} strokeWidth={2} /><span>Delete beat</span></Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </aside></InspectorContent>
    </div>
  </div></WorkbenchPanel>;
}
