"use client";

import { useEffect, useRef, useState, type PointerEvent, type KeyboardEvent, type ReactNode } from 'react';
import Image from 'next/image';
import { Film, Maximize2, Pause, Play, Plus, Volume2, VolumeX } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from 'cn';
import { WATERLINE_PREVIEW } from '@/lib/scene-preview';
import { useSceneComposer, type SceneTrack } from './scene-composer-provider';
import './scene-tracks.css';
import {SequenceAudio} from './audio-assets';
import {placementStatus} from '@/lib/script-timeline';
import { beatGenerationStatus } from '@/lib/scene-generation-feedback';

export const trackStatus = (track:SceneTrack) => track.timingIssue?'Review timing':track.clip?.pendingVideoId?'Review replacement':placementStatus(track.clip,track.ready)??beatGenerationStatus(track);
const timecode = (seconds:number) => `${Math.floor(seconds/60).toString().padStart(2,'0')}:${(seconds%60).toFixed(1).padStart(4,'0')}`;

function BeatTrackRow({track,index,selectedBeatId,scale,onSelect,onUpdate,onTransition,onDragTrim,onTrimKey,onPlay,playing,hasNext}:{
  track:SceneTrack;index:number;selectedBeatId:string;scale:number;
  onSelect:(track:SceneTrack)=>void;onUpdate:(id:string,patch:{excluded?:boolean;muted?:boolean})=>void;onTransition:(track:SceneTrack)=>void;
  onPlay:(track:SceneTrack)=>void;playing:boolean;hasNext:boolean;
  onDragTrim:(event:PointerEvent<HTMLButtonElement>,track:SceneTrack,edge:'in'|'out')=>void;onTrimKey:(event:KeyboardEvent<HTMLButtonElement>,track:SceneTrack,edge:'in'|'out')=>void;
}) {
  const active=track.beat.id===selectedBeatId;
  const title=track.clip?.placement?.title??track.beat.text.split(/[.!?\n]/)[0].split(/\s+/).slice(0,7).join(' ');
  const status=trackStatus(track);
  const transition=track.transition==='fade'?`Fade ${track.transitionSeconds.toFixed(2)}s`:'Hard cut';
  return <div className={cn('beat-track',active&&'beat-track--selected',!track.included&&'beat-track--excluded')}>
    <div className="beat-track__label">
      <button type="button" aria-pressed={active} aria-label={`Select beat ${index+1}: ${title}`} onClick={()=>onSelect(track)} className="beat-track__select" title={track.beat.text}>
        <span className="beat-track__name"><span>Beat {String(index+1).padStart(2,'0')}</span><span className="beat-track__status" title={status}>{status}</span></span>
        <span className="beat-track__title">{title}</span>
      </button>
      <div className="beat-track__controls">
        <Button variant="ghost" size="icon-xs" disabled={!track.url} aria-label={`${playing?'Pause':'Play'} beat ${index+1}`} title={playing?'Pause beat':'Play beat'} onClick={()=>onPlay(track)}>{playing?<Pause size={13}/>:<Play size={13}/>}</Button>
        <Button variant="ghost" size="icon-xs" aria-label={`${track.clip?.muted?'Unmute':'Mute'} beat ${index+1}`} title={track.clip?.muted?'Unmute clip audio':'Mute clip audio'} aria-pressed={!!track.clip?.muted} onClick={()=>onUpdate(track.beat.id,{muted:!track.clip?.muted})}>{track.clip?.muted?<VolumeX size={13}/>:<Volume2 size={13}/>}</Button>
        <label className="beat-track__include"><input className="scene-checkbox" type="checkbox" checked={track.included} onChange={event=>onUpdate(track.beat.id,{excluded:!event.target.checked})} aria-label={`Include beat ${index+1}`} />Include</label>
      </div>
    </div>
    <div className="beat-track__lane">
      <button type="button" className={cn('beat-track__clip',track.url&&'beat-track__clip--media')} style={{left:`${track.start/scale*100}%`,width:`${track.trim.duration/scale*100}%`}} onClick={()=>onSelect(track)} aria-label={`Select beat ${index+1}, ${track.start.toFixed(1)} to ${track.end.toFixed(1)} seconds`} aria-pressed={active}>
        {track.url ? <video src={track.url} muted preload="auto" aria-hidden="true" tabIndex={-1} onLoadedData={event=>{event.currentTarget.currentTime=track.trim.start;}}/> : <Film size={18} strokeWidth={1.4}/>}
        <span>{track.trim.duration.toFixed(1)}s</span>
      </button>
      {active&&track.ready?(['in','out'] as const).map(edge=><button key={edge} type="button" role="slider" aria-label={`Beat ${index+1} ${edge==='in'?'in':'out'} trim`} aria-valuemin={edge==='in'?track.sourceStart:track.trim.start+0.05} aria-valuemax={edge==='in'?track.trim.end-0.05:track.sourceEnd} aria-valuenow={edge==='in'?track.trim.start:track.trim.end}
        className="beat-trim-handle" style={{left:`${(edge==='in'?track.start:track.end)/scale*100}%`}} onPointerDown={event=>onDragTrim(event,track,edge)} onKeyDown={event=>onTrimKey(event,track,edge)}/>):null}
      {hasNext&&track.included?<button type="button" className={cn('beat-transition',track.transition==='fade'&&'beat-transition--fade')} style={{left:`${track.end/scale*100}%`}} aria-label={`Edit transition after beat ${index+1}: ${transition}`} aria-controls="beat-transition-control" title={`${transition}. Edit in the inspector.`} onClick={()=>onTransition(track)}>{track.transition==='fade'?'Fade':'Cut'}</button>:null}
    </div>
  </div>;
}

