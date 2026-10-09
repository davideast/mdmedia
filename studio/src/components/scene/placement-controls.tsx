'use client';
import {useRef,useState} from 'react';
import {Button} from '@/components/ui/button';
import {useSceneComposer,type SceneTrack} from './scene-composer-provider';
import {authenticatedVideoFetch} from './use-video-jobs';
import {placementNeedsRecording} from '@/lib/script-timeline';

export function PlacementControls({track}:{track:SceneTrack}){
 const scene=useSceneComposer();const input=useRef<HTMLInputElement>(null);const [uploading,setUploading]=useState(false);const [issue,setIssue]=useState('');
 const placement=track.clip?.placement;if(!placement)return null;
 const candidate=track.candidate;
 const attach=async(file:File)=>{setUploading(true);setIssue('');try{const form=new FormData();form.set('video',file);const response=await authenticatedVideoFetch('/api/video-sources',{method:'POST',body:form});const {source}=await response.json();await scene.attachRecording(track.beat.id,source.id);}catch(error){setIssue(error instanceof Error?error.message:'Recording could not be attached.');}finally{setUploading(false);if(input.current)input.current.value='';}};
 const planned=track.beat.end!==null&&track.beat.start!==null?track.beat.end-track.beat.start:placement.seconds;
 return <section className="grid gap-3 border-b border-border pb-4" aria-label="Section media">
 <h3 className="text-sm font-medium">{placement.title}</h3>
 <p className="text-xs text-ink-muted">{placementNeedsRecording(track.clip)?track.url?'Recording attached':placement.source==='screencast'?'Needs a real screen recording':'Needs a presenter recording':'Generated video section'}</p>
 {placementNeedsRecording(track.clip)?<><input ref={input} className="sr-only" aria-label="Attach section recording" type="file" accept="video/mp4,video/quicktime,video/webm,.mov,.mp4,.webm" onChange={event=>{const file=event.target.files?.[0];if(file)void attach(file);}}/><Button size="sm" variant="outline" disabled={uploading||!!track.clip?.pendingVideoId||scene.batchRunning} onClick={()=>input.current?.click()}>{uploading?'Uploading recording':track.url?'Replace recording':'Attach recording'}</Button></>:null}
 {issue?<p role="alert" className="text-xs">{issue}</p>:null}
 {track.clip?.pendingVideoId?<div className="grid gap-2"><p role="status" className="text-xs">{candidate?.issue??(candidate?.job?.status==='ready'||candidate?.job?.status==='partial'?'New take available. Your current take is still on the timeline.':candidate?.job?.status==='error'?candidate.job.message:'Preparing a replacement. Your current take is preserved.')}</p>{candidate?.url?<video controls src={candidate.url} className="w-full rounded" aria-label="Replacement take preview"/>:null}{candidate?.job?.status==='ready'||candidate?.job?.status==='partial'?<><p className="text-xs">{candidate.job.durationSeconds?.toFixed(1)}s available / {planned.toFixed(1)}s planned. Replacing this take may require regenerating linked continuations.</p><Button size="sm" onClick={()=>scene.acceptCandidate(track.beat.id)}>Use this take</Button></>:null}<Button size="xs" variant="ghost" onClick={()=>scene.discardCandidate(track.beat.id)}>Keep current take</Button></div>:null}
 {track.timingIssue?<div className="grid gap-2"><p className="text-xs">{track.timingIssue} {track.trim.duration+.05<planned?`Shortening from ${planned.toFixed(1)}s to ${track.trim.duration.toFixed(1)}s moves later sections ${(planned-track.trim.duration).toFixed(1)}s earlier. Audio placements keep their current positions.`:`Use ${track.trim.duration.toFixed(1)}s from this saved result without shifting later sections.`}</p><Button size="sm" variant="outline" onClick={()=>scene.updateBeatClip(track.beat.id,{timingAccepted:true})}>Use available duration</Button></div>:null}
 {placement.dialogue?<details className="text-xs"><summary>Scripted words</summary><p className="mt-2 leading-relaxed">{placement.dialogue}</p>{placement.source==='generated'?<p className="mt-2 text-ink-muted">Add narration through Assets. These words are not sent to video generation.</p>:null}</details>:null}
 {placement.audio?<details className="text-xs"><summary>Planned sound</summary><p className="mt-2 leading-relaxed">{placement.audio}</p><p className="mt-2 text-ink-muted">A cue is not an audio asset. Add any required audio separately.</p></details>:null}
 {track.clip?.takeHistory?.length?<details className="text-xs"><summary>Previous takes</summary><div className="mt-2 grid gap-2">{track.clip.takeHistory.map((take,index)=><Button key={`${take.videoId}:${index}`} size="xs" variant="outline" disabled={track.busy||scene.batchRunning} onClick={()=>scene.restoreTake(track.beat.id,index)}>Restore take {index+1}</Button>)}</div></details>:null}
 </section>;
}
