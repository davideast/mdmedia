import {readVideoScript,type ScriptShot,type VideoScript} from './video-script';
import {isVideoId,type SceneBeatClip,type SceneDraftRecord} from './video-generation';
import {beatDuration} from './scene-tracks';
import {applyScriptContinuity,assertGenerationContinuity,scriptContinuity} from './script-continuity';

/** A placement retains script identity independently of whichever take supplies its media. */
export function readScriptPlacement(value:unknown):ScriptShot|undefined {
  return readVideoScript({title:'Placement',sourceTranscript:'',sourceDescription:'',shots:[value]})?.shots[0];
}
export function scriptShotDirection(shot:ScriptShot) {
  if(shot.source!=='generated')return shot.visual;
  return [shot.visual,
    shot.dialogue.trim()?`Spoken dialogue, performed by the named characters exactly as written. Speaker labels and performance directions are not spoken. Preserve each speaker's voice, and do not add a narrator or repeat earlier lines:\n${shot.dialogue}`:'No spoken dialogue.',
    shot.audio.trim()?`Sound direction: ${shot.audio}\nInclude this sound in the generated video's audio. Keep music and effects below dialogue.`:'Include natural environmental sound appropriate to the scene.',
  ].join('\n\n');
}

/** Upgrade untouched, ungenerated imports without overwriting authored direction or takes. */
export function restoreScriptAudio(record:SceneDraftRecord):SceneDraftRecord {
  let changed=false;
  const beats=record.draft.beats.map(beat=>{
    const clip=record.beatClips?.[beat.id],shot=clip?.placement;
    if(!shot||shot.source!=='generated'||clip?.videoId||clip?.pendingVideoId)return beat;
    const legacy=`${shot.visual}\nNo spoken dialogue. Any scripted voiceover, music and sound effects are separate audio assets.`;
    if(beat.text!==legacy)return beat;
    changed=true;return {...beat,text:scriptShotDirection(shot)};
  });
  return changed?{...record,draft:{...record.draft,beats}}:record;
}
export function buildScriptTimeline(record:SceneDraftRecord,script:VideoScript,originalVideoId?:string):SceneDraftRecord {
  if(!readVideoScript(script))throw new Error('Complete the script before building the video.');
  script=applyScriptContinuity(script,record.videoBrief);
  const continuous=scriptContinuity(record.videoBrief,script)==='continuous';
  if(script.shots.some(shot=>!shot.visual.trim()||!shot.title.trim()))throw new Error('Give every section a title and visual direction.');
  if(script.shots.some(shot=>shot.source==='original')&&(!originalVideoId||!isVideoId(originalVideoId)||record.videoBrief?.sourceUsage!=='include'))throw new Error('Choose Include original footage before placing the reference on the timeline.');
  let time=0;
  const clips:Record<string,SceneBeatClip>={};
  const beats=script.shots.map(shot=>{
    const id=`script_${shot.id}`;
    const previous=record.beatClips?.[id];
    const sameKind=previous?.placement?.source===shot.source;
    const original=shot.source==='original';
    const previousTakes=previous?.takeHistory??[];
    clips[id]={...(sameKind?previous:{}),placement:{...shot},generationMode:shot.source==='generated'&&shot.connection==='continue'?'continue':'new',transition:continuous?'cut':sameKind?previous?.transition??'cut':'cut',
      ...(!sameKind&&previous?.videoId?{takeHistory:[...previousTakes,{videoId:previous.videoId,inSeconds:previous.inSeconds,outSeconds:previous.outSeconds}].slice(-20)}:{}),
      ...(original?{videoId:originalVideoId,inSeconds:record.videoBrief!.sourceIn,outSeconds:record.videoBrief!.sourceOut}:{}),
    };
    const start=time;time+=shot.seconds;
    return {id,start,end:time,text:scriptShotDirection(shot)};
  });
  const anchor=continuous?`One continuous shot, with no cuts. Preserve the subject, wardrobe, setting and lighting established here: ${script.shots[0].visual}`:'';
  const oldAnchor=record.builtScript?`One continuous shot, with no cuts. Preserve the subject, wardrobe, setting and lighting established here: ${record.builtScript.shots[0].visual}`:'';
  const shared=oldAnchor?record.draft.note.replace(oldAnchor,'').trim():record.draft.note;
  const note=[shared,anchor].filter(Boolean).join('\n\n');
  const result:SceneDraftRecord={...record,title:script.title,draft:{mode:record.draft.mode,frame:record.draft.frame,note,beats},beatClips:clips,builtScript:script,view:'tracks'};
  assertGenerationContinuity(result);
  return result;
}
export function placementNeedsRecording(clip?:SceneBeatClip){return !!clip?.placement&&clip.placement.source!=='generated';}
export function placementStatus(clip:SceneBeatClip|undefined,ready:boolean){
  if(ready)return 'Ready';
  if(placementNeedsRecording(clip)&&!clip?.videoId)return clip!.placement!.source==='screencast'?'Needs screen recording':'Needs recording';
  return undefined;
}
export function retainTake(clip:SceneBeatClip):NonNullable<SceneBeatClip['takeHistory']>{
  return [...clip.takeHistory??[],...(clip.videoId?[{videoId:clip.videoId,inSeconds:clip.inSeconds,outSeconds:clip.outSeconds}]:[])].slice(-20);
}
export function replacementTiming(draft:SceneDraftRecord['draft'],beatId:string,duration:number){
  const beat=draft.beats.find(beat=>beat.id===beatId);
  return beat?{planned:beatDuration(beat),available:duration,short:duration+0.05<beatDuration(beat)}:undefined;
}
