import { describe, expect, it } from 'bun:test';
import { createSceneDraft, readSceneDraft } from '../../studio/src/lib/scene-direction';
import { beatClipMatches, directionForBeat, trackPositions, reorderBeat } from '../../studio/src/lib/scene-tracks';
import { parseVideoExport } from '../../studio/src/lib/video-export';
import { WorkspaceStore, type WorkspaceStorage } from '../../studio/src/lib/workspace';
import type { VideoJob } from '../../studio/src/lib/video-generation';
const id=`v_${'a'.repeat(32)}`;
const job=(direction:VideoJob['direction']):VideoJob=>({id,status:'ready',model:'test',mode:'text',frame:'16:9',createdAt:0,updatedAt:0,durationSeconds:3,direction});

describe('beat tracks',()=>{
  it('generates only one beat with local timing and visible shared direction',()=>{
    const draft=createSceneDraft();draft.note='Carry the blue morning light.';
    const beat=directionForBeat(draft,draft.beats[1]);
    expect(beat.beats).toEqual([{...draft.beats[1],start:0,end:3}]);expect(beat.note).toBe(draft.note);
    expect(beatClipMatches(draft,draft.beats[1],job(readSceneDraft({version:1,draft:beat})!))).toBe(true);
    const edited={...draft,beats:draft.beats.map((beat,index)=>index===0?{...beat,text:'A different opening'}:beat)};
    expect(beatClipMatches(edited,edited.beats[1],job(beat))).toBe(true);
    expect(beatClipMatches({...draft,note:'New continuity'},draft.beats[1],job(beat))).toBe(false);
  });
  it('assembles positions from trims, excludes skipped beats, and keeps clip identity on reorder',()=>{
    const draft=createSceneDraft();const source=job(directionForBeat(draft,draft.beats[0]));
    const positions=trackPositions(draft,{opening:{videoId:id,inSeconds:1,outSeconds:2},unfurl:{excluded:true}},{[id]:source});
    expect(positions[0]).toMatchObject({start:0,end:1,trim:{start:1,end:2,duration:1}});expect(positions[1].included).toBe(false);
    const reordered=reorderBeat(draft,'unfurl',-1);expect(reordered.beats.map(beat=>beat.id)).toEqual(['unfurl','opening']);
    expect(beatClipMatches(reordered,reordered.beats[1],source)).toBe(true);
  });
  it('persists tracks, source edits, exports and selected view through refresh without replacing the old full video',()=>{
    const values=new Map<string,string>();const storage:WorkspaceStorage={getItem:key=>values.get(key)??null,setItem:(key,value)=>{values.set(key,value);},keys:()=>[...values.keys()],removeItem:key=>{values.delete(key);}};
    const first=new WorkspaceStore('track-test');first.restore(storage);first.visit('/studio/scene?draft=a');
    first.setSceneDraft('a',{draft:createSceneDraft(),videoId:id,exportId:id,view:'tracks',beatClips:{opening:{videoId:id,inSeconds:0.5,outSeconds:2,muted:true},unfurl:{excluded:true}}});first.flush();
    const refreshed=new WorkspaceStore('track-test');refreshed.restore(storage);
    expect(refreshed.getSnapshot().sceneDrafts.a).toMatchObject({videoId:id,exportId:id,view:'tracks',beatClips:{opening:{videoId:id,inSeconds:0.5,outSeconds:2,muted:true},unfurl:{excluded:true}}});first.dispose();refreshed.dispose();
  });
  it('validates export source ids, trims and bounded sequence length',()=>{
    const valid={id,frame:'16:9',clips:[{videoId:id,inSeconds:0,outSeconds:3,muted:false}]};expect(parseVideoExport(valid).clips).toHaveLength(1);
    expect(()=>parseVideoExport({...valid,clips:[{...valid.clips[0],videoId:'../other'}]})).toThrow('source');
    expect(()=>parseVideoExport({...valid,clips:[{...valid.clips[0],outSeconds:NaN}]})).toThrow('trim');
    expect(()=>parseVideoExport({...valid,clips:[{...valid.clips[0],outSeconds:301}]})).toThrow('300');
    expect(()=>parseVideoExport({...valid,clips:Array(33).fill(valid.clips[0])})).toThrow('32');
    expect(parseVideoExport(valid).clips[0]).toMatchObject({transition:'cut',transitionSeconds:0});
    const fade={...valid.clips[0],transition:'fade',transitionSeconds:0.5};
    expect(()=>parseVideoExport({...valid,clips:[fade]})).toThrow('adjacent');
    expect(()=>parseVideoExport({...valid,clips:[{...fade,transitionSeconds:2},valid.clips[0]]})).toThrow('adjacent');
  });
  it('keeps hard cuts unless a beat explicitly selects a fade',()=>{
    const draft=createSceneDraft();const cut=trackPositions(draft,{},{});
    expect(cut[0].transition).toBe('cut');expect(cut[1].start).toBe(3);
    const fade=trackPositions(draft,{opening:{transition:'fade',transitionSeconds:0.5}},{});
    expect(fade[0].transitionSeconds).toBe(0.5);expect(fade[1].start).toBe(2.5);expect(fade[1].end).toBe(5.5);
    expect(fade[1].transition).toBe('cut');
  });
});
