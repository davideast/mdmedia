'use client';

import {useEffect, useRef, useState} from 'react';
import {Upload, ArrowRight, Film} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {useWorkspace} from '@/components/shell/workspace-provider';
import {EMPTY_VIDEO_BRIEF, type VideoBrief, type VideoSource} from '@/lib/video-script';
import {authenticatedVideoFetch} from './use-video-jobs';
import {buildScriptTimeline} from '@/lib/script-timeline';
import {applyScriptContinuity,scriptContinuity} from '@/lib/script-continuity';
import {saveVideoPlan} from './save-video-plan';
import {useSceneComposer} from './scene-composer-provider';
import {VideoScriptReader} from './video-script-reader';
import './video-brief.css';

const PILOT_BRIEF = 'Make a 75-second developer video called “I Gave My Terminal a Hollywood Budget.” Use the upload only as a visual reference for me at my desk, not as footage to include. Write an original opening for this premise; do not reuse the demo words in the recording. Explain using mdmedia to generate images, video, music and sound effects by progressively overproducing this very tutorial. Keep my delivery understated: reasonable requests produce absurdly cinematic results. Alternate presenter footage, authentic CLI screencasts and generated visual payoffs. End by returning to the ordinary desk. Clearly mark demonstrations that need a real screen recording. Write a complete, entertaining script with enough time for explanations, reactions and demonstrations.';

