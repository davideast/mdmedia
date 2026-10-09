"use client";
import {useRouter,useSearchParams} from 'next/navigation';
import {useState} from 'react';
import {useWorkspace} from '@/components/shell/workspace-provider';
import {Button} from '@/components/ui/button';
import {Popover,PopoverContent,PopoverTrigger} from '@/components/ui/popover';
export function UseNarrationInVideo({id,title,durationMs,ready}:{id:string;title:string;durationMs:number;ready:boolean}){
 const {state,store}=useWorkspace();const router=useRouter();const search=useSearchParams();const [open,setOpen]=useState(false);const target=search.get('video');const at=Math.max(0,Math.min(300,Number(search.get('at'))||0));
 const insert=(videoId:string)=>{const saved=store.getSnapshot().sceneDrafts[videoId];if(!saved||!ready||durationMs<=0)return;store.setSceneDraft(videoId,{...saved,audioPlacements:[...saved.audioPlacements??[],{id:crypto.randomUUID(),narrationId:id,title,startSeconds:target===videoId?at:0,inSeconds:0,outSeconds:durationMs/1000,volume:1,muted:false}]});for(const project of Object.values(state.projects??{}))if(project.documents[`/studio/scene?draft=${videoId}`])store.setProject({...project,documents:{...project.documents,[`/narration/${id}`]:title}});store.flush();setOpen(false);router.push(`/studio/scene?draft=${encodeURIComponent(videoId)}`);};
 if(target&&state.sceneDrafts[target])return <Button size="sm" disabled={!ready||durationMs<=0} onClick={()=>insert(target)}>Insert into {state.sceneDrafts[target].title||'video'} at {at.toFixed(1)}s</Button>;
 return <Popover open={open} onOpenChange={setOpen}><PopoverTrigger asChild><Button variant="outline" size="sm" disabled={!ready||durationMs<=0}>Use in video</Button></PopoverTrigger><PopoverContent className="grid max-h-80 gap-1 overflow-auto"><p className="p-2 text-xs text-ink-muted">Choose a video / inserts at 0s</p>{Object.entries(state.sceneDrafts).map(([videoId,video])=><Button className="justify-start truncate" key={videoId} variant="ghost" size="sm" onClick={()=>insert(videoId)}>{video.title||video.draft.beats[0]?.text.slice(0,35)||'Untitled video'}</Button>)}{!Object.keys(state.sceneDrafts).length?<p className="p-2 text-sm">Create a video first, then add this narration from Assets.</p>:null}</PopoverContent></Popover>;
}
