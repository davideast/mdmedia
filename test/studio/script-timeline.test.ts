import {it,expect} from 'bun:test';
import {buildScriptTimeline,placementNeedsRecording,retainTake} from '../../studio/src/lib/script-timeline';
import {resolveSceneTracks,directionForBeat} from '../../studio/src/lib/scene-tracks';
import {createSceneDraft} from '../../studio/src/lib/scene-direction';
import {WorkspaceStore} from '../../studio/src/lib/workspace';
import type {SceneDraftRecord,VideoJob} from '../../studio/src/lib/video-generation';
import type {VideoScript} from '../../studio/src/lib/video-script';
const v=`v_${'a'.repeat(32)}`;
const script:VideoScript={title:'Pilot',sourceTranscript:'Original.',sourceDescription:'Desk.',shots:[{id:'recording',title:'Demo',seconds:5,source:'screencast',connection:'cut',dialogue:'Real tutorial',visual:'Terminal demonstration',audio:''},{id:'payoff',title:'Payoff',seconds:3,source:'generated',connection:'cut',dialogue:'',visual:'A cinematic keyboard',audio:'Impact cue'}]};
const base:SceneDraftRecord={draft:createSceneDraft(),videoBrief:{prompt:'Pilot',targetSeconds:30,sourceIn:0,sourceOut:0,script}};
it('builds every script section as a stable placement without generating recordings',()=>{
 const result=buildScriptTimeline(base,script);
 expect(result.draft.beats.map(b=>[b.start,b.end])).toEqual([[0,5],[5,8]]);
 expect(result.beatClips!.script_recording.placement?.id).toBe('recording');
 expect(placementNeedsRecording(result.beatClips!.script_recording)).toBe(true);
 expect(placementNeedsRecording(result.beatClips!.script_payoff)).toBe(false);
 expect(result.draft.beats[1].text).toContain('No spoken dialogue');
 expect(result.builtScript).toEqual(script);
});
it('rebuilding preserves existing takes and trims for matching sections',()=>{
 const first=buildScriptTimeline(base,script);first.beatClips!.script_payoff={...first.beatClips!.script_payoff,videoId:v,inSeconds:.5,outSeconds:2.8};
 const next=buildScriptTimeline(first,script);
 expect(next.beatClips!.script_payoff.videoId).toBe(v);expect(next.beatClips!.script_payoff.inSeconds).toBe(.5);
 const changed=buildScriptTimeline(first,{...script,shots:script.shots.map(s=>s.id==='payoff'?{...s,source:'presenter'}:s)});
 expect(changed.beatClips!.script_payoff.videoId).toBeUndefined();expect(changed.beatClips!.script_payoff.takeHistory?.[0].videoId).toBe(v);
});
it('uploaded sources match placements, and short media does not silently shift later sections',()=>{
 const result=buildScriptTimeline(base,script);result.beatClips!.script_recording.videoId=v;
 const job:VideoJob={id:v,model:'uploaded-video',status:'ready',mode:'text',frame:'16:9',createdAt:0,updatedAt:0,durationSeconds:3};
 let rows=resolveSceneTracks(result.draft,result.beatClips!,{[v]:job});
 expect(rows[0].matches).toBe(true);expect(rows[0].trim.duration).toBe(3);expect(rows[1].start).toBe(5);
 result.beatClips!.script_recording.timingAccepted=true;
 rows=resolveSceneTracks(result.draft,result.beatClips!,{[v]:job});expect(rows[1].start).toBe(3);
});
it('replacing an upstream take invalidates the dependent continuation',()=>{
 const chain={...script,shots:script.shots.map((s,i)=>({...s,source:'generated' as const,connection:i?'continue' as const:'cut' as const}))};
 const result=buildScriptTimeline(base,chain),next=`v_${'b'.repeat(32)}`,replacement=`v_${'c'.repeat(32)}`;
 result.beatClips!.script_recording.videoId=replacement;result.beatClips!.script_payoff.videoId=next;
 const common={model:'test',status:'ready' as const,mode:'text' as const,frame:'16:9' as const,createdAt:0,updatedAt:0,canExtend:true};
 const jobs={[replacement]:{...common,id:replacement,durationSeconds:5,direction:directionForBeat(result.draft,result.draft.beats[0])},[next]:{...common,id:next,durationSeconds:8,continuation:{sourceVideoId:v,startSeconds:5},direction:directionForBeat(result.draft,result.draft.beats[1])}};
 expect(resolveSceneTracks(result.draft,result.beatClips!,jobs)[1].needsContinuation).toBe(true);
});
it('persists placement identity, pending takes, history and accepted timing',()=>{
 const record=buildScriptTimeline(base,script);record.beatClips!.script_payoff={...record.beatClips!.script_payoff,videoId:v,pendingVideoId:`v_${'b'.repeat(32)}`,timingAccepted:true,takeHistory:retainTake({videoId:v,inSeconds:0,outSeconds:3})};
 const data=new Map<string,string>();const storage={getItem:(key:string)=>data.get(key)??null,setItem:(key:string,value:string)=>{data.set(key,value);}};
 const first=new WorkspaceStore('timeline-test');first.restore(storage);first.setSceneDraft('pilot',record);first.flush();const second=new WorkspaceStore('timeline-test');second.restore(storage);
 expect(second.getSnapshot().sceneDrafts.pilot.builtScript).toEqual(script);expect(second.getSnapshot().sceneDrafts.pilot.beatClips?.script_payoff).toMatchObject({placement:script.shots[1],pendingVideoId:`v_${'b'.repeat(32)}`,timingAccepted:true,takeHistory:record.beatClips!.script_payoff.takeHistory});first.dispose();second.dispose();
});
it('sends scripted speech and sound through the actual beat generation direction',()=>{
 const spoken={...script,shots:[{...script.shots[1],dialogue:'HEIDI: You are alive.',audio:'A door latch clicks. Room tone underneath speech.'}]};
 const result=buildScriptTimeline(base,spoken);
 const direction=directionForBeat(result.draft,result.draft.beats[0]);
 expect(direction.beats[0].text).toContain('HEIDI: You are alive.');
 expect(direction.beats[0].text).toContain('A door latch clicks.');
 expect(direction.beats[0].text).not.toContain('No spoken dialogue');
});
it('repairs untouched imported directions while preserving edits and generated takes',async()=>{
 const {restoreScriptAudio}=await import('../../studio/src/lib/script-timeline');
 const record=buildScriptTimeline(base,script);
 const legacy=`${script.shots[1].visual}\nNo spoken dialogue. Any scripted voiceover, music and sound effects are separate audio assets.`;
 record.draft.beats[1].text=legacy;
 expect(restoreScriptAudio(record).draft.beats[1].text).toContain('Impact cue');
 record.draft.beats[1].text='My revised direction';
 expect(restoreScriptAudio(record)).toBe(record);
 record.draft.beats[1].text=legacy;record.beatClips!.script_payoff.videoId=v;
 expect(restoreScriptAudio(record)).toBe(record);
});
it('restores an agent checkpoint with continuation clips and its finished export',async()=>{
 const {readVideoPlanSnapshot,restoreVideoPlan}=await import('../../studio/src/lib/video-plan-snapshot');
 const record=buildScriptTimeline(base,script);record.beatClips!.script_payoff.videoId=v;record.exportId=v;
 const restored=restoreVideoPlan(readVideoPlanSnapshot(record));
 expect(restored?.beatClips?.script_payoff.videoId).toBe(v);
 expect(restored?.beatClips?.script_payoff.placement).toEqual(script.shots[1]);
 expect(restored?.exportId).toBe(v);
 expect(restoreVideoPlan({clips:'bad'})).toBeNull();
});
