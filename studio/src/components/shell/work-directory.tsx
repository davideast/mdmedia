"use client";

import { useMemo } from 'react';
import Link from 'next/link';
import { Pin, PinOff, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { WorkbenchPanel } from './workbench-panel';
import { useRouteQuery, useWorkspace } from './workspace-provider';
import { workspaceItems, workPage } from '@/lib/workspace-navigation';

export function WorkDirectory({ kind }: { kind: 'drafts' | 'pinned' | 'recent' }) {
  const { state, store, newDraft } = useWorkspace();
  const [query] = useRouteQuery('q');
  const [page] = useRouteQuery('page');
  const items = useMemo(() => workspaceItems(state).filter((item) => kind === 'drafts' ? !!item.draftId : kind === 'pinned' ? item.pinned : item.visitedAt > 0).slice(0, kind === 'recent' ? 50 : undefined), [state, kind]);
  const result = useMemo(() => workPage(items, query, Number(page) || 1), [items, query, page]);
  const update = (q: string, p: number) => {
    const url = new URL(window.location.href);
    if (q) url.searchParams.set('q', q); else url.searchParams.delete('q');
    if (p > 1) url.searchParams.set('page', String(p)); else url.searchParams.delete('page');
    window.history.replaceState(null, '', `${url.pathname}${url.search}`);
  };
  const title = kind === 'drafts' ? 'Drafts' : kind === 'pinned' ? 'Pinned' : 'Recent';
  return <WorkbenchPanel workspacePage title={title} viewGrid gridVariant="wide">
    <div className="flex min-w-0 flex-wrap gap-2">
      <Input aria-label={`Search ${title.toLowerCase()}`} className="min-w-0 flex-1" placeholder={`Search ${title.toLowerCase()}…`} value={query} onChange={(event) => update(event.target.value, 1)} />
      {kind === 'drafts' && <Button onClick={newDraft}><Plus size={15} />New draft</Button>}
    </div>
    <p className="text-sm text-ink-muted">{result.count} {title.toLowerCase()} · {kind === 'recent' ? 'Last 50 opened documents' : 'Saved on this device for your account'}</p>
    <div className="grid gap-2" aria-label={`${title} documents`}>
      {result.items.map((item) => <div key={item.key} className="flex min-w-0 items-center gap-2 rounded-lg border border-border p-3">
        <Link href={item.href} className="min-w-0 flex-1" title={item.title}>
          <span className="block truncate text-sm font-medium">{item.title}</span>
          <span className="block truncate text-xs text-ink-muted">{item.detail}</span>
        </Link>
        <button type="button" aria-label={`${item.pinned ? 'Unpin' : 'Pin'} ${item.title}`} aria-pressed={item.pinned}
          onClick={() => { const view = item.viewId ? state.tabs.find((view) => view.id === item.viewId) : undefined;
            if (view) store.togglePin(view.id); else { store.open(item.href, item.title); const created = store.getSnapshot().tabs.find((view) => view.key === item.key); if (created) store.togglePin(created.id); } }}
          className="inline-flex size-9 flex-none items-center justify-center rounded-md text-ink-muted hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring">
          {item.pinned ? <PinOff size={16} /> : <Pin size={16} />}
        </button>
      </div>)}
      {!result.count && <p className="py-8 text-center text-sm text-ink-muted">{query ? 'No matching documents.' : kind === 'drafts' ? 'Create a narration to start a draft. It is saved as you write.' : kind === 'pinned' ? 'Pin documents from their header to keep them close.' : 'Documents you open will appear here.'}</p>}
    </div>
    {result.pages > 1 && <div className="flex flex-wrap items-center justify-between gap-2">
      <Button variant="outline" disabled={result.page <= 1} onClick={() => update(query, result.page - 1)}>Previous</Button>
      <span className="text-sm">Page {result.page} of {result.pages}</span>
      <Button variant="outline" disabled={result.page >= result.pages} onClick={() => update(query, result.page + 1)}>Next</Button>
    </div>}
  </WorkbenchPanel>;
}
