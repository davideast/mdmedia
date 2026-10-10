"use client";
import { AudioLines, ImageIcon, Video, Plus } from 'lucide-react';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { MEDIA_TYPES } from '@/lib/media-types';
import { useConnectivity } from '@/lib/connectivity';
import { useWorkspace } from './workspace-provider';
export function CreateMenu({ compact = false, onNavigate }: { compact?: boolean; onNavigate?: () => void }) {
  const { newMediaDraft } = useWorkspace();
  const offline = useConnectivity() === 'offline';
  return <DropdownMenu><DropdownMenuTrigger disabled={offline} aria-label="Create" title="Create" className={`flex h-9 items-center justify-center gap-2 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground disabled:opacity-40 ${compact ? 'w-full' : ''}`}>
    <Plus size={16} />{!compact && 'Create'}
  </DropdownMenuTrigger><DropdownMenuContent align="start">
    {MEDIA_TYPES.filter(item => item.available).map(item => <DropdownMenuItem key={item.type} onSelect={() => { newMediaDraft(item.type as 'narration' | 'image' | 'video'); onNavigate?.(); }}>
      {item.type === 'video' ? <Video size={16} /> : item.type === 'image' ? <ImageIcon size={16} /> : <AudioLines size={16} />}{item.label}
    </DropdownMenuItem>)}
  </DropdownMenuContent></DropdownMenu>;
}
