import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'bun:test';
import { parseBeatContinuation, continuationRequest } from '../../studio/src/lib/beat-continuation';
import { createSceneDraft } from '../../studio/src/lib/scene-direction';
import { directionForBeat, resolveSceneTracks } from '../../studio/src/lib/scene-tracks';
import { runVideoJob } from '../../studio/src/lib/video-job-runner';
import { coalesceContinuousRanges, exportDuration } from '../../studio/src/lib/video-export';
import { WorkspaceStore, type WorkspaceStorage } from '../../studio/src/lib/workspace';
import type { SceneBeatClip, VideoJob } from '../../studio/src/lib/video-generation';

const a=`v_${'a'.repeat(32)}`,b=`v_${'b'.repeat(32)}`,c=`v_${'c'.repeat(32)}`;
const draft=createSceneDraft();draft.beats.push({id:'reveal',start:6,end:12,text:'Reveal the subject.'});
const source=(id:string,index:number,duration:number,continuation?:VideoJob['continuation']):VideoJob=>({id,status:'ready',model:'gemini-omni-1.1-flash',mode:'text',frame:'16:9',createdAt:0,updatedAt:0,durationSeconds:duration,direction:directionForBeat(draft,draft.beats[index]),canExtend:true,...(continuation?{continuation}:{})});
const jobs={
  [a]:source(a,0,3.008),
  [b]:source(b,1,6.016,{sourceVideoId:a,startSeconds:3.008}),
  [c]:source(c,2,12.024,{sourceVideoId:b,startSeconds:6.016}),
};
const clips:Record<string,SceneBeatClip>={opening:{videoId:a},unfurl:{videoId:b,generationMode:'continue'},reveal:{videoId:c,generationMode:'continue'}};

