import {expect,it} from 'bun:test';
import {buildScriptTimeline} from '../../studio/src/lib/script-timeline';
import {assertGenerationContinuity} from '../../studio/src/lib/script-continuity';
import {createSceneDraft} from '../../studio/src/lib/scene-direction';
import type {SceneDraftRecord} from '../../studio/src/lib/video-generation';
import type {VideoScript} from '../../studio/src/lib/video-script';
import {readVideoBrief} from '../../studio/src/lib/video-script';
import {readVideoPlanSnapshot} from '../../studio/src/lib/video-plan-snapshot';
import {runSceneGenerationQueue} from '../../studio/src/lib/scene-generation-queue';
const script:VideoScript={title:'Dog dance',sourceTranscript:'',sourceDescription:'',shots:[15,15].map((seconds,i)=>({id:`shot_${i+1}`,title:`Beat ${i+1}`,seconds,source:'generated',connection:'cut',dialogue:'',visual:i?'The dog keeps dancing.':'A Bernese Mountain Dog in a red jacket in a moonlit graveyard.',audio:''}))};
const record:SceneDraftRecord={draft:{...createSceneDraft(),note:'Keep the same dancers.'},videoBrief:{prompt:'One continuous dance.',targetSeconds:30,continuity:'continuous',sourceIn:0,sourceOut:0}};
it('overrides planner cuts for an explicitly continuous scene and preserves its shared direction',()=>{
 const result=buildScriptTimeline(record,script);
 expect(Object.values(result.beatClips!).map(c=>c.generationMode)).toEqual(['new','continue']);
 expect(result.draft.note).toContain('Keep the same dancers.');
 expect(result.draft.note).toContain('red jacket');
 expect(result.builtScript!.shots.map(s=>s.connection)).toEqual(['cut','continue']);
});
it('rejects the reported 80-second continuous script before building or submitting',()=>{
 const long={...script,shots:[15,15,18,15,17].map((seconds,i)=>({...script.shots[0],id:`shot_${i}`,seconds}))};
 expect(()=>buildScriptTimeline(record,long)).toThrow('80');
});
it('preflights the entire existing timeline, including manual generation and legacy drafts',()=>{
 const built=buildScriptTimeline(record,script);
 built.beatClips!.script_shot_2.generationMode='new';
 expect(()=>assertGenerationContinuity(built)).toThrow('Rebuild');
});
it('retains explicitly planned cuts and validates each connected run separately',()=>{
 const edited={...record,videoBrief:{...record.videoBrief!,continuity:'planned' as const}};
 const built=buildScriptTimeline(edited,{...script,shots:script.shots.map(s=>({...s,seconds:30}))});
 expect(Object.values(built.beatClips!).map(c=>c.generationMode)).toEqual(['new','new']);
 expect(()=>assertGenerationContinuity(built)).not.toThrow();
});
it('waits for the actual parent result and stops the normalized script chain on a partial result',async()=>{
 const built=buildScriptTimeline(record,script),calls:string[]=[];
 await expect(runSceneGenerationQueue(false,{
  read:()=>built.draft.beats.map(beat=>({beatId:beat.id,included:true,matches:false,busy:false,generationMode:built.beatClips![beat.id].generationMode!})),
  submit:async id=>{calls.push(`submit ${id}`);return 'first-job';},
  wait:async id=>{calls.push(`wait ${id}`);return {id,status:'partial',message:'First beat is incomplete',model:'test',mode:'text',frame:'16:9',createdAt:0,updatedAt:0};},
 })).rejects.toThrow('First beat is incomplete');
 expect(calls).toEqual(['submit script_shot_1','wait first-job']);
});
it('retains explicit continuity and only approved fields in the persisted plan',()=>{
 expect(readVideoBrief(record.videoBrief)?.continuity).toBe('continuous');
 const built=buildScriptTimeline(record,script);
 const plan=readVideoPlanSnapshot({...built,ownerUid:'injected'});
 expect(plan.brief.continuity).toBe('continuous');
 expect(plan.clips.map(c=>c.generationMode)).toEqual(['new','continue']);
 expect(plan).not.toHaveProperty('ownerUid');
 expect(()=>readVideoPlanSnapshot({draft:built.draft,videoBrief:{prompt:123}})).toThrow();
});
it('rejects too-short continuation beats before generating the opening',()=>{
 expect(()=>buildScriptTimeline(record,{...script,shots:script.shots.map((s,i)=>({...s,seconds:i?2:10}))})).toThrow('at least 3 seconds');
});
it('rebuilding replaces the derived anchor without duplicating old scene instructions',()=>{
 const first=buildScriptTimeline(record,script);
 const updated={...script,shots:script.shots.map((s,i)=>i?s:{...s,visual:'A dog in a blue jacket.'})};
 const result=buildScriptTimeline(first,updated);
 expect(result.draft.note).toContain('Keep the same dancers.');
 expect(result.draft.note).toContain('blue jacket');
 expect(result.draft.note).not.toContain('red jacket');
});
