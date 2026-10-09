import {readVideoBrief,readVideoScript} from './video-script';
import {readSceneDraft} from './scene-direction';
import {isVideoId} from './video-generation';
import type {SceneDraftRecord} from './video-generation';
import {buildScriptTimeline} from './script-timeline';

/** Bounded, private audit snapshot. Browser workspace data is never stored unchecked. */
export function readVideoPlanSnapshot(value:unknown) {
  if(!value||typeof value!=='object')throw new Error('Invalid video plan.');
  const raw=value as Record<string,unknown>;
  const draft=readSceneDraft({version:1,draft:raw.draft});
  const brief=readVideoBrief(raw.videoBrief);
  const script=readVideoScript(raw.builtScript);
  if(!draft||!brief)throw new Error('Invalid video plan.');
  const rawClips=raw.beatClips&&typeof raw.beatClips==='object'?raw.beatClips as Record<string,unknown>:{};
  const clips=draft.beats.map(beat=>{
    const entry=rawClips[beat.id];
    const clip=entry&&typeof entry==='object'?entry as Record<string,unknown>:{};
    return {beatId:beat.id,generationMode:clip.generationMode==='continue'?'continue':'new',excluded:clip.excluded===true,
      muted:clip.muted===true,timingAccepted:clip.timingAccepted===true,
      transition:clip.transition==='fade'?'fade' as const:'cut' as const,
      ...(typeof clip.transitionSeconds==='number'&&Number.isFinite(clip.transitionSeconds)&&clip.transitionSeconds>0?{transitionSeconds:clip.transitionSeconds}:{}),
      ...(typeof clip.inSeconds==='number'&&Number.isFinite(clip.inSeconds)&&clip.inSeconds>=0?{inSeconds:clip.inSeconds}:{}),
      ...(typeof clip.outSeconds==='number'&&Number.isFinite(clip.outSeconds)&&clip.outSeconds>0?{outSeconds:clip.outSeconds}:{}),
      ...(typeof clip.videoId==='string'&&isVideoId(clip.videoId)?{videoId:clip.videoId}:{}),
      ...(typeof clip.pendingVideoId==='string'&&isVideoId(clip.pendingVideoId)?{pendingVideoId:clip.pendingVideoId}:{})};
  });
  const exportId=typeof raw.exportId==='string'&&isVideoId(raw.exportId)?raw.exportId:undefined;
  return JSON.parse(JSON.stringify({brief,script,draft,clips,exportId})) as {brief:NonNullable<typeof brief>;script:typeof script;draft:typeof draft;clips:typeof clips;exportId?:string};
}

/** Restore an agent's generation checkpoint into an editable timeline. */
export function restoreVideoPlan(value:unknown):SceneDraftRecord|null {
  if(!value||typeof value!=='object')return null;
  const raw=value as Record<string,unknown>;
  if(!Array.isArray(raw.clips))return null;
  const beatClips=Object.fromEntries(raw.clips.filter((clip):clip is Record<string,unknown>=>!!clip&&typeof clip==='object'&&typeof clip.beatId==='string').map(clip=>[String(clip.beatId),clip]));
  try{
    const plan=readVideoPlanSnapshot({videoBrief:raw.brief,builtScript:raw.script,draft:raw.draft,beatClips,exportId:raw.exportId});
    if(!plan.script)return null;
    const base=buildScriptTimeline({videoBrief:plan.brief,draft:plan.draft},plan.script);
    return {...base,draft:plan.draft,beatClips:Object.fromEntries(plan.clips.map(({beatId,...clip})=>[beatId,{...base.beatClips?.[beatId],...clip,generationMode:clip.generationMode==='continue'?'continue':'new'}])),...(plan.exportId?{exportId:plan.exportId}:{})};
  }catch{return null;}
}