describe('beat continuation',()=>{
  it('resolves one common source and exact adjacent ranges while retaining each beat identity',()=>{
    const rows=resolveSceneTracks(draft,clips,jobs);
    expect(rows.every(row=>row.matches&&row.sourceVideoId===c)).toBe(true);
    expect(rows.map(row=>row.clip?.videoId)).toEqual([a,b,c]);
    expect(rows.map(row=>[row.trim.start,row.trim.end])).toEqual([[0,3.008],[3.008,6.016],[6.016,12.024]]);
    expect(rows[1].start).toBe(rows[0].end);expect(rows[2].start).toBe(rows[1].end);
    expect(rows.every(row=>row.transition==='cut')).toBe(true);
  });
  it('invalidates downstream dependencies on direction, source, order, exclusion or ending changes',()=>{
    const edited={...draft,beats:draft.beats.map((beat,index)=>index===0?{...beat,text:'New opening'}:beat)};
    expect(resolveSceneTracks(edited,clips,jobs).map(row=>row.matches)).toEqual([false,false,false]);
    const trimmed=resolveSceneTracks(draft,{...clips,opening:{...clips.opening,outSeconds:2}},jobs);
    expect(trimmed.map(row=>row.matches)).toEqual([true,false,false]);
    expect(trimmed[1].needsContinuation).toBe(true);expect(trimmed[1].continuationIssue).toContain('original ending');
    expect(trimmed[0].sourceVideoId).toBe(a);
    const replaced=resolveSceneTracks(draft,{...clips,opening:{videoId:c}},jobs);
    expect(replaced[1].needsContinuation).toBe(true);expect(replaced[2].needsContinuation).toBe(true);
    const excluded=resolveSceneTracks(draft,{...clips,unfurl:{...clips.unfurl,excluded:true}},jobs);
    expect(excluded[2].needsContinuation).toBe(true);
    const reordered=resolveSceneTracks({...draft,beats:[draft.beats[1],draft.beats[0],draft.beats[2]]},clips,jobs);
    expect(reordered[0].continuationIssue).toContain('first included');expect(reordered[2].needsContinuation).toBe(true);
    const leadingTrim=resolveSceneTracks(draft,{...clips,opening:{...clips.opening,inSeconds:1}},jobs);
    expect(leadingTrim.every(row=>row.matches)).toBe(true);
  });
  it('requires explicit continuation mode and keeps independent shots separate',()=>{
    const rows=resolveSceneTracks(draft,{...clips,unfurl:{videoId:b}},jobs);
    expect(rows[1].matches).toBe(false);expect(rows[0].sourceVideoId).toBe(a);
    const newShot=source(b,1,3);
    const independent=resolveSceneTracks(draft,{opening:clips.opening,unfurl:{videoId:b}},{[a]:jobs[a],[b]:newShot});
    expect(independent[0].sourceVideoId).toBe(a);expect(independent[1].sourceVideoId).toBe(b);
  });
  it('validates continuation boundaries, frame, source readiness and the connected-shot budget',()=>{
    const input=parseBeatContinuation({id:b,sourceVideoId:a,sourceEndSeconds:3.008,draft:directionForBeat(draft,draft.beats[1])});
    const request=continuationRequest(input,jobs[a],'private-interaction');
    expect(request.continuation).toEqual({sourceVideoId:a,startSeconds:3.008,interactionId:'private-interaction'});
    expect(request.firstFrame).toBeNull();expect(request.references).toEqual([]);
    expect(()=>parseBeatContinuation({...input,id:'../other'})).toThrow('invalid');
    expect(()=>continuationRequest({...input,sourceEndSeconds:2},jobs[a],'interaction')).toThrow('original ending');
    expect(()=>continuationRequest(input,{...jobs[a],status:'generating'},'interaction')).toThrow('finish');
    expect(()=>continuationRequest(input,jobs[a],undefined)).toThrow('cannot be continued');
    expect(()=>continuationRequest(input,{...jobs[a],frame:'9:16'},'interaction')).toThrow('same frame');
    expect(()=>continuationRequest({...input,sourceEndSeconds:38},{...jobs[a],durationSeconds:38},'interaction')).toThrow('40 seconds');
  });
  it('continues directly from the parent interaction, stores the full source and never regenerates its opening',async()=>{
    const input=parseBeatContinuation({id:b,sourceVideoId:a,sourceEndSeconds:3.008,draft:directionForBeat(draft,draft.beats[1])});
    const request=continuationRequest(input,jobs[a],'parent-interaction');
    const patches:Partial<VideoJob>[]=[];let calls=0,saves=0;
    const mp4=new Uint8Array([0,0,0,12,102,116,121,112,105,115,111,109]);
    await runVideoJob(request,{
      provider:{async generateVideoClip(prompt,options){calls++;expect(options?.previousInteractionId).toBe('parent-interaction');expect(options?.durationSeconds).toBe(3);expect(options?.task).toBeUndefined();expect(options?.firstFrame).toBeUndefined();expect(prompt).toContain('total of 6.008 seconds');expect(prompt).toContain('Move closer');expect(prompt).not.toContain('Glide through');return {interactionId:'continued',videoBytes:mp4,durationSeconds:6.016};}},
      update:async patch=>{patches.push(patch);},save:async()=>{saves++;},
    });
    expect(calls).toBe(1);expect(saves).toBe(1);expect(patches.at(-1)).toMatchObject({status:'ready',durationSeconds:6.016});
  });
  it('passes supplied cast references along with the parent interaction on continuation',async()=>{
    const input=parseBeatContinuation({id:b,sourceVideoId:a,sourceEndSeconds:3.008,draft:directionForBeat(draft,draft.beats[1])});
    const request=continuationRequest(input,jobs[a],'parent');
    const bytes=new Uint8Array([255,216,255,224,1,2,3]);
    request.references=[new File([bytes],'cast.jpg',{type:'image/jpeg'})];
    let called=false;
    await runVideoJob(request,{provider:{async generateVideoClip(_prompt,options){
      called=true;expect(options?.previousInteractionId).toBe('parent');expect(options?.referenceImages).toHaveLength(1);
      expect(new Uint8Array(await readFile(options!.referenceImages![0]))).toEqual(bytes);
      expect(options?.firstFrame).toBeUndefined();
      return {interactionId:'continued',videoBytes:new Uint8Array([0,0,0,12,102,116,121,112,105,115,111,109]),durationSeconds:6.008};
    }},update:async()=>{},save:async()=>{}});
    expect(called).toBe(true);
  });
  it('preserves a partial continuation and resumes only its unfinished tail',async()=>{
    const long={...directionForBeat(draft,draft.beats[1]),beats:[{...draft.beats[1],start:0,end:18}]};
    const request=continuationRequest(parseBeatContinuation({id:b,sourceVideoId:a,sourceEndSeconds:3.008,draft:long}),jobs[a],'parent');
    request.resume={interactionId:'saved-continuation',durationSeconds:13.008};
    const patches:Partial<VideoJob>[]=[];let calls=0;
    await runVideoJob(request,{provider:{async generateVideoClip(_prompt,options){calls++;expect(options?.previousInteractionId).toBe('saved-continuation');expect(options?.durationSeconds).toBe(8);return {interactionId:'finished',videoBytes:new Uint8Array([0,0,0,12,102,116,121,112,105,115,111,109]),durationSeconds:21.008};}},update:async patch=>{patches.push(patch);},save:async()=>{}});
    expect(calls).toBe(1);expect(patches.at(-1)).toMatchObject({status:'ready',durationSeconds:21.008});
  });
  it('coalesces uninterrupted ranges but honors user fades and mute changes',()=>{
    const segments=[{videoId:c,inSeconds:0,outSeconds:3.008,muted:false},{videoId:c,inSeconds:3.008,outSeconds:6.016,muted:false},{videoId:c,inSeconds:6.016,outSeconds:12.024,muted:false}];
    expect(coalesceContinuousRanges(segments)).toEqual([{...segments[0],outSeconds:12.024,transition:undefined,transitionSeconds:undefined}]);
    expect(exportDuration(coalesceContinuousRanges(segments))).toBeCloseTo(exportDuration(segments),6);
    expect(coalesceContinuousRanges([{...segments[0],transition:'fade',transitionSeconds:0.5},...segments.slice(1)])).toHaveLength(2);
    expect(coalesceContinuousRanges([segments[0],{...segments[1],muted:true},segments[2]])).toHaveLength(3);
    expect(segments[0].outSeconds).toBe(3.008);
  });
  it('persists continuation choices and absolute beat windows across refresh',()=>{
    const values=new Map<string,string>();const storage:WorkspaceStorage={getItem:key=>values.get(key)??null,setItem:(key,value)=>{values.set(key,value);},keys:()=>[...values.keys()],removeItem:key=>{values.delete(key);}};
    const first=new WorkspaceStore('continuation-test');first.restore(storage);first.setSceneDraft('a',{draft,beatClips:{...clips,unfurl:{...clips.unfurl,inSeconds:3.008,outSeconds:6.016}}});first.flush();
    const next=new WorkspaceStore('continuation-test');next.restore(storage);expect(next.getSnapshot().sceneDrafts.a.beatClips?.unfurl).toMatchObject({generationMode:'continue',videoId:b,inSeconds:3.008,outSeconds:6.016});first.dispose();next.dispose();
  });
});
