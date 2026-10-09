/** Agent-driven production through Studio's authenticated API.
 * bun scripts/studio-build.ts <studio-origin> <project-id> <part-id> <token-file> <checkpoint-file>
 * Re-running resumes saved request IDs; never silently starts fresh paid takes.
 */
import {readFile,writeFile,rename,mkdir,access} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {directionForBeat,resolveSceneTracks} from '../studio/src/lib/scene-tracks';
import type {SceneDraftRecord,VideoJob} from '../studio/src/lib/video-generation';
const [origin,projectId,partId,tokenPath,checkpoint,bindingsPath]=process.argv.slice(2);
const bindings: {firstFrames?:Record<string,string>;stopAfterBeat?:string;referenceFrom?:Record<string,string[]>;concurrency?:number;references?:string[];files?:Record<string,string>;shotReferences?:Record<string,string[]>;captions?:{text:string;start:number;end:number}[]}=bindingsPath?JSON.parse(await readFile(bindingsPath,'utf8')):{};
const url=new URL(origin);
if(url.protocol!=='https:'&&!(url.protocol==='http:'&&['localhost','127.0.0.1'].includes(url.hostname)))throw Error('Use HTTPS or localhost');
if(!checkpoint||url.pathname!=='/'||url.username||url.password)throw Error('Supply origin, project, part, token file and checkpoint file.');
// Read on each request so the agent can refresh authentication during a long production.

