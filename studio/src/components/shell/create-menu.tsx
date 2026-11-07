"use client";
import { AudioLines, ImageIcon, Video, Music2, Plus, ScanSearch } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { MEDIA_TYPES } from '@/lib/media-types';
import { useConnectivity } from '@/lib/connectivity';
import { useWorkspace } from './workspace-provider';
export function CreateMenu({ compact = false, onNavigate }: { compact?: boolean; onNavigate?: () => void }) {
  const { newMediaDraft } = useWorkspace();
  const offline = useConnectivity() === 'offline';
  return <DropdownMenu><DropdownMenuTrigger asChild>
    <Button type="button" size={compact ? 'icon' : 'default'} disabled={offline} aria-label="Create" title="Create" className={compact ? 'h-9 w-full' : 'h-9'}>
      <Plus size={16} />{!compact && 'Create'}
    </Button>
  </DropdownMenuTrigger><DropdownMenuContent align="start">
    {MEDIA_TYPES.filter(item => item.available).map(item => <DropdownMenuItem key={item.type} onSelect={() => { newMediaDraft(item.type as 'narration' | 'image' | 'video' | 'music' | 'analysis'); onNavigate?.(); }}>
      {item.type === 'analysis' ? <ScanSearch size={16} /> : item.type === 'music' ? <Music2 size={16} /> : item.type === 'video' ? <Video size={16} /> : item.type === 'image' ? <ImageIcon size={16} /> : <AudioLines size={16} />}{item.label}
    </DropdownMenuItem>)}
  </DropdownMenuContent></DropdownMenu>;
}
