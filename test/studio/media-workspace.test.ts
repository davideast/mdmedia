import {expect,it} from 'bun:test';
import {WorkspaceStore} from '../../studio/src/lib/workspace';
import {createSceneDraft} from '../../studio/src/lib/scene-direction';
import {parseVideoExport} from '../../studio/src/lib/video-export';
import {readAudioPlacements} from '../../studio/src/lib/audio-placement';
const audio={id:'placement',narrationId:'saved-take',title:'Voiceover',startSeconds:1,inSeconds:.5,outSeconds:2,volume:.7,muted:false};
it('preserves projects and exact audio takes across refresh and narration draft completion',()=>{
 const values=new Map<string,string>();const storage={getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value);}};
 const first=new WorkspaceStore('media');first.restore(storage);const tab=first.visit('/studio?draft=narration')!;
 first.setProject({id:'p',name:'Launch',documents:{[tab.href]:'Opening'}});first.setSceneDraft('video',{title:'Launch film',draft:createSceneDraft(),audioPlacements:[audio]});first.replaceTab(tab.id,'/narration/saved-take','Opening take');first.flush();
 const next=new WorkspaceStore('media');next.restore(storage);expect(next.getSnapshot().projects?.p.documents).toEqual({'/narration/saved-take':'Opening take'});expect(next.getSnapshot().sceneDrafts.video.audioPlacements).toEqual([audio]);expect(next.getSnapshot().sceneDrafts.video.title).toBe('Launch film');first.dispose();next.dispose();
});
it('validates audio placement timing, source ids and gain before export',()=>{
 const request={id:`v_${'a'.repeat(32)}`,frame:'16:9',clips:[{videoId:`v_${'b'.repeat(32)}`,inSeconds:0,outSeconds:3,muted:false}],audio:[audio]};
 expect(parseVideoExport(request).audio).toEqual([audio]);
 expect(()=>parseVideoExport({...request,audio:[{...audio,startSeconds:4}]})).toThrow('before the end');
 for(const patch of [{narrationId:'../secret'},{volume:2},{outSeconds:0},{startSeconds:-1}])expect(readAudioPlacements([{...audio,...patch}])).toEqual([]);
});