export function VideoBriefEditor({onBuilt}:{onBuilt:()=>void}){
  const scene=useSceneComposer();
  const {state,store,draftId}=useWorkspace();
  const saved=state.sceneDrafts[draftId];
  const brief=saved?.videoBrief??EMPTY_VIDEO_BRIEF;
  const [busy,setBusy]=useState<'upload'|'script'|'build'|null>(null);
  const [issue,setIssue]=useState('');
  const [preview,setPreview]=useState('');
  const [previewIssue,setPreviewIssue]=useState('');
  const [previewAttempt,setPreviewAttempt]=useState(0);
  const [confirmRewrite,setConfirmRewrite]=useState(false);
  const [confirmBuild,setConfirmBuild]=useState(false);
  const buildLock=useRef(false);
  const video=useRef<HTMLVideoElement>(null);
  const file=useRef<HTMLInputElement>(null);
  const patch=(changes:Partial<VideoBrief>)=>{
    const record=store.getSnapshot().sceneDrafts[draftId];
    if(record)store.setSceneDraft(draftId,{...record,...(!record.title&&changes.script?{title:changes.script.title}:{}),videoBrief:{...(record.videoBrief??EMPTY_VIDEO_BRIEF),...changes}});
  };
  const sourceId=brief.source?.id;
  useEffect(()=>{
    if(!sourceId)return;
    const controller=new AbortController();let url='';
    void authenticatedVideoFetch(`/api/video-sources/${sourceId}/media`,{signal:controller.signal})
      .then(response=>response.blob()).then(blob=>{
        if(controller.signal.aborted)return;
        url=URL.createObjectURL(blob);setPreview(url);setPreviewIssue('');
      }).catch(error=>{if(!controller.signal.aborted)setPreviewIssue(error.message);});
    return()=>{controller.abort();if(url)URL.revokeObjectURL(url);};
  },[sourceId,previewAttempt]);
  const upload=async(input:File)=>{
    if(input.size>30*1024*1024){setIssue('Choose a video under 30 MB.');return;}
    setBusy('upload');setIssue('');
    try{
      const form=new FormData();form.append('video',input);
      const response=await authenticatedVideoFetch('/api/video-sources',{method:'POST',body:form});
      const {source}=await response.json() as {source:VideoSource};
      setPreview('');patch({source,sourceIn:0,sourceOut:Math.min(source.durationSeconds,10)});
    }catch(error){setIssue(error instanceof Error?error.message:'Upload failed. Try again.');}
    finally{setBusy(null);if(file.current)file.current.value='';}
  };
  const generate=async()=>{
    setConfirmRewrite(false);setBusy('script');setIssue('');
    const submitted={...brief,continuity:scriptContinuity(brief,brief.script)};
    try{
      if(submitted.continuity==='continuous'&&submitted.targetSeconds>40)throw new Error('One continuous shot currently supports up to 40 seconds. Choose a shorter target or explicitly select Planned cuts.');
      const response=await authenticatedVideoFetch('/api/video-scripts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(submitted)});
      const {script}=await response.json();
      patch({script,submittedSourceUsage:submitted.sourceUsage??'reference',submittedPrompt:submitted.prompt,submittedTarget:submitted.targetSeconds,submittedSource:submitted.source?.id??'',submittedRange:`${submitted.sourceIn}:${submitted.sourceOut}`});
    }catch(error){setIssue(error instanceof Error?error.message:'The script could not be drafted.');}
    finally{setBusy(null);}
  };
  const build=async()=>{
    if(buildLock.current||!brief.script)return;
    buildLock.current=true;setBusy('build');setIssue('');setConfirmBuild(false);
    try{
      const record=store.getSnapshot().sceneDrafts[draftId];
      if(!record)throw new Error('The video document is unavailable.');
      // Validate the full chain before importing footage or submitting any paid job.
      buildScriptTimeline(record,brief.script,`v_${'0'.repeat(32)}`);
      let originalId:string|undefined;
      if(brief.script.shots.some(shot=>shot.source==='original')){
        if(brief.sourceUsage!=='include'||!brief.source)throw new Error('Choose Include original footage or redraft without an original section.');
        originalId=`v_${crypto.randomUUID().replaceAll('-','')}`;
        await authenticatedVideoFetch('/api/videos/import',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:originalId,sourceId:brief.source.id,frame:scene.draft.frame})});
      }
      const built=buildScriptTimeline(record,brief.script,originalId);
      await saveVideoPlan(draftId,built);
      store.setSceneDraft(draftId,built);store.flush();
      onBuilt();void scene.generateMissingBeats();
    }catch(error){setIssue(error instanceof Error?error.message:'The timeline could not be built.');}
    finally{buildLock.current=false;setBusy(null);}
  };
  const changed=brief.script&&(brief.prompt!==brief.submittedPrompt||brief.targetSeconds!==brief.submittedTarget||(brief.sourceUsage??'reference')!==brief.submittedSourceUsage||(brief.source?.id??'')!==brief.submittedSource||`${brief.sourceIn}:${brief.sourceOut}`!==brief.submittedRange);
  const rangeValid=!brief.source||brief.sourceOut>brief.sourceIn&&brief.sourceOut<=brief.source.durationSeconds+.025;
  const continuity=scriptContinuity(brief,brief.script);
  let buildIssue='',alreadyBuilt=false;
  if(saved&&brief.script){try{buildScriptTimeline(saved,brief.script,`v_${'0'.repeat(32)}`);alreadyBuilt=JSON.stringify(saved.builtScript)===JSON.stringify(applyScriptContinuity(brief.script,brief));}catch(error){buildIssue=error instanceof Error?error.message:'Check the shot plan.';}}
  return <div className="video-brief">
    <div className="video-brief-heading"><h1>Start with the story.</h1><p>Describe the video. Shape the script before making the footage.</p></div>
    <div className="video-brief-inputs">
      <section aria-label="Video brief" className="video-brief-prompt">
        <label htmlFor="video-brief-prompt">What should this video be?</label>
        <textarea id="video-brief-prompt" maxLength={12000} rows={7} value={brief.prompt} disabled={!!busy} onChange={event=>patch({prompt:event.target.value})} placeholder="Describe the story, who it is for, and what should happen."/>
        <label>Scene continuity <select aria-label="Scene continuity" value={continuity} disabled={!!busy||scene.batchRunning} onChange={event=>patch({continuity:event.target.value as 'continuous'|'planned'})}><option value="continuous">One continuous shot</option><option value="planned">Planned cuts</option></select></label>
        <p className="text-xs text-ink-muted">{continuity==='continuous'?'Each beat extends the previous result. Up to 40 seconds total; no independent shots or fades.':'Use the script’s explicit cuts and continuations. Each connected shot can run up to 40 seconds.'}</p>
        <div className="video-brief-options"><label>Target length <select value={brief.targetSeconds} disabled={!!busy} onChange={event=>patch({targetSeconds:Number(event.target.value)})}>{[...new Set([10,20,30,40,60,75,90,120,180,brief.targetSeconds])].sort((a,b)=>a-b).map(seconds=><option key={seconds} value={seconds}>{seconds} seconds</option>)}</select></label><Button size="xs" variant="ghost" disabled={!!busy} onClick={()=>patch({prompt:PILOT_BRIEF,targetSeconds:75,sourceUsage:'reference',continuity:'planned'})}>Use the Hollywood-budget brief</Button></div>
        <div className="video-brief-submit"><Button disabled={!!busy||!brief.prompt.trim()||!rangeValid} onClick={()=>brief.script?setConfirmRewrite(true):void generate()}>{busy==='script'?'Analyzing footage and drafting':brief.script?'Draft another script':'Draft script'}{!busy?<ArrowRight size={15}/>:null}</Button><span>Creates a script and shot plan. No footage is generated.</span></div>
        {confirmRewrite?<div className="video-brief-confirm"><p>A new draft will replace this editable script. Your footage and existing editor remain untouched.</p><Button size="sm" onClick={()=>void generate()}>Replace script</Button><Button size="sm" variant="ghost" onClick={()=>setConfirmRewrite(false)}>Keep editing</Button></div>:null}
        <p role="status" className="text-sm text-ink-muted">{issue|| (busy==='upload'?'Uploading and preparing a playable reference':busy==='script'?'Reading the reference and planning the story. This can take a minute.':changed?'The brief or reference changed. Draft again when you want the script to reflect it.':'')}</p>
      </section>
      <section className="video-brief-reference" aria-label="Reference video">
        <div className="flex items-center justify-between"><h2>Your reference</h2><Button size="xs" variant="outline" disabled={!!busy} onClick={()=>file.current?.click()}><Upload size={14}/>{brief.source?'Replace video':'Upload video'}</Button></div>
        <input ref={file} className="sr-only" type="file" accept="video/quicktime,video/mp4,video/webm,.mov,.mp4,.webm" aria-label="Upload reference video" disabled={!!busy} onChange={event=>{const input=event.target.files?.[0];if(input)void upload(input);}}/>
        {brief.source?<>
          <label>How should this video be used?<select aria-label="Reference use" value={brief.sourceUsage??'reference'} disabled={!!busy} onChange={event=>patch({sourceUsage:event.target.value as 'reference'|'include'})}><option value="reference">Use as reference</option><option value="include">Include original footage</option></select></label>
          <p className="text-sm text-ink-muted">{brief.sourceUsage==='include'?'The selected recording and its existing speech open the video.':'Use appearance and setting to plan new shots. Write new dialogue; do not include this recording or its demo words.'}</p>
          {preview?<video key={sourceId} ref={video} controls preload="metadata" src={preview} onTimeUpdate={()=>{if(video.current&&!video.current.paused&&video.current.currentTime>=brief.sourceOut)video.current.pause();}}/>:<div className="video-reference-empty"><Film size={24}/><span>{previewIssue||'Preparing preview'}</span>{previewIssue?<Button variant="ghost" size="xs" onClick={()=>setPreviewAttempt(value=>value+1)}>Retry preview</Button>:null}</div>}
          <p className="truncate text-xs">{brief.source.name} / {brief.source.durationSeconds.toFixed(2)}s</p>
          <div className="video-source-range"><label>{brief.sourceUsage==='include'?'Include from (s)':'Reference from (s)'}<Input type="number" min={0} max={Math.max(0,brief.sourceOut-.1)} step="0.1" value={brief.sourceIn} disabled={!!busy} onChange={event=>{const value=Number(event.target.value);if(Number.isFinite(value)&&value>=0&&value<brief.sourceOut)patch({sourceIn:value});}}/></label><label>{brief.sourceUsage==='include'?'Include to (s)':'Reference to (s)'}<Input type="number" min={brief.sourceIn+.1} max={brief.source.durationSeconds} step="0.1" value={brief.sourceOut} disabled={!!busy} onChange={event=>{const value=Number(event.target.value);if(Number.isFinite(value)&&value>brief.sourceIn&&value<=brief.source!.durationSeconds)patch({sourceOut:value});}}/></label></div>
          <Button variant="ghost" size="xs" disabled={!preview} onClick={()=>{if(video.current){video.current.currentTime=brief.sourceIn;void video.current.play().catch(()=>setPreviewIssue('Press play in the preview to watch the opening.'));}}}>Preview selected range</Button>
          <p className="text-xs text-ink-muted">Original saved privately. New on-camera dialogue needs a recording or a supported presenter workflow; uploading does not clone your voice.</p>
        </>:<div className="video-reference-empty"><Film size={24}/><p>Start from your own footage.</p><span>MOV, MP4 or WebM / up to 30 MB and 2 minutes</span></div>}
      </section>
    </div>
    <VideoScriptReader brief={brief} disabled={!!busy} onChange={patch}/>
    {brief.script?<section className="grid gap-3 border-t border-border pt-5" aria-label="Build video"><p className="text-sm">Build the timeline and generate {brief.script.shots.filter(shot=>shot.source==='generated').length} planned video sections. Presenter and screencast sections need recordings. Voiceover, music and sound cues need separate audio assets.</p>{buildIssue?<p role="alert" className="text-sm">{buildIssue}</p>:null}{alreadyBuilt?<Button onClick={onBuilt}>Open timeline</Button>:<Button disabled={!!busy||scene.batchRunning||!!buildIssue} onClick={()=>setConfirmBuild(true)}>{busy==='build'?'Building timeline':'Build video'}</Button>}{confirmBuild?<div className="video-brief-confirm"><p>{saved?.builtScript||Object.values(saved?.beatClips??{}).some(clip=>clip.videoId)?'Update the timeline from this script? Matching sections keep their takes and trims; removed sections leave the timeline. Saved source takes remain in Library.':'Create the sequence and start the available video generations?'} Missing recordings remain visible placeholders. Generation may incur provider charges.</p><Button disabled={!!busy} onClick={()=>void build()}>Build and generate</Button><Button variant="ghost" onClick={()=>setConfirmBuild(false)}>Keep editing</Button></div>:null}</section>:null}

  </div>;
}
