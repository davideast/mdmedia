import {describe,it,expect} from 'bun:test';
import {readVideoBrief,readVideoScript,plannedShots,shotTiming,scriptTiming, type VideoBrief} from '../../studio/src/lib/video-script';
import {validatePlannedScript,draftValidatedScript} from '../../studio/src/lib/video-script-planner';
import {WorkspaceStore} from '../../studio/src/lib/workspace';
import {createSceneDraft} from '../../studio/src/lib/scene-direction';
const source={id:`s_${'a'.repeat(32)}`,name:'intro.mov',durationSeconds:4.83,createdAt:1};
const script={title:'Hollywood terminal',sourceTranscript:'Hello.',sourceDescription:'Presenter at desk.',shots:[
 {id:'intro',title:'Opening',source:'original' as const,connection:'cut' as const,seconds:4.83,dialogue:'Hello.',visual:'Keep original footage.',audio:'Original audio'},
 {id:'demo',title:'Demonstration',source:'screencast' as const,connection:'cut' as const,seconds:10,dialogue:'Run the command.',visual:'Real CLI recording.',audio:''},
 {id:'return',title:'Return to desk',source:'presenter' as const,connection:'cut' as const,seconds:5,dialogue:'That was a mistake.',visual:'Presenter at desk.',audio:''},
]};
const brief:VideoBrief={prompt:'Make a funny developer video.',targetSeconds:20,sourceUsage:'include',source,sourceIn:0,sourceOut:4.83,script};
describe('prompt-to-script foundation',()=>{
 it('preserves original footage and identifies missing production inputs',()=>{
  const shots=plannedShots(script,source,'include');
  expect(shots[0].issue).toBeNull();expect(shots[1].start).toBe(4.83);expect(shots[1].issue).toContain('real CLI');expect(shots[2].issue).toContain('presenter workflow');
 });
 it('does not call an uploaded-source continuation ready for generation',()=>{
  const result=plannedShots({...script,shots:[script.shots[0],{...script.shots[2],source:'generated',connection:'continue'}]},source);
  expect(result[1].issue).toContain('supported source');
 });
 it('keeps original dialogue tied to the observed transcript',()=>{
  const planned=validatePlannedScript({...script,shots:[{...script.shots[0],dialogue:'Invented opening'}]},{...brief,targetSeconds:4.83});
  expect(planned.shots[0].dialogue).toBe(script.sourceTranscript);
 });
 it('rejects invalid source ids, bounds and malformed model output',()=>{
  expect(readVideoBrief({...brief,source:{...source,id:'../../other'}})).toBeNull();
  expect(readVideoBrief({...brief,sourceOut:9})).toBeNull();
  expect(readVideoScript({...script,shots:[script.shots[0],script.shots[0]]})).toBeNull();
  expect(readVideoScript({...script,shots:[{...script.shots[0],seconds:Infinity}]})).toBeNull();
  expect(()=>validatePlannedScript({...script,shots:[{...script.shots[0],seconds:8}]},brief)).toThrow('selected opening');
  expect(()=>validatePlannedScript(script,{...brief,source:undefined})).toThrow('selected opening');
 });
 it('restores the editable script separately from existing beats and generated clips',()=>{
  const snapshot={version:1,tabs:[],activeId:null,drafts:{},sceneDrafts:{pilot:{draft:createSceneDraft(),videoBrief:brief}}};
  const store=new WorkspaceStore('script-test');store.restore({getItem:()=>JSON.stringify(snapshot),setItem:()=>{}});const restored=store.getSnapshot();store.dispose();
  expect(restored.sceneDrafts.pilot.videoBrief).toEqual(brief);
  expect(restored.sceneDrafts.pilot.draft).toEqual(snapshot.sceneDrafts.pilot.draft);
 });
});

describe('reference intent and pacing',()=>{
 it('defaults legacy briefs to reference without deleting their editable script',()=>{
  const restored=readVideoBrief({...brief,sourceUsage:undefined});
  expect(restored?.sourceUsage).toBe('reference');
  expect(restored?.script).toEqual(script);
  expect(plannedShots(script,source)[0].issue).toContain('reference only');
 });
 it('rejects original footage when only a visual reference was requested',()=>{
  expect(()=>validatePlannedScript(script,{...brief,sourceUsage:'reference'})).toThrow('Reference-only');
 });
 it('flags a six-second demonstration containing eighteen words',()=>{
  const shot={...script.shots[1],seconds:6,dialogue:'Today we are upgrading our normal boring terminal workflow into something completely overproduced with just a few commands.'};
  const pace=shotTiming(shot);
  expect(pace.rushed).toBe(true);expect(pace.minimumSeconds).toBeGreaterThan(10);
  expect(()=>validatePlannedScript({...script,shots:[{...shot,connection:'cut'}]},{...brief,source:undefined,targetSeconds:75})).toThrow('short of');
 });
 it('does not approve a 22-second outline for a 75-second request',()=>{
  expect(scriptTiming(script,75).onTarget).toBe(false);
  expect(()=>validatePlannedScript(script,{...brief,targetSeconds:75})).toThrow('short of');
 });
 it('repairs a short model response once and validates the correction',async()=>{
  const b={...brief,source:undefined,targetSeconds:20};let calls=0;
  const good={...script,shots:[{...script.shots[1],seconds:10},{...script.shots[2],seconds:10}]};
  const result=await draftValidatedScript(b,async repair=>{calls++;if(!repair)return {...good,shots:[good.shots[0]]};expect(repair.problem).toContain('short of');return good;});
  expect(calls).toBe(2);expect(result.shots).toHaveLength(2);
 });
 it('stops after two invalid drafts rather than accepting bad timing',async()=>{
  let calls=0;await expect(draftValidatedScript({...brief,targetSeconds:75},async()=>{calls++;return script;})).rejects.toThrow('existing script has been kept');expect(calls).toBe(2);
 });
});

it('rejects invented command flags in planned screencasts',()=>{
 const unsafe={...script,shots:[{...script.shots[1],visual:"Run mdmedia pipeline --video --music --sfx"}]};
 expect(()=>validatePlannedScript(unsafe,{...brief,source:undefined})).toThrow('invented command syntax');
});