async function request(path:string,init:RequestInit={}) {
 const headers=new Headers(init.headers);headers.set('Authorization',`Bearer ${(await readFile(tokenPath,'utf8')).trim()}`);
 const response=await fetch(new URL(path,url),{...init,headers,redirect:'error',signal:AbortSignal.timeout(30000)});
 if(response.status===404&&(!init.method||init.method==='GET')&&/^\/api\/videos\/v_[a-f0-9]{32}$/.test(path))return {job:null};
 const data=await response.json();if(!response.ok)throw Error(data.message??`HTTP ${response.status}`);return data;
}
const put=(path:string,body:unknown,method='POST')=>request(path,{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
const project=await request(`/api/studio-projects/${encodeURIComponent(projectId)}`);
const draftId=`${projectId}__${partId}`;
let record:SceneDraftRecord=project.drafts.find((d:{id:string})=>d.id===draftId)?.record;
if(!record)throw Error('Part not found');
let jobs:Record<string,VideoJob>={};
let retries:Record<string,number>={};
try{
 const saved=JSON.parse(await readFile(checkpoint,'utf8'));
 if(saved.origin!==url.origin||saved.draftId!==draftId)throw Error('Checkpoint belongs to a different build');
 record=saved.record;jobs=saved.jobs;retries=saved.retries??{};
}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
if(bindings.references?.length)record.draft.mode='references';
let saving=Promise.resolve();
function save(){
 const snapshot=JSON.parse(JSON.stringify({origin:url.origin,draftId,record,jobs,retries}));
 saving=saving.then(async()=>{
  await writeFile(checkpoint+'.tmp',JSON.stringify(snapshot,null,2),{mode:0o600});
  await rename(checkpoint+'.tmp',checkpoint);
  await put(`/api/video-plans/${draftId}`,snapshot.record,'PUT');
 });
 return saving;
}

async function wait(id:string){
 const deadline=Date.now()+12*60*1000;let last='';
 while(Date.now()<deadline){
  const {job}=await request(`/api/videos/${id}`);if(!job)throw Error('Saved request is not on the server; rerun the build to submit the same ID.');jobs[id]=job;
  const message=`${job.status}: ${job.message||id}`;if(message!==last){console.log(message);last=message;}
  if(job.status==='ready'){await save();return job as VideoJob;}
  if(job.status==='error'||job.status==='partial'){await save();throw Error(job.message||'Shot needs retry; saved clips are preserved');}
  await new Promise(r=>setTimeout(r,4000));
 }
 throw Error('Build timed out. Request IDs are saved; rerun to check them.');
}
async function referenceFrames(beatId:string){
 const paths:string[]=[];
 for(const sourceBeatId of bindings.referenceFrom?.[beatId]??[]){
  const deadline=Date.now()+12*60*1000;
  while(!record.beatClips?.[sourceBeatId]?.videoId){
   if(Date.now()>deadline||failures.length)throw Error(`Reference scene ${sourceBeatId} is unavailable`);
   await new Promise(r=>setTimeout(r,3000));
  }
  const id=record.beatClips![sourceBeatId].videoId!;
  if(jobs[id]?.status!=='ready')await wait(id);
  const folder=path.join(path.dirname(checkpoint),'mdmedia-scene-reference-frames');await mkdir(folder,{recursive:true});
  const image=path.join(folder,id+'.jpg');
  try{await access(image);}catch{
   const response=await fetch(new URL(`/api/videos/${id}/media`,url),{headers:{Authorization:`Bearer ${(await readFile(tokenPath,'utf8')).trim()}`},redirect:'error',signal:AbortSignal.timeout(90000)});
   if(!response.ok)throw Error(`Could not download reference scene (${response.status})`);
   const video=path.join(folder,id+'.mp4');await writeFile(video,new Uint8Array(await response.arrayBuffer()));
   await promisify(execFile)(path.resolve('studio/node_modules/ffmpeg-static/ffmpeg'),['-hide_banner','-loglevel','error','-sseof','-0.4','-i',video,'-frames:v','1','-y',image]);
  }
  paths.push(image);
 }
 return paths;
}
async function buildBeat(index:number){
 const beat=record.draft.beats[index],clip=record.beatClips![beat.id];
 if(clip.excluded)return;
 const rendered=bindings.files?.[beat.id];
 if(rendered&&clip.placement){clip.placement.source='screencast';const shot=record.builtScript?.shots.find(shot=>`script_${shot.id}`===beat.id);if(shot)shot.source='screencast';}
 if(clip.placement?.source!=='generated'&&!rendered)throw Error(`Recording required for ${beat.id}`);
 console.log(`Shot ${index+1}/${record.draft.beats.length}: ${clip.placement?.title??beat.id}`);
 if(clip.videoId&&(await request(`/api/videos/${clip.videoId}`)).job){await wait(clip.videoId);return;}
 const id=clip.videoId??`v_${crypto.randomUUID().replaceAll('-','')}`;
 const direction=directionForBeat(record.draft,beat);
 clip.videoId=id;await save();
 if(rendered){
  const form=new FormData();form.set('video',new File([await readFile(rendered)],rendered.split('/').at(-1)!,{type:'video/mp4'}));
  const {source}=await request('/api/video-sources',{method:'POST',body:form});
  await put('/api/videos/import',{id,sourceId:source.id,frame:record.draft.frame});
 }else if(clip.generationMode==='continue'){
  const rows=resolveSceneTracks(record.draft,record.beatClips!,jobs);
  const row=rows.find(r=>r.beat.id===beat.id)!;
  const previous=rows.find(r=>r.beat.id===row.previousBeatId);
  if(!previous?.clip?.videoId||row.continuationIssue)throw Error(row.continuationIssue||'Missing predecessor');
  const form=new FormData();form.set('id',id);form.set('draft',JSON.stringify(direction));
  form.set('sourceVideoId',previous.clip.videoId);form.set('sourceEndSeconds',String(previous.trim.end));
  const references=bindings.shotReferences?.[beat.id]??bindings.references??[];
  for(const path of references)form.append('reference',new File([await readFile(path)],path.split('/').at(-1)!,{type:path.endsWith('.png')?'image/png':'image/jpeg'}));
  if(references.length)await request('/api/videos/continue',{method:'POST',body:form});
  else await put('/api/videos/continue',{id,draft:direction,sourceVideoId:previous.clip.videoId,sourceEndSeconds:previous.trim.end});
 }else{
  const form=new FormData();form.set('id',id);form.set('draft',JSON.stringify(direction));form.set('scope','beat');
  const firstFrame=bindings.firstFrames?.[beat.id];
  if(firstFrame)form.set('firstFrame',new File([await readFile(firstFrame)],firstFrame.split('/').at(-1)!,{type:firstFrame.endsWith('.png')?'image/png':'image/jpeg'}));
  const references=[...(bindings.shotReferences?.[beat.id]??bindings.references??[]),...await referenceFrames(beat.id)];
  for(const path of references)form.append('reference',new File([await readFile(path)],path.split('/').at(-1)!,{type:path.endsWith('.png')?'image/png':'image/jpeg'}));
  await request('/api/videos',{method:'POST',body:form});
 }
 await wait(id);
}
async function produce(index:number){
 const beatId=record.draft.beats[index].id;
 for(;;){
  try{await buildBeat(index);return;}catch(error){
   const clip=record.beatClips![beatId],failed=clip.videoId?jobs[clip.videoId]:undefined;
   if(!failed||!['error','partial'].includes(failed.status)||(retries[beatId]??0)>=2||/blocked|policy|could not generate this scene/i.test(failed.message??''))throw error;
   retries[beatId]=(retries[beatId]??0)+1;
   delete clip.videoId;await save();
   console.log(`Retrying ${beatId}, attempt ${retries[beatId]+1}; completed takes are retained.`);
  }
 }
}
const stopIndex=bindings.stopAfterBeat?record.draft.beats.findIndex(beat=>beat.id===bindings.stopAfterBeat):record.draft.beats.length-1;
if(stopIndex<0)throw Error('Unknown stopAfterBeat');
// Only independent camera setups run together. Each continuation chain stays serial.
const groups:number[][]=[];
for(let index=0;index<=stopIndex;index++){
 const clip=record.beatClips![record.draft.beats[index].id];
 if(clip.generationMode==='continue'&&groups.length)groups.at(-1)!.push(index);else groups.push([index]);
}
let nextGroup=0;const failures:unknown[]=[];
await Promise.all(Array.from({length:Math.max(1,Math.min(2,bindings.concurrency??1))},async()=>{
 while(nextGroup<groups.length){
  const group=groups[nextGroup++];
  try{for(const index of group)await produce(index);}catch(error){failures.push(error);console.error(error instanceof Error?error.message:error);}
 }
}));
if(failures.length)throw new Error(`${failures.length} scene setup(s) need retry. Completed footage is saved.`);
if(bindings.stopAfterBeat){console.log(`Saved through ${bindings.stopAfterBeat} for local review; later shots and export not submitted.`);process.exit(0);}
const rows=resolveSceneTracks(record.draft,record.beatClips!,jobs).filter(row=>row.included);
if(rows.some(row=>!row.matches||row.job?.status!=='ready'))throw Error('A shot needs review before assembly');
if(!record.exportId||!(await request(`/api/videos/${record.exportId}`)).job){
 record.exportId??=`v_${crypto.randomUUID().replaceAll('-','')}`;await save();
 await put('/api/videos/export',{id:record.exportId,frame:record.draft.frame,captions:bindings.captions,clips:rows.map(row=>({videoId:row.sourceVideoId,inSeconds:row.trim.start,outSeconds:row.trim.end,muted:!!row.clip?.muted,transition:row.transition,transitionSeconds:row.transitionSeconds}))});
}
await wait(record.exportId);
console.log(`Video ready: ${url.origin}/studio/scene?draft=${draftId}&project=${projectId}`);
