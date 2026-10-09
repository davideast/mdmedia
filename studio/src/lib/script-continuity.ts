import type {VideoBrief,VideoScript} from './video-script';
import type {SceneDraftRecord} from './video-generation';
import {MAX_SCENE_SECONDS} from './scene-generation-plan';

/** Legacy all-generated scripts default to continuity; mixed-media edits keep their plan. */
export function scriptContinuity(brief?:VideoBrief,script?:VideoScript):'continuous'|'planned' {
  return brief?.continuity??(script?.shots.every(shot=>shot.source==='generated')?'continuous':'planned');
}
export function applyScriptContinuity(script:VideoScript,brief?:VideoBrief):VideoScript {
  if(scriptContinuity(brief,script)!=='continuous')return script;
  if(script.shots.some(shot=>shot.source!=='generated'))throw new Error('One continuous shot currently requires generated video sections. Choose Planned cuts for recordings or mixed media.');
  return {...script,shots:script.shots.map((shot,index)=>({...shot,connection:index?'continue':'cut'}))};
}
export function assertGenerationContinuity(record:SceneDraftRecord) {
  const rows=record.draft.beats.filter(beat=>beat.text.trim()&&!record.beatClips?.[beat.id]?.excluded);
  const continuous=!!record.builtScript&&scriptContinuity(record.videoBrief,record.builtScript)==='continuous';
  let duration=0;
  for(let index=0;index<rows.length;index++){
    const beat=rows[index],clip=record.beatClips?.[beat.id];
    const extending=continuous?index>0:clip?.generationMode==='continue';
    if(!extending)duration=0;
    if(extending&&beat.start!==null&&beat.end!==null&&beat.end-beat.start<3)throw new Error('Every continuation beat needs at least 3 seconds. Adjust the script before generating.');
    const seconds=beat.start!==null&&beat.end!==null?Math.max(3,Math.ceil(beat.end-beat.start)):0;
    if(!seconds&&(extending||continuous))throw new Error('Give every connected beat a duration before generating.');
    duration+=seconds;
    if(duration>MAX_SCENE_SECONDS){
      const total=continuous?rows.reduce((sum,b)=>sum+(b.start!==null&&b.end!==null?Math.max(3,Math.ceil(b.end-b.start)):0),0):duration;
      throw new Error(`This continuous shot needs ${total}s; the current generation limit is ${MAX_SCENE_SECONDS}s. Shorten the connected scene, or explicitly choose Planned cuts and start a new shot. No clips were submitted.`);
    }
  }
  if(continuous&&rows.some((beat,index)=>{
    const clip=record.beatClips?.[beat.id];
    return clip?.placement?.source!=='generated'||(clip.generationMode??'new')!==(index?'continue':'new')||clip.transition==='fade';
  }))throw new Error('This timeline does not match One continuous shot. Rebuild it from Brief and script before generating. Existing clips are preserved.');
}
