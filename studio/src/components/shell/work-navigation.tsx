"use client";

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Pin, Search } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useWorkspace } from './workspace-provider';
import { FIND_LIMIT, isWorkRoute, matchesWork, workspaceItems, type WorkItem } from '@/lib/workspace-navigation';
import { useConnectivity } from '@/lib/connectivity';

export function PinWorkButton() {
  const { activeView, store } = useWorkspace();
  if (!activeView || !isWorkRoute(activeView.href)) return null;
  return <button type="button" aria-label={activeView.pinned ? 'Unpin from sidebar' : 'Pin to sidebar'}
    aria-pressed={activeView.pinned === true} title={activeView.pinned ? 'Unpin from sidebar' : 'Pin to sidebar'}
    onClick={() => store.togglePin(activeView.id)}
    className="inline-flex size-8 flex-none items-center justify-center rounded-md text-ink-muted hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring">
    <Pin size={15} className={activeView.pinned ? 'fill-primary text-primary' : ''} />
  </button>;
}

export function WorkLink({ item, onNavigate }: { item: WorkItem; onNavigate?: () => void }) {
  return <Link href={item.href} onClick={onNavigate} title={`${item.title} · ${item.detail}`}
    className="block min-w-0 rounded-md px-2 py-2 hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring">
    <span className="block truncate text-[13px]">{item.title}</span>
    <span className="block truncate text-[10px] text-ink-muted">{item.detail}</span>
  </Link>;
}

export function FindWork({ compact = false, onNavigate }: { compact?: boolean; onNavigate?: () => void }) {
  const { state } = useWorkspace();
  const offline = useConnectivity() === 'offline';
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const items = useMemo(() => workspaceItems(state), [state]);
  const results = useMemo(() => {
    const matches: WorkItem[] = [];
    for (const item of items) {
      if (matchesWork(item.search, query)) matches.push(item);
      if (matches.length === FIND_LIMIT) break;
    }
    return matches;
  }, [items, query]);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (!offline && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault(); setOpen((value) => !value);
      }
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [offline]);
  const navigate = () => { setOpen(false); onNavigate?.(); };
  return <Dialog open={open} onOpenChange={(value) => { setOpen(value); if (value) setQuery(''); }}>
    <DialogTrigger disabled={offline} aria-label="Find work" title="Find work (Ctrl/⌘ K)"
      className={`flex h-8 w-full items-center rounded-md text-[13px] text-ink-muted hover:bg-sidebar-accent disabled:opacity-40 ${compact ? 'justify-center' : 'gap-2 px-2'}`}>
      <Search size={16} />{!compact && <><span>Find work</span><kbd className="ml-auto text-[10px]">⌘ K</kbd></>}
    </DialogTrigger>
    <DialogContent className="max-h-[85dvh] min-w-0 overflow-y-auto">
      <DialogTitle>Find work</DialogTitle>
      <DialogDescription>Search drafts and previously opened work on this device. Search Library for other saved media.</DialogDescription>
      <Input aria-label="Find work by title, text, or ID" placeholder="Title, text, or ID…" value={query} onChange={(event) => setQuery(event.target.value)} />
      <div className="min-w-0" aria-label="Work matches">
        {results.map((item) => <WorkLink key={item.key} item={item} onNavigate={navigate} />)}
        {!results.length && <p className="py-3 text-sm text-ink-muted">No matching work on this device.</p>}
      </div>
      <Link href={`/library${query.trim() ? `?q=${encodeURIComponent(query.trim())}` : ''}`} onClick={navigate}
        className="text-sm text-primary underline">{query.trim() ? `Search Library for “${query.trim()}”` : 'Browse Library'}</Link>
    </DialogContent>
  </Dialog>;
}

export function SidebarWork({ onNavigate }: { onNavigate?: () => void }) {
  const { state, storageUnavailable } = useWorkspace();
  const offline = useConnectivity() === 'offline';
  const items = useMemo(() => workspaceItems(state), [state]);
  const pinned = items.filter((item) => item.pinned);
  const recent = items.filter((item) => !item.pinned && item.visitedAt > 0).slice(0, 50);
  return <>
    {storageUnavailable && <p role="status" className="py-2 text-xs text-destructive">Device storage unavailable. Keep this window open to retain your drafts.</p>}
    {!offline && [{ title: 'Pinned', href: '/pinned', items: pinned }, { title: 'Recent', href: '/recent', items: recent }].map((section) =>
      <section key={section.href} className="mt-4 border-t border-sidebar-border pt-3" aria-label={`${section.title} work`}>
        <div className="flex items-center justify-between px-2 text-[11px] text-ink-muted">
          <h2 className="font-semibold uppercase tracking-wide">{section.title}</h2>
          <Link href={section.href} onClick={onNavigate} className="underline underline-offset-2">View all{section.items.length > 0 ? ` (${section.items.length})` : ''}</Link>
        </div>
        {section.items.slice(0, 5).map((item) => <WorkLink key={item.key} item={item} onNavigate={onNavigate} />)}
        {!section.items.length && <p className="px-2 py-3 text-xs text-ink-muted">{section.href === '/pinned' ? 'Pin a document using its header pin.' : 'Documents you open appear here.'}</p>}
      </section>)}
  </>;
}
