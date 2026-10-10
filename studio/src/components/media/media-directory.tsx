'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { AudioLines, ImageIcon, Loader2, Library, ListOrdered, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { WorkbenchPanel } from '@/components/shell/workbench-panel';
import { CreateMenu } from '@/components/shell/create-menu';
import { useRouteQuery, useWorkspaceField } from '@/components/shell/workspace-provider';
import { useNarration } from '@/components/shell/narration-provider';
import type { MediaSummary } from '@/lib/media-types';
import { MEDIA_TYPES } from '@/lib/media-types';
import { studioJson } from '@/lib/media-client';
import { deleteNarration } from '@/lib/narrations';
import { AssetImage } from './asset-image';
import { NarrationLibraryEntry } from './narration-library-entry';
import { LocalNarrationActivity } from './local-narration-activity';

type Cursor = { createdAt: number; id: string };
type Row = MediaSummary & { itemId?: string; phase?: string };
type Page = { items: Row[]; nextCursor: Cursor | null; indexing: boolean };
const labels: Record<string, string> = { queued: 'Queued', starting: 'Starting', preparing: 'Preparing visual prompt', generating: 'Generating', saving: 'Saving result', ready: 'Ready', error: 'Failed', interrupted: 'Interrupted' };
export function MediaDirectory({ kind }: { kind: 'library' | 'activity' }) {
  const [query] = useRouteQuery('q');
  const [type] = useRouteQuery('type');
  const [cursor] = useRouteQuery('cursor');
  const [back, setBack] = useWorkspaceField(`${kind}PageHistory`, '');
  const [page, setPage] = useState<Page | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [loading, setLoading] = useState(true);
  const { generationQueue } = useNarration();
  const scrollRef = useRef<HTMLDivElement>(null);
  let previous: string[] = [];
  try { const saved = JSON.parse(back || '{}'); if (saved.query === query && saved.type === type && saved.cursor === cursor && Array.isArray(saved.previous)) previous = saved.previous; } catch { /* Direct links have no page history. */ }
  function navigate(q: string, media: string, next: string, history: string[]) {
    setBack(JSON.stringify({ query: q, type: media, cursor: next, previous: history }));
    const url = new URL(window.location.href);
    for (const [key, value] of [['q', q], ['type', media], ['cursor', next]]) { if (value) url.searchParams.set(key, value); else url.searchParams.delete(key); }
    window.history.replaceState(null, '', `${url.pathname}${url.search}`);
  }
  useEffect(() => {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    const load = async () => {
      try {
        const params = new URLSearchParams({ q: query, cursor }); if (type) params.set('type', type);
        const next = await studioJson<Page>(`/api/v1/${kind === 'library' ? 'media' : 'generations'}?${params}`, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setPage(next); setError(''); setLoading(false);
        timer = setTimeout(load, next.indexing ? 200 : kind === 'activity' || next.items.some(item => ['queued', 'generating'].includes(item.status)) ? 3000 : 15_000);
      } catch (e) { if (!controller.signal.aborted) { setError((e as Error).message); setLoading(false); } }
    };
    timer = setTimeout(() => { setLoading(true); setError(''); void load(); }, 180);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [kind, query, type, cursor, retry]);
  const title = kind === 'library' ? 'Library' : 'Activity';
  const localIds = new Set(generationQueue.jobs.filter(job => job.status !== 'ready').map(job => job.narrationId));
  const rows = (page?.items ?? []).filter(row => kind !== 'activity' || row.type !== 'narration' || !localIds.has(row.itemId ?? row.id));
  const handleCancelOrphan = async (id: string) => {
    try { await deleteNarration(id); setRetry(value => value + 1); }
    catch { toast.error('Could not cancel generation.'); }
  };
  return <WorkbenchPanel workspacePage title={title} icon={kind === 'library' ? <Library size={15} /> : <ListOrdered size={15} />} viewGrid gridVariant="wide" scrollRef={scrollRef}>
    <div className="flex flex-wrap gap-2">
      <Input aria-label={`Search ${title}`} placeholder="Search titles or IDs…" className="min-w-0 flex-1" value={query} onChange={event => navigate(event.target.value.slice(0, 200), type, '', [])} />
      <select aria-label="Media type" className="rounded-md border border-input bg-background px-3 text-sm" value={type} onChange={event => navigate(query, event.target.value, '', [])}><option value="">All media</option>{MEDIA_TYPES.filter(item => item.available).map(item => <option key={item.type} value={item.type}>{item.label}</option>)}</select>
      <CreateMenu />
    </div>
    {kind === 'activity' && <LocalNarrationActivity type={type} />}
    {loading ? <p role="status" className="py-6 text-center text-sm text-ink-muted">Loading {title.toLowerCase()}…</p> : error ? <div role="alert" className="grid gap-2 text-sm text-destructive"><p>{error}</p><Button variant="outline" onClick={() => setRetry(value => value + 1)}>Retry</Button></div> : page?.indexing ? <p role="status" className="py-6 text-sm text-ink-muted">Preparing your existing Library for all media…</p> : <div className="grid gap-3" aria-label={`${title} items`}>
      {rows.map(row => kind === 'library' && row.type === 'narration' ? <NarrationLibraryEntry key={`narration_${row.id}`} id={row.id} onDeleted={() => setRetry(value => value + 1)} /> : <div key={`${row.type}_${row.id}`} className="flex min-w-0 items-center gap-2 rounded-lg border border-border bg-card/60 p-3 hover:bg-card"><Link href={row.href} className="flex min-w-0 flex-1 items-center gap-4">
        {row.thumbnailAssetId && kind === 'library' ? <AssetImage id={row.thumbnailAssetId} thumbnail alt={row.title} className="h-20 w-28 shrink-0 rounded-md" /> : row.type === 'image' ? <ImageIcon size={22} className="shrink-0 text-ink-muted" /> : <AudioLines size={22} className="shrink-0 text-ink-muted" />}
        <div className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{row.title}</span><span className="mt-1 block text-xs text-ink-muted">{MEDIA_TYPES.find(item => item.type === row.type)?.label} · {labels[row.phase ?? row.status] ?? row.status} · {new Date(row.createdAt).toLocaleString()}</span></div>
        {['queued', 'generating'].includes(row.status) && <Loader2 size={16} className="shrink-0 animate-spin text-primary" />}
      </Link>{kind === 'activity' && row.type === 'narration' && row.status === 'generating' && <Button variant="ghost" size="icon" title="Cancel generation" aria-label={`Cancel ${row.title}`} onClick={() => void handleCancelOrphan(row.itemId ?? row.id)}><X size={16} /></Button>}</div>)}
      {!rows.length && <p className="py-8 text-center text-sm text-ink-muted">{query ? 'No matches in this batch. Continue to older work if available.' : kind === 'library' ? 'Your saved narrations and images appear here.' : 'Generation attempts appear here across all media.'}</p>}
    </div>}
    {!loading && !error && !page?.indexing && (cursor || page?.nextCursor) && <div className="flex items-center justify-between gap-2"><Button variant="outline" disabled={!cursor} onClick={() => navigate(query, type, previous.at(-1) ?? '', previous.slice(0, -1))}>Previous</Button><span className="text-xs text-ink-muted">Up to 50 items per page</span><Button variant="outline" disabled={!page?.nextCursor} onClick={() => navigate(query, type, JSON.stringify(page?.nextCursor), [...previous, cursor])}>{query ? 'Continue search' : 'Older work'}</Button></div>}
  </WorkbenchPanel>;
}
