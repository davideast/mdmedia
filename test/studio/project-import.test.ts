import {describe,expect,it} from 'bun:test';
import {readProjectImport,projectDrafts} from '../../studio/src/lib/studio-project';
import {StudioProjectsClient} from '../../src/projects';
const manifest=()=>({version:1,id:'soap',title:'The secret',productionNotes:'Same dogs and estate throughout.',reviewNotes:['Review voices.'],parts:[{id:'opening',continuity:'planned',script:{title:'Opening',sourceTranscript:'',sourceDescription:'',shots:[{id:'a',title:'Discovery',seconds:10,source:'generated',connection:'cut',visual:'Heidi discovers fur.',dialogue:'Heidi: You are alive.',audio:'Piano sting.'},{id:'b',title:'Reaction',seconds:5,source:'generated',connection:'continue',visual:'Heidi turns toward the door.',dialogue:'',audio:'Footsteps.'}]}}]});
describe('agent project imports',()=>{
 it('builds a stable timeline without creating or reusing media jobs',()=>{
   const raw={...manifest(),ownerUid:'attacker',videoId:'v_bad'};
   const clean=readProjectImport(raw),drafts=projectDrafts(clean);
   expect('ownerUid' in clean).toBe(false);
   expect(drafts[0]?.id).toBe('soap__opening');
   expect(drafts[0]?.record.draft.beats.map(b=>[b.start,b.end])).toEqual([[0,10],[10,15]]);
   expect(Object.values(drafts[0]!.record.beatClips!).map(c=>c.generationMode)).toEqual(['new','continue']);
   expect(Object.values(drafts[0]!.record.beatClips!).every(c=>!c.videoId&&!c.pendingVideoId)).toBe(true);
   expect(drafts[0]?.record.videoBrief?.script?.shots[0]?.dialogue).toBe('Heidi: You are alive.');
   expect(projectDrafts(clean)).toEqual(drafts);
 });
 it('rejects duplicate parts and invalid scripts rather than importing a partial plan',()=>{
   const raw=manifest();raw.parts.push(raw.parts[0]!);
   expect(()=>readProjectImport(raw)).toThrow('unique');
   const invalid=manifest();invalid.parts[0]!.script.shots[1]!.seconds=41;
   expect(()=>readProjectImport(invalid)).toThrow('Invalid script');
 });
 it('rejects impossible connected chains before storing the project',()=>{
   const raw=manifest();raw.parts[0]!.continuity='continuous';raw.parts[0]!.script.shots.forEach(s=>s.seconds=30);
   expect(()=>projectDrafts(readProjectImport(raw))).toThrow('40s');
 });
 it('uses authenticated API operations and surfaces conflicts',async()=>{
   const requests:{url:string;init?:RequestInit}[]=[];
   const transport:typeof fetch=Object.assign(async(input:string|URL|Request,init?:RequestInit)=>{
     requests.push({url:String(input),init});
     return Response.json({message:'Project already exists.'},{status:409});
   },{preconnect:()=>{}});
   const client=new StudioProjectsClient('http://127.0.0.1:3101','test-token',transport);
   await expect(client.importProject(readProjectImport(manifest()))).rejects.toThrow('already exists');
   expect(requests[0]?.url).toBe('http://127.0.0.1:3101/api/studio-projects');
   expect(requests[0]?.init?.redirect).toBe('error');
   expect(requests[0]?.init?.headers).toMatchObject({Authorization:'Bearer test-token'});
 });
 it('refuses to send credentials to insecure remote origins',()=>{
   expect(()=>new StudioProjectsClient('http://example.com','token')).toThrow('HTTPS');
 });
});
