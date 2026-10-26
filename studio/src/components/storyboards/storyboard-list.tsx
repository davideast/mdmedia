'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { LayoutGrid, Plus } from 'lucide-react';
import { WorkbenchPanel } from '@/components/shell/workbench-panel';
import { Button } from '@/components/ui/button';
import { useStudioResource, primeStudioResource } from '@/lib/use-studio-resource';
import { studioJson } from '@/lib/media-client';
import { storyboardHref, type StoryboardResource, type StoryboardSummary } from '@/lib/storyboard';

export function StoryboardListPage() {
  const { data, error, reload } = useStudioResource<{storyboards: StoryboardSummary[]}>('/api/v1/storyboards');
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [failure, setFailure] = useState('');
  async function create() {
    setCreating(true); setFailure('');
    try {
      const created = await studioJson<StoryboardResource>('/api/v1/storyboards', {method: 'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({title:'Untitled storyboard'})});
      primeStudioResource(`/api/v1/storyboards/${created.id}`, created);
      primeStudioResource('/api/v1/storyboards', null);
      router.push(storyboardHref(created.id));
    } catch(error) { setFailure((error as Error).message); setCreating(false); }
  }
  return <WorkbenchPanel workspacePage title="Storyboards" icon={<LayoutGrid size={13}/>} viewGrid gridVariant="wide">
    <div className="mb-6 flex justify-end"><Button size="sm" disabled={creating} onClick={() => void create()}><Plus size={14}/>New storyboard</Button></div>
    {failure || error ? <div role="alert" className="mb-4 flex items-center gap-3 text-sm"><p className="text-destructive">{failure || error}</p>{error ? <Button size="sm" variant="ghost" onClick={reload}>Try again</Button> : null}</div> : null}
    {!data ? <div aria-label="Loading storyboards" className="h-24 animate-pulse bg-muted"/> : data.storyboards.length === 0 ? <p className="text-sm text-ink-muted">No storyboards yet.</p> : <ul className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
      {data.storyboards.map(board => <li key={board.id} className="min-w-0"><Link href={storyboardHref(board.id)} className="block h-full overflow-hidden border border-border hover:border-foreground focus-visible:outline-2 focus-visible:outline-offset-2">
        {board.image ? /* eslint-disable-next-line @next/next/no-img-element */ <img src={board.image} alt="" className="aspect-video w-full object-contain"/> : <div className="grid aspect-video place-items-center bg-muted text-ink-muted"><LayoutGrid size={32}/></div>}
        <div className="grid gap-2 p-4"><h2 className="text-sm font-semibold">{board.title}</h2><p className="text-xs text-ink-muted">{board.beatCount} {board.beatCount === 1 ? 'beat' : 'beats'}</p></div>
      </Link></li>)}
    </ul>}
  </WorkbenchPanel>;
}