export function SceneTracks({monitorOnly=false,compact=false,sidebar,inspector,onAddAudio,onAddBeat,mobileView='preview'}:{monitorOnly?:boolean;compact?:boolean;sidebar?:ReactNode;inspector?:ReactNode;onAddAudio?:()=>void;onAddBeat?:()=>void;mobileView?:'preview'|'details'|'assets'}={}) {
  const scene = useSceneComposer();
  const [timelineSize,setTimelineSize]=useState(38);
  const selected = scene.tracks.find(track=>track.beat.id===scene.selectedBeatId);
  const included = scene.tracks.filter(track=>track.included);
  const total = included.at(-1)?.end ?? 0;
  const video=useRef<HTMLVideoElement>(null); const stage=useRef<HTMLDivElement>(null);
  const [playing,setPlaying]=useState(false); const [sequencePlayback,setSequencePlayback]=useState(true); const [notice,setNotice]=useState('');
  const [cursor,setCursor]=useState<{beatId:string;time:number}>({beatId:scene.selectedBeatId,time:scene.playhead});
  const [fit,setFit]=useState<'contain'|'cover'>('contain');
  const priorSelection=useRef(selected?.beat.id);
  useEffect(()=>{if(priorSelection.current!==selected?.beat.id&&!playing&&video.current&&selected)video.current.currentTime=selected.trim.start;priorSelection.current=selected?.beat.id;},[selected,playing]);
  const currentTime = selected && cursor.beatId===selected.beat.id ? Math.min(selected.end,Math.max(selected.start,cursor.time)) : selected?.start ?? 0;
  const seek = (seconds:number) => {
    const track=included.find(track=>seconds>=track.start&&seconds<track.end) ?? included.at(-1);
    if(!track)return;
    scene.setPlayhead(seconds);
    scene.selectBeat(track.beat.id);setCursor({beatId:track.beat.id,time:seconds});
    if(track.url===selected?.url && video.current)video.current.currentTime=track.trim.start+Math.max(0,seconds-track.start);
    if(!track.url){setPlaying(false);setNotice(track.clip?.placement?'This section needs footage. Select it to generate or attach a recording.':'Generate this beat to preview this part of the sequence.');}else setNotice('');
  };
  const advance = () => {
    if(!selected)return;
    if(!sequencePlayback){setPlaying(false);video.current?.pause();return;}
    const next=included[included.findIndex(track=>track.beat.id===selected.beat.id)+1];
    if(next?.url){
      if(next.url===selected.url&&video.current&&Math.abs(next.trim.start-selected.trim.end)>0.001)video.current.currentTime=next.trim.start;
      scene.selectBeat(next.beat.id);setCursor({beatId:next.beat.id,time:next.start});
    }
    else {setPlaying(false);video.current?.pause();setNotice(next?'The next section needs footage.':'');}
  };
  const togglePlayback = async () => {
    setSequencePlayback(true);
    if(!video.current || !selected?.url)return;
    if(playing){video.current.pause();setPlaying(false);return;}
    if(currentTime>=selected.end-0.03)video.current.currentTime=selected.trim.start;
    try{await video.current.play();setPlaying(true);setNotice('');}catch{setNotice('Playback could not start. Try again.');}
  };
  const playBeat = async (track:SceneTrack) => {
    if(!track.url)return;
    setSequencePlayback(false);setNotice('');
    if(track.beat.id===selected?.beat.id&&playing){video.current?.pause();setPlaying(false);return;}
    if(track.url===selected?.url&&video.current){
      scene.selectBeat(track.beat.id);setCursor({beatId:track.beat.id,time:track.start});
      video.current.currentTime=track.trim.start;
      try{await video.current.play();setPlaying(true);}catch{setNotice('Playback could not start. Try again.');}
    }else{video.current?.pause();scene.selectBeat(track.beat.id);setCursor({beatId:track.beat.id,time:track.start});setPlaying(true);}
  };
  const select = (track:SceneTrack) => {scene.setPlayhead(track.start);video.current?.pause();if(track.url===selected?.url&&video.current)video.current.currentTime=track.trim.start;setPlaying(false);scene.selectBeat(track.beat.id);setCursor({beatId:track.beat.id,time:track.start});setNotice('');};
  const inspectTransition = (track:SceneTrack) => {
    select(track);
    document.querySelector<HTMLButtonElement>('aside[aria-label="Inspector"][data-docked="true"] button[aria-label="Expand panel"]')?.click();
    requestAnimationFrame(()=>{const control=document.getElementById('beat-transition-control');const details=control?.closest('details');if(details)details.open=true;control?.focus();});
  };
  const trimWithKeyboard = (event:KeyboardEvent<HTMLButtonElement>,track:SceneTrack,edge:'in'|'out') => {
    if(event.key!=='ArrowLeft'&&event.key!=='ArrowRight')return;
    event.preventDefault();const delta=(event.key==='ArrowRight'?1:-1)*(event.shiftKey?1:0.1);
    const value=(edge==='in'?track.trim.start:track.trim.end)+delta;
    const clamped=edge==='in'?Math.max(track.sourceStart,Math.min(track.trim.end-0.05,value)):Math.max(track.trim.start+0.05,Math.min(track.sourceEnd,value));
    scene.updateBeatClip(track.beat.id,edge==='in'?{inSeconds:clamped}:{outSeconds:clamped});
  };
  const dragTrim = (event:PointerEvent<HTMLButtonElement>,track:SceneTrack,edge:'in'|'out') => {
    event.preventDefault();event.stopPropagation();setPlaying(false);video.current?.pause();
    const handle=event.currentTarget; const lane=handle.closest('.beat-track__lane'); if(!lane)return;
    const width=lane.getBoundingClientRect().width; const from=event.clientX; const initial=edge==='in'?track.trim.start:track.trim.end;
    handle.setPointerCapture(event.pointerId);
    const move=(next:globalThis.PointerEvent)=>{
      const value=initial+(next.clientX-from)*Math.max(3,total)/width;
      const clamped=edge==='in'?Math.max(track.sourceStart,Math.min(track.trim.end-0.05,value)):Math.max(track.trim.start+0.05,Math.min(track.sourceEnd,value));
      scene.updateBeatClip(track.beat.id,edge==='in'?{inSeconds:Math.round(clamped*100)/100}:{outSeconds:Math.round(clamped*100)/100});
    };
    const stop=()=>{handle.removeEventListener('pointermove',move);handle.removeEventListener('pointerup',stop);handle.removeEventListener('pointercancel',stop);};
    handle.addEventListener('pointermove',move);handle.addEventListener('pointerup',stop);handle.addEventListener('pointercancel',stop);
  };
  const scale=Math.max(3,total); const ticks=Array.from({length:7},(_,index)=>scale*index/6);
  return <div className={cn('scene-track-view',compact&&'scene-track-view--compact',sidebar&&'video-workspace')} data-panel={mobileView} style={sidebar?{gridTemplateRows:`minmax(100px,1fr) minmax(200px,${timelineSize}%)`}:undefined}>
    {sidebar?<aside className="video-outline" aria-label="Beats and assets" onClickCapture={()=>{video.current?.pause();setPlaying(false);}}>{sidebar}</aside>:null}
    <section className="video-monitor-area" aria-label="Sequence preview">
    <div className="beat-monitor__heading"><span className="text-sm">Sequence preview</span><Button variant="ghost" size="xs" onClick={()=>setFit(fit==='contain'?'cover':'contain')}>{fit==='contain'?'Fit':'Fill'}</Button></div>
    <div ref={stage} className="beat-monitor">
      {selected?.url ? <video key={selected.url} ref={video} src={selected.url} playsInline preload="auto" muted={selected.clip?.muted} className="h-full w-full" style={{objectFit:fit}}
        aria-label="Selected beat video" onLoadedMetadata={event=>{
          event.currentTarget.currentTime=selected.trim.start+Math.max(0,currentTime-selected.start);
          if(playing)void event.currentTarget.play().catch(()=>{setPlaying(false);setNotice('Press play to continue.');});
        }} onTimeUpdate={event=>{
          const local=event.currentTarget.currentTime;
          scene.setPlayhead(selected.start+Math.max(0,local-selected.trim.start));
          setCursor({beatId:selected.beat.id,time:selected.start+Math.max(0,local-selected.trim.start)});
          if(playing && local>=selected.trim.end-0.02)advance();
        }} onEnded={()=>{if(playing)advance();}} onError={()=>{setPlaying(false);setNotice('This beat preview could not be loaded. Check its status.');}} /> :
        selected?.clip?.placement?<div className="grid h-full place-content-center gap-3 p-8 text-center"><Film className="mx-auto" size={28}/><p>{selected.clip.placement.title}</p><p className="text-sm text-ink-muted">{trackStatus(selected)}</p></div>:<Image src={WATERLINE_PREVIEW} fill unoptimized loading="eager" alt="Sample cyan botanical still" sizes="70vw" style={{objectFit:fit}} />}
    </div>
    <div className="beat-transport">
      <Button variant="secondary" size="icon-sm" disabled={!selected?.url} aria-label={playing?'Pause sequence':'Play sequence'} onClick={()=>void togglePlayback()}>{playing?<Pause size={15}/>:<Play size={15}/>}</Button>
      <span className="font-mono text-xs tabular-nums">{timecode(currentTime)} / {timecode(total)}</span>
      <input type="range" className="beat-seek" aria-label="Sequence playhead" min={0} max={scale} step="0.05" value={currentTime} onChange={event=>seek(Number(event.target.value))} />
      <Button variant="ghost" size="icon-sm" aria-label="Fullscreen sequence preview" onClick={()=>void stage.current?.requestFullscreen().catch(()=>setNotice('Fullscreen is unavailable.'))}><Maximize2 size={15}/></Button>
    </div>
    <p className="t-meta" role="status">{notice || (selected?.url ? `Beat ${scene.tracks.indexOf(selected)+1}  /  ${trackStatus(selected)}` : selected?.clip?.placement?'Planned section / attach or generate footage':'Sample still  /  Generate a beat to preview its clip')}</p>
    <SequenceAudio time={currentTime} playing={playing}/>
    </section>
    {inspector?<aside className="video-inspector" aria-label="Selected item">{inspector}</aside>:null}
    {!monitorOnly?<section className="beat-timeline" aria-label="Beat tracks">
      {sidebar?<div role="separator" tabIndex={0} aria-label="Resize timeline" aria-orientation="horizontal" aria-valuemin={20} aria-valuemax={65} aria-valuenow={timelineSize} className="video-timeline-resizer" onKeyDown={e=>{if(e.key==='ArrowUp'||e.key==='ArrowDown'){e.preventDefault();setTimelineSize(v=>Math.max(20,Math.min(65,v+(e.key==='ArrowUp'?5:-5))));}}} onPointerDown={e=>{e.preventDefault();const handle=e.currentTarget;const root=handle.closest('.video-workspace')!.getBoundingClientRect();handle.setPointerCapture(e.pointerId);const move=(event:globalThis.PointerEvent)=>setTimelineSize(Math.max(20,Math.min(65,(root.bottom-event.clientY)/root.height*100)));const end=()=>{handle.removeEventListener('pointermove',move);handle.removeEventListener('pointerup',end);handle.removeEventListener('pointercancel',end);};handle.addEventListener('pointermove',move);handle.addEventListener('pointerup',end);handle.addEventListener('pointercancel',end);}}/>:null}
      <div className="flex items-center justify-between gap-3"><h2 className="text-sm font-medium">Timeline</h2><span className="t-meta">{included.filter(track=>track.ready).length} of {included.length} included beats ready</span></div>
      <div className="beat-timeline__scroll"><div className="beat-timeline__grid">
        <div className="beat-timeline__guides" aria-hidden="true">{ticks.map((_,index)=><span key={index} style={{left:`${index*100/6}%`}}/>)}</div>
        <div className="beat-ruler-row"><span className="beat-ruler__heading">Sequence</span><div className="beat-ruler">{ticks.map((tick,index)=><button key={index} type="button" style={{left:`${index*100/6}%`}} onClick={()=>seek(tick)} aria-label={`Seek to ${tick.toFixed(1)} seconds`}>{Number(tick.toFixed(1))}s</button>)}</div></div>
        {scene.tracks.map((track,index)=><BeatTrackRow key={track.beat.id} track={track} index={index} selectedBeatId={scene.selectedBeatId} scale={scale}
          onSelect={select} onUpdate={scene.updateBeatClip} onTransition={inspectTransition} onDragTrim={dragTrim} onTrimKey={trimWithKeyboard} onPlay={track=>void playBeat(track)} playing={playing&&selected?.beat.id===track.beat.id} hasNext={scene.tracks.slice(index+1).some(next=>next.included)}/>)}
        {scene.audioPlacements.map(clip=><div key={clip.id} className="beat-track"><div className="beat-track__label"><button className="text-left text-xs" onClick={()=>scene.selectAudio(clip.id)}>{clip.title}</button><span className="text-xs text-ink-muted">Narration</span></div><div className="beat-track__lane"><button className="audio-timeline-clip" aria-pressed={scene.selectedAudioId===clip.id} onClick={()=>scene.selectAudio(clip.id)} style={{left:`${clip.startSeconds/scale*100}%`,width:`${Math.max(0,Math.min(clip.outSeconds-clip.inSeconds,scale-clip.startSeconds))/scale*100}%`}}>{(clip.outSeconds-clip.inSeconds).toFixed(1)}s</button></div></div>)}
        <div className="beat-timeline__playhead" aria-hidden="true"><div className="beat-playhead" style={{left:`${Math.max(0,Math.min(100,currentTime/scale*100))}%`}}/></div>
      </div></div>
      <div className="flex items-center justify-between gap-3"><Button variant="ghost" size="sm" onClick={onAddBeat??(()=>{scene.updateDraft({beats:[...scene.draft.beats,{id:crypto.randomUUID(),start:null,end:null,text:''}]});})}><Plus size={14}/>Add beat</Button><Button variant="outline" size="sm" onClick={onAddAudio}>Add audio</Button></div>
    </section>:null}
    {!sidebar&&!monitorOnly&&scene.exportUrl?<section className="grid gap-2 border-t border-border pt-4"><div className="flex items-center justify-between"><h2 className="text-sm font-medium">Final video</h2><Button variant="outline" size="sm" onClick={()=>scene.downloadJob(scene.exportJob!.id)}>Download MP4</Button></div><p className="t-meta">{scene.exportCurrent?'Matches your current tracks':'Earlier export  /  Export again to include your edits'}</p><video src={scene.exportUrl} controls playsInline preload="metadata" className="w-full rounded-md" aria-label="Exported final video"/></section>:null}
  </div>;
}
